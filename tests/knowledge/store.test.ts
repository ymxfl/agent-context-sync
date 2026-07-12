import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import {
  parseKnowledgeMarkdown,
  serializeKnowledge,
} from '../../src/knowledge/markdown.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'a'.repeat(64)}`;
const ids = {
  a: 'kn_01J00000000000000000000000',
  b: 'kn_01J00000000000000000000001',
};

function entry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id: ids.a,
    kind: 'architecture-decision',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: ['src/z/**', 'src/a/**'], agents: ['codex', 'claude-code'] },
    source: {
      agent: 'claude-code',
      source_type: 'auto-memory',
      locator: 'claude-auto-memory/MEMORY.md',
      content_hash: hash,
      observed_at: now,
    },
    confidence: 0.92,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Use server-side sessions, not JWTs.',
    reason: 'The server must be able to revoke sessions.',
    ...overrides,
  };
}

describe('canonical Knowledge Markdown', () => {
  it('round trips deterministically with sorted arrays, LF endings, and one final newline', () => {
    const knowledge = entry();
    const first = serializeKnowledge(knowledge);
    const second = serializeKnowledge(knowledge);

    expect(first).toBe(second);
    expect(parseKnowledgeMarkdown(first)).toEqual({
      ...knowledge,
      applies_to: {
        paths: ['src/a/**', 'src/z/**'],
        agents: ['claude-code', 'codex'],
      },
    });
    expect(first).not.toContain('\r');
    expect(first).toMatch(/[^\n]\n$/);
    expect(first).not.toMatch(/\n\n$/);
    expect(first).not.toContain('/Users/alice');
  });

  it('rejects local absolute path leakage before serialization', () => {
    expect(() => serializeKnowledge(entry({
      source: { ...entry().source, locator: '/Users/alice/.claude/memory.md' },
    }))).toThrow(/locator/i);
  });
});

describe('KnowledgeStore', () => {
  let root: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-knowledge-'));
    store = new KnowledgeStore(root, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
  });

  it('uses the entry ID and scope to derive contained canonical paths', async () => {
    await store.put(entry());
    await store.put(entry({
      id: ids.b,
      scope: 'repository:github.com/acme/api',
    }));

    expect(await fs.readFile(
      path.join(root, 'knowledge/workspace', `${ids.a}.md`),
      'utf8',
    )).toBe(serializeKnowledge(entry()));
    expect(await fs.readFile(
      path.join(root, 'knowledge/repositories/github.com/acme/api', `${ids.b}.md`),
      'utf8',
    )).toBe(serializeKnowledge(entry({
      id: ids.b,
      scope: 'repository:github.com/acme/api',
    })));
  });

  it('keeps archived entries at the same path and never physically deletes them', async () => {
    const file = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    await store.put(entry());
    await store.put(entry({ status: 'archived' }));

    expect(parseKnowledgeMarkdown(await fs.readFile(file, 'utf8')).status).toBe('archived');
    expect(await store.get(ids.a)).toMatchObject({ status: 'archived' });
    expect((await store.list()).map((item) => item.id)).toEqual([ids.a]);
  });

  it('normalizes conflicts_with symmetrically across the whole store', async () => {
    await store.put(entry());
    await store.put(entry({ id: ids.b }));
    await store.put(entry({ conflicts_with: [ids.b] }));

    expect((await store.get(ids.a))?.conflicts_with).toEqual([ids.b]);
    expect((await store.get(ids.b))?.conflicts_with).toEqual([ids.a]);
  });

  it('rejects missing relation targets without changing stored bytes', async () => {
    await store.put(entry());
    const file = path.join(root, 'knowledge/workspace', `${ids.a}.md`);
    const before = await fs.readFile(file, 'utf8');

    await expect(store.put(entry({ supersedes: [ids.b] }))).rejects.toThrow(/missing/i);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('detects duplicate IDs anywhere in the store', async () => {
    await store.put(entry());
    const duplicate = path.join(root, 'knowledge/repositories/github.com/acme/api', `${ids.a}.md`);
    await fs.mkdir(path.dirname(duplicate), { recursive: true });
    await fs.writeFile(duplicate, serializeKnowledge(entry({
      scope: 'repository:github.com/acme/api',
    })));

    await expect(store.list()).rejects.toThrow(/duplicate/i);
    await expect(store.get(ids.a)).rejects.toThrow(/duplicate/i);
  });
});
