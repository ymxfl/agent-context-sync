import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentDigest, RenderedFile } from '../../src/adapters/adapter.js';

/**
 * Golden fixture layout:
 *   tests/fixtures/render-golden/{claude|codex}/manifest.json
 *   tests/fixtures/render-golden/{claude|codex}/<relativePath>
 *
 * Manifest entries list relativePath, sha256 (`sha256:<hex>` of file bytes),
 * and sourceKnowledgeIds. File bodies use LF endings and one final newline.
 */
export type GoldenAgent = 'claude' | 'codex';

interface GoldenManifestEntry {
  relativePath: string;
  sha256: ContentDigest;
  sourceKnowledgeIds: string[];
}

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/render-golden',
);

export function digestBytes(bytes: Uint8Array): ContentDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

export function encodeLf(text: string): Uint8Array {
  const normalized = text.replace(/\r\n?/g, '\n');
  const withNewline = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  return new Uint8Array(Buffer.from(withNewline, 'utf8'));
}

export async function goldenFiles(agent: GoldenAgent): Promise<RenderedFile[]> {
  const root = join(fixturesRoot, agent);
  const manifestRaw = await readFile(join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw) as GoldenManifestEntry[];
  const files: RenderedFile[] = [];
  for (const entry of manifest) {
    const bytes = new Uint8Array(await readFile(join(root, entry.relativePath)));
    files.push({
      relativePath: entry.relativePath,
      bytes,
      sha256: entry.sha256,
      sourceKnowledgeIds: entry.sourceKnowledgeIds,
    });
  }
  return files;
}

export function goldenRoot(agent: GoldenAgent): string {
  return join(fixturesRoot, agent);
}
