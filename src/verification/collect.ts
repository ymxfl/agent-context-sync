import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { compareCodeUnits } from '../domain/compare.js';
import { createId } from '../domain/ids.js';
import type { KnowledgeEntry } from '../domain/model.js';
import { ContentCache } from '../performance/cache.js';
import { redactCandidate } from '../security/redact.js';
import { parsePackageDependencies, type DependencyRecord } from './dependencies.js';
import { collectGitEvidence, type GitCommitRecord } from './git-evidence.js';
import { runGit } from '../git/run-git.js';
import { serializeKnowledge } from '../knowledge/markdown.js';

const execFileAsync = promisify(execFile);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
  'use', 'using', 'used', 'into', 'onto', 'over', 'under', 'when', 'then',
  'than', 'also', 'only', 'have', 'has', 'had', 'will', 'can', 'should',
  'must', 'not', 'but', 'our', 'their', 'they', 'them', 'its', 'via',
  'layer', 'client', 'imports', 'depends', 'prefer', 'because',
]);

const CONFIG_BASENAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'eslint.config.js',
  'eslint.config.mjs',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  'prettier.config.js',
  'prisma.schema',
  'schema.prisma',
]);

export interface EvidenceLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxCommits: number;
  readonly timeoutMs: number;
}

export interface EvidenceInput {
  readonly entry: KnowledgeEntry;
  readonly repositoryPath: string;
  readonly repoId: string;
  readonly limits: EvidenceLimits;
  /** Optional absolute path to rg for tests or non-PATH installs. */
  readonly rgPath?: string;
  /** Optional content cache for evidence packets keyed by knowledge hash + HEAD. */
  readonly cache?: ContentCache;
}

export interface SearchHit {
  readonly term: string;
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface CollectedFileEvidence {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly content_hash: string;
  readonly bytes: number;
}

export interface CollectedConfigEvidence {
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly content: string;
  readonly content_hash: string;
  readonly bytes: number;
}

export interface VerificationPacket {
  readonly schema_version: 1;
  readonly packet_id: string;
  readonly repo_id: string;
  readonly knowledge: KnowledgeEntry;
  readonly searches: readonly SearchHit[];
  readonly files: readonly CollectedFileEvidence[];
  readonly dependencies: readonly DependencyRecord[];
  readonly configs: readonly CollectedConfigEvidence[];
  readonly commits: readonly GitCommitRecord[];
  readonly limits: EvidenceLimits;
  readonly packet_hash: string;
  readonly total_bytes: number;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  return candidate.killed === true
    || candidate.signal === 'SIGTERM'
    || candidate.code === 'ETIMEDOUT';
}

function resolveRgPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (process.env.ACS_RG_PATH !== undefined && process.env.ACS_RG_PATH.length > 0) {
    return process.env.ACS_RG_PATH;
  }
  return 'rg';
}

function tokenize(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

/**
 * Derives conservative fixed-string search terms from statement, reason, and applies_to paths.
 */
export function deriveSearchTerms(entry: KnowledgeEntry): string[] {
  const terms = new Set<string>();

  for (const token of [...tokenize(entry.statement), ...tokenize(entry.reason)]) {
    const normalized = token.replace(/^\/+|\/+$/g, '');
    if (normalized.length < 3) continue;
    if (STOP_WORDS.has(normalized.toLowerCase())) continue;
    if (/^\d+$/.test(normalized)) continue;
    terms.add(normalized);
  }

  for (const glob of entry.applies_to.paths) {
    for (const segment of glob.split('/')) {
      if (segment.length < 2) continue;
      if (segment.includes('*') || segment.includes('?') || segment === '.' || segment === '..') continue;
      terms.add(segment);
    }
  }

  return [...terms]
    .sort((left, right) => right.length - left.length || compareCodeUnits(left, right))
    .slice(0, 12);
}

function isConfigPath(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  if (CONFIG_BASENAMES.has(base)) return true;
  if (base.endsWith('.config.ts') || base.endsWith('.config.js') || base.endsWith('.config.mjs')) {
    return true;
  }
  if (base === 'config.ts' || base === 'config.js' || relativePath.includes('/config/')) {
    return true;
  }
  return false;
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / Math.max(sample.length, 1) < 0.1;
}

async function ensureInsideRoot(rootReal: string, relativePosix: string): Promise<string | undefined> {
  if (
    relativePosix.length === 0
    || relativePosix.startsWith('/')
    || relativePosix.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    return undefined;
  }

  const candidate = path.resolve(rootReal, ...relativePosix.split('/'));
  let realFile: string;
  try {
    realFile = await fs.realpath(candidate);
  } catch {
    return undefined;
  }

  const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (realFile !== rootReal && !realFile.startsWith(prefix)) return undefined;
  return realFile;
}

async function isIgnored(cwd: string, relativePath: string, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', relativePath], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return true;
  } catch (error) {
    if (isTimeoutError(error)) return false;
    const code = (error as { code?: number | string }).code;
    // git check-ignore exits 1 when the path is not ignored.
    if (code === 1) return false;
    return false;
  }
}

interface RgOutcome {
  readonly hits: SearchHit[];
  readonly timedOut: boolean;
}

async function runRipgrep(
  rgPath: string,
  cwd: string,
  terms: readonly string[],
  timeoutMs: number,
  localRoots: readonly string[],
): Promise<RgOutcome> {
  if (terms.length === 0 || timeoutMs <= 0) {
    return { hits: [], timedOut: timeoutMs <= 0 };
  }

  const args = [
    '-F',
    '-n',
    '--no-heading',
    '--color',
    'never',
    '--hidden',
    '--glob',
    '!.git/**',
  ];
  for (const term of terms) {
    args.push('-e', term);
  }
  args.push('.');

  try {
    const { stdout } = await execFileAsync(rgPath, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { hits: parseRgStdout(String(stdout), terms, localRoots), timedOut: false };
  } catch (error) {
    if (isTimeoutError(error)) return { hits: [], timedOut: true };
    const err = error as { stdout?: string; code?: number | string };
    // rg exits 1 when there are no matches.
    if (err.code === 1 && typeof err.stdout === 'string') {
      return { hits: parseRgStdout(err.stdout, terms, localRoots), timedOut: false };
    }
    if (typeof err.stdout === 'string' && err.stdout.length > 0) {
      return { hits: parseRgStdout(err.stdout, terms, localRoots), timedOut: false };
    }
    return { hits: [], timedOut: false };
  }
}

function parseRgStdout(
  stdout: string,
  terms: readonly string[],
  localRoots: readonly string[],
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (match === null) continue;
    let relative = (match[1] ?? '').replace(/\\/g, '/');
    while (relative.startsWith('./')) relative = relative.slice(2);
    const lineNumber = Number(match[2]);
    const text = match[3] ?? '';
    if (relative.length === 0 || !Number.isFinite(lineNumber) || lineNumber < 1) continue;
    if (relative.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
      continue;
    }

    const term = terms.find((candidate) => text.includes(candidate)) ?? terms[0] ?? '';
    const redacted = redactCandidate(text, [...localRoots]).redacted;
    hits.push({
      term,
      path: relative,
      line: lineNumber,
      text: redacted,
    });
    if (hits.length >= 200) break;
  }
  return hits;
}

async function readBoundedFile(
  rootReal: string,
  relativePosix: string,
  localRoots: readonly string[],
  remainingBytes: number,
): Promise<{ file: CollectedFileEvidence; clipped: boolean } | undefined> {
  if (remainingBytes <= 0) return undefined;
  const absolute = await ensureInsideRoot(rootReal, relativePosix);
  if (absolute === undefined) return undefined;

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolute);
  } catch {
    return undefined;
  }
  if (!looksLikeText(buffer)) return undefined;

  const maxRead = Math.min(buffer.length, remainingBytes, 64 * 1024);
  const clipped = buffer.subarray(0, maxRead);
  const raw = clipped.toString('utf8');
  const redacted = redactCandidate(raw, [...localRoots]).redacted;
  const lines = redacted.split('\n');
  const bytes = Buffer.byteLength(redacted, 'utf8');
  // Keep the stored excerpt inside the remaining budget even if redaction expands slightly.
  const content = bytes <= remainingBytes
    ? redacted
    : Buffer.from(redacted, 'utf8').subarray(0, remainingBytes).toString('utf8');
  return {
    file: {
      path: relativePosix,
      start_line: 1,
      end_line: Math.max(1, lines.length),
      content,
      content_hash: digest(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    },
    clipped: buffer.length > maxRead || bytes > remainingBytes,
  };
}

/**
 * Collects bounded code, dependency, config, and git evidence for one knowledge entry.
 * Timeouts and truncations are reported on the packet; they are not thrown as bare Errors.
 */
export async function collectEvidence(input: EvidenceInput): Promise<VerificationPacket> {
  let repositoryHead: string | undefined;
  if (input.cache !== undefined) {
    try {
      const { stdout } = await runGit(input.repositoryPath, ['rev-parse', 'HEAD']);
      repositoryHead = stdout.trim();
      const knowledgeHash = digest(serializeKnowledge(input.entry));
      const key = ContentCache.evidenceKey(knowledgeHash, repositoryHead);
      await input.cache.invalidateByHead(input.repoId, repositoryHead);
      const cached = await input.cache.get<VerificationPacket>(key);
      if (cached !== undefined) return cached;
    } catch {
      // Cache misses and HEAD lookup failures fall through to live collection.
      repositoryHead = undefined;
    }
  }

  const packet = await collectEvidenceUncached(input);

  if (input.cache !== undefined && repositoryHead !== undefined) {
    const knowledgeHash = digest(serializeKnowledge(input.entry));
    const key = ContentCache.evidenceKey(knowledgeHash, repositoryHead);
    await input.cache.put(key, packet, {
      repositoryId: input.repoId,
      head: repositoryHead,
      kind: 'evidence',
    });
  }

  return packet;
}

async function collectEvidenceUncached(input: EvidenceInput): Promise<VerificationPacket> {
  const started = Date.now();
  const limits = input.limits;
  let timedOut = false;
  let truncated = false;
  let totalBytes = 0;

  const rootReal = await fs.realpath(input.repositoryPath);
  const localRoots = [rootReal, input.repositoryPath];
  const remaining = (): number => Math.max(0, limits.timeoutMs - (Date.now() - started));

  const terms = deriveSearchTerms(input.entry);
  const rgPath = resolveRgPath(input.rgPath);
  const rgOutcome = await runRipgrep(rgPath, rootReal, terms, remaining(), localRoots);
  timedOut = timedOut || rgOutcome.timedOut;

  const candidatePaths = new Set<string>(['package.json']);
  for (const hit of rgOutcome.hits) candidatePaths.add(hit.path);
  for (const glob of input.entry.applies_to.paths) {
    // Non-glob applies_to paths are included when they resolve to real files.
    if (!glob.includes('*') && !glob.includes('?')) candidatePaths.add(glob);
  }

  const files: CollectedFileEvidence[] = [];
  const configs: CollectedConfigEvidence[] = [];
  const includedPaths: string[] = [];

  const orderedPaths = [...candidatePaths].sort(compareCodeUnits);
  for (const relativePath of orderedPaths) {
    if (remaining() <= 0) {
      timedOut = true;
      break;
    }
    if (files.length + configs.length >= limits.maxFiles) {
      truncated = true;
      break;
    }
    if (totalBytes >= limits.maxBytes) {
      truncated = true;
      break;
    }

    if (await isIgnored(rootReal, relativePath, remaining())) continue;

    const budget = limits.maxBytes - totalBytes;
    const collected = await readBoundedFile(rootReal, relativePath, localRoots, budget);
    if (collected === undefined) continue;

    if (collected.clipped) truncated = true;

    if (totalBytes + collected.file.bytes > limits.maxBytes) {
      truncated = true;
      break;
    }

    if (isConfigPath(relativePath)) configs.push(collected.file);
    else files.push(collected.file);
    totalBytes += collected.file.bytes;
    includedPaths.push(relativePath);

    if (totalBytes >= limits.maxBytes) {
      truncated = true;
      break;
    }
  }

  let dependencies: DependencyRecord[] = [];
  if (!timedOut || files.some((file) => file.path === 'package.json')) {
    dependencies = await parsePackageDependencies(rootReal, 'package.json');
  }

  const git = await collectGitEvidence({
    cwd: rootReal,
    maxCommits: limits.maxCommits,
    timeoutMs: remaining(),
    paths: includedPaths.slice(0, 10),
  });
  timedOut = timedOut || git.timedOut;

  const packetId = createId('packet');
  const body = {
    schema_version: 1 as const,
    packet_id: packetId,
    repo_id: input.repoId,
    knowledge: input.entry,
    searches: rgOutcome.hits,
    files,
    dependencies,
    configs,
    commits: git.commits,
    limits,
    total_bytes: totalBytes,
    truncated,
    timed_out: timedOut,
  };

  return {
    ...body,
    packet_hash: digest(canonicalJson(body)),
  };
}
