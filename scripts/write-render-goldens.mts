import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderClaude } from '../src/adapters/claude/render.js';
import { renderCodex } from '../src/adapters/codex/render.js';
import type { RenderedFile } from '../src/adapters/adapter.js';
import { claudeRenderInput, codexRenderInput } from '../tests/helpers/render-input.js';
import { goldenRoot } from '../tests/helpers/golden.js';

async function writeGolden(agent: 'claude' | 'codex', files: RenderedFile[]): Promise<void> {
  const root = goldenRoot(agent);
  await mkdir(root, { recursive: true });
  const manifest = [];
  for (const file of files) {
    const target = join(root, file.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    manifest.push({
      relativePath: file.relativePath,
      sha256: file.sha256,
      sourceKnowledgeIds: file.sourceKnowledgeIds,
    });
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(agent, files.map((file) => `${file.relativePath} (${file.bytes.byteLength} bytes)`));
}

await writeGolden('claude', renderClaude(claudeRenderInput()));
await writeGolden('codex', renderCodex(codexRenderInput()));
