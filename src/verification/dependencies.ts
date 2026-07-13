import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DependencyRecord {
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly content_hash: string;
}

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function readDependencyMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof name === 'string' && name.length > 0 && typeof version === 'string' && version.length > 0) {
      entries[name] = version;
    }
  }
  return entries;
}

/**
 * Parses dependency declarations from a package.json-compatible manifest.
 * Supports dependencies, devDependencies, optionalDependencies, and peerDependencies.
 */
export async function parsePackageDependencies(
  repositoryPath: string,
  manifestPath = 'package.json',
): Promise<DependencyRecord[]> {
  const absolute = path.join(repositoryPath, manifestPath);
  let raw: string;
  try {
    raw = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const manifest = parsed as Record<string, unknown>;
  const content_hash = digest(raw);
  const combined = {
    ...readDependencyMap(manifest.peerDependencies),
    ...readDependencyMap(manifest.optionalDependencies),
    ...readDependencyMap(manifest.devDependencies),
    ...readDependencyMap(manifest.dependencies),
  };

  return Object.entries(combined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({
      name,
      version,
      manifest_path: manifestPath,
      content_hash,
    }));
}
