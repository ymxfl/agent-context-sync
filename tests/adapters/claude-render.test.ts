import { describe, expect, it } from 'vitest';
import { renderClaude } from '../../src/adapters/claude/render.js';
import { claudeRenderInput } from '../helpers/render-input.js';
import { decode, goldenFiles } from '../helpers/golden.js';

describe('renderClaude', () => {
  it('matches frozen Claude golden fixtures', async () => {
    expect(renderClaude(claudeRenderInput())).toEqual(await goldenFiles('claude'));
  });

  it('does not import AGENTS.md from CLAUDE.md', () => {
    const rendered = renderClaude(claudeRenderInput());
    expect(decode(rendered[0]!.bytes)).not.toContain('@AGENTS.md');
  });

  it('emits path-scoped rules under .claude/rules/', () => {
    const rendered = renderClaude(claudeRenderInput());
    expect(rendered.some((file) => file.relativePath.startsWith('.claude/rules/'))).toBe(true);
    expect(rendered[0]!.relativePath).toBe('CLAUDE.md');
  });

  it('never embeds absolute source locators', () => {
    const input = claudeRenderInput();
    const withAbsolute = {
      ...input,
      compiled: {
        ...input.compiled,
        sections: input.compiled.sections.map((section) => ({
          ...section,
          entries: section.entries.map((item) => ({
            ...item,
            source: {
              ...item.source,
              locator: '/Users/local/secret/CLAUDE.md',
            },
          })),
        })),
      },
    };
    for (const file of renderClaude(withAbsolute)) {
      expect(decode(file.bytes)).not.toContain('/Users/local/secret');
    }
  });
});
