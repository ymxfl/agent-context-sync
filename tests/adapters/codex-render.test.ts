import { describe, expect, it } from 'vitest';
import { renderCodex } from '../../src/adapters/codex/render.js';
import { codexRenderInput } from '../helpers/render-input.js';
import { decode, encodeLf, goldenFiles } from '../helpers/golden.js';

describe('renderCodex', () => {
  it('matches frozen Codex golden fixtures', async () => {
    expect(renderCodex(codexRenderInput())).toEqual(await goldenFiles('codex'));
  });

  it('keeps the root AGENTS.md within the configured byte budget', () => {
    const rendered = renderCodex(codexRenderInput(32768));
    expect(rendered[0]!.relativePath).toBe('AGENTS.md');
    expect(rendered[0]!.bytes.byteLength).toBeLessThanOrEqual(32768);
  });

  it('splits path-scoped content into nested AGENTS.md when root would exceed maxBytes', () => {
    const rendered = renderCodex(codexRenderInput(900));
    expect(rendered[0]!.relativePath).toBe('AGENTS.md');
    expect(rendered[0]!.bytes.byteLength).toBeLessThanOrEqual(900);
    expect(rendered.some((file) => file.relativePath !== 'AGENTS.md' && file.relativePath.endsWith('/AGENTS.md'))).toBe(true);
    expect(decode(rendered[0]!.bytes)).not.toContain('Keep session tokens server-side only.');
  });

  it('emits LF endings with a final newline', () => {
    for (const file of renderCodex(codexRenderInput())) {
      const text = decode(file.bytes);
      expect(text).not.toContain('\r');
      expect(text.endsWith('\n')).toBe(true);
      expect(file.bytes).toEqual(encodeLf(text));
    }
  });
});
