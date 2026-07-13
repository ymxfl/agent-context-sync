import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '../domain/compare.js';
import { atomicWriteFile } from '../fs/atomic-write.js';

export type CacheKind = 'discovery' | 'evidence';

export interface CacheEntryMeta {
  readonly repositoryId: string;
  readonly head: string;
  readonly kind: CacheKind;
}

export interface ContentCacheOptions {
  readonly home: string;
  /** Maximum number of cache entry files. Defaults to 256. */
  readonly maxEntries?: number;
  /** Approximate maximum total payload bytes. Defaults to 32 MiB. */
  readonly maxBytes?: number;
}

export interface CacheIntegrityReport {
  readonly status: 'pass' | 'warn';
  readonly detail: string;
  readonly corruptPaths: readonly string[];
}

interface StoredCacheRecord {
  schema_version: 1;
  key: string;
  repository_id: string;
  head: string;
  kind: CacheKind;
  created_at: string;
  value: unknown;
  checksum: string;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function checksumFor(record: Omit<StoredCacheRecord, 'checksum'>): string {
  return `sha256:${digest(JSON.stringify({
    schema_version: record.schema_version,
    key: record.key,
    repository_id: record.repository_id,
    head: record.head,
    kind: record.kind,
    created_at: record.created_at,
    value: record.value,
  }))}`;
}

function isStoredRecord(value: unknown): value is StoredCacheRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StoredCacheRecord>;
  return record.schema_version === 1
    && typeof record.key === 'string'
    && typeof record.repository_id === 'string'
    && typeof record.head === 'string'
    && (record.kind === 'discovery' || record.kind === 'evidence')
    && typeof record.created_at === 'string'
    && typeof record.checksum === 'string'
    && 'value' in record;
}

/** Absolute cache directory under the ACS home. */
export function cacheDirectory(home: string): string {
  return path.resolve(home, 'cache');
}

function entryPath(home: string, key: string): string {
  return path.join(cacheDirectory(home), `${digest(key)}.json`);
}

/**
 * Hash-keyed local content cache for Adapter discovery reports and verification evidence.
 * Writes are atomic; size is bounded by entry count and approximate byte budget.
 */
export class ContentCache {
  readonly home: string;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(options: ContentCacheOptions) {
    this.home = path.resolve(options.home);
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /** Build a discovery cache key from Adapter/config/HEAD/path/mtime fingerprint parts. */
  static discoveryKey(parts: {
    adapterVersion: string;
    configHash: string;
    repositoryId: string;
    head: string;
    targetPath: string;
    mtimeFingerprint: string;
  }): string {
    return [
      'discovery',
      parts.adapterVersion,
      parts.configHash,
      parts.repositoryId,
      parts.head,
      parts.targetPath,
      parts.mtimeFingerprint,
    ].join('\0');
  }

  /** Build an evidence cache key from knowledge content hash and repository HEAD. */
  static evidenceKey(knowledgeHash: string, head: string): string {
    return ['evidence', knowledgeHash, head].join('\0');
  }

  async get<T>(key: string): Promise<T | undefined> {
    const file = entryPath(this.home, key);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    if (!isStoredRecord(parsed) || parsed.key !== key) return undefined;
    if (parsed.checksum !== checksumFor(parsed)) return undefined;
    return parsed.value as T;
  }

  async put(key: string, value: unknown, meta: CacheEntryMeta): Promise<void> {
    const directory = cacheDirectory(this.home);
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    const created_at = new Date().toISOString();
    const withoutChecksum: Omit<StoredCacheRecord, 'checksum'> = {
      schema_version: 1,
      key,
      repository_id: meta.repositoryId,
      head: meta.head,
      kind: meta.kind,
      created_at,
      value,
    };
    const record: StoredCacheRecord = {
      ...withoutChecksum,
      checksum: checksumFor(withoutChecksum),
    };
    await atomicWriteFile(entryPath(this.home, key), JSON.stringify(record));
    await this.enforceBounds();
  }

  /**
   * Drop cache entries for a repository whose recorded HEAD differs from the supplied HEAD.
   * Used when a repository advances so stale discovery/evidence cannot be reused.
   */
  async invalidateByHead(repositoryId: string, head: string): Promise<void> {
    const directory = cacheDirectory(this.home);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    await Promise.all(names.map(async (name) => {
      if (!name.endsWith('.json')) return;
      const file = path.join(directory, name);
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (!isStoredRecord(parsed)) return;
      if (parsed.repository_id === repositoryId && parsed.head !== head) {
        try {
          await fs.unlink(file);
        } catch {
          // Best-effort eviction.
        }
      }
    }));
  }

  private async enforceBounds(): Promise<void> {
    const directory = cacheDirectory(this.home);
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const files = (await Promise.all(names.map(async (name) => {
      if (!name.endsWith('.json')) return undefined;
      const file = path.join(directory, name);
      try {
        const [stat, raw] = await Promise.all([
          fs.stat(file),
          fs.readFile(file, 'utf8'),
        ]);
        let createdAt = stat.mtimeMs;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (isStoredRecord(parsed)) {
            const parsedTime = Date.parse(parsed.created_at);
            if (Number.isFinite(parsedTime)) createdAt = parsedTime;
          }
        } catch {
          // Keep mtime ordering for corrupt files.
        }
        return { file, size: Buffer.byteLength(raw, 'utf8'), createdAt };
      } catch {
        return undefined;
      }
    }))).filter((item): item is { file: string; size: number; createdAt: number } => item !== undefined);

    files.sort((left, right) => left.createdAt - right.createdAt || compareCodeUnits(left.file, right.file));

    let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
    while (
      files.length > this.maxEntries
      || (files.length > 0 && totalBytes > this.maxBytes)
    ) {
      const oldest = files.shift();
      if (oldest === undefined) break;
      totalBytes -= oldest.size;
      try {
        await fs.unlink(oldest.file);
      } catch {
        // Best-effort eviction.
      }
    }
  }
}

/**
 * Assess local cache integrity for doctor. Never deletes files; recommends manual removal.
 */
export async function assessCacheIntegrity(home: string): Promise<CacheIntegrityReport> {
  const directory = cacheDirectory(home);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        status: 'pass',
        detail: 'No local content cache directory is present.',
        corruptPaths: [],
      };
    }
    return {
      status: 'warn',
      detail: `The content cache directory could not be read. Remove ${directory} manually if corruption is suspected.`,
      corruptPaths: [],
    };
  }

  const corruptPaths: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      corruptPaths.push(file);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      corruptPaths.push(file);
      continue;
    }
    if (!isStoredRecord(parsed) || parsed.checksum !== checksumFor(parsed)) {
      corruptPaths.push(file);
    }
  }

  if (corruptPaths.length === 0) {
    return {
      status: 'pass',
      detail: 'Local content cache entries are readable and checksum-valid.',
      corruptPaths: [],
    };
  }

  return {
    status: 'warn',
    detail: `Detected ${corruptPaths.length} corrupt content cache entr${corruptPaths.length === 1 ? 'y' : 'ies'}. Remove ${directory} manually after review; doctor does not delete cache files.`,
    corruptPaths: corruptPaths.sort(compareCodeUnits),
  };
}

/** Fingerprint file existence/mtime/size without reading contents. */
export async function mtimeFingerprint(paths: readonly string[]): Promise<string> {
  const lines = await Promise.all([...paths].sort(compareCodeUnits).map(async (filePath) => {
    try {
      const stat = await fs.stat(filePath);
      return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${filePath}:missing`;
    }
  }));
  return digest(lines.join('\n'));
}

/** Hash file contents when present; missing files contribute a stable marker. */
export async function contentHashFingerprint(paths: readonly string[]): Promise<string> {
  const lines = await Promise.all([...paths].sort(compareCodeUnits).map(async (filePath) => {
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      return `${filePath}:${digest(contents)}`;
    } catch {
      return `${filePath}:missing`;
    }
  }));
  return digest(lines.join('\n'));
}
