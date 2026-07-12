import { describe, expect, it } from 'vitest';
import { parseKnowledgeEntry } from '../../src/schema/knowledge.js';

const hash = `sha256:${'a'.repeat(64)}`;
const now = '2026-07-11T10:00:00Z';

const valid = {
  schema_version: 1,
  id: 'kn_01J00000000000000000000000',
  kind: 'database-failure-mode',
  scope: 'repository:github.com/acme/api',
  status: 'active',
  applies_to: { paths: ['src/db/**'], agents: ['claude-code', 'codex'] },
  source: {
    agent: 'claude-code',
    source_type: 'auto-memory',
    locator: 'memory/MEMORY.md',
    content_hash: hash,
    observed_at: now,
  },
  confidence: 0.9,
  supersedes: [],
  conflicts_with: [],
  created_at: now,
  updated_at: now,
  last_verified_at: null,
  statement: 'Use WAL only in a single writer process.',
  reason: 'Multiple writers produced SQLITE_BUSY.',
} as const;

describe('parseKnowledgeEntry', () => {
  it('accepts an open kebab-case kind and structured statement and reason fields', () => {
    expect(parseKnowledgeEntry(valid)).toMatchObject({
      kind: 'database-failure-mode',
      statement: valid.statement,
      reason: valid.reason,
    });
  });

  it.each(['Bad Kind', 'bad_kind', '-bad', 'bad-', 'bad--kind', '']) (
    'rejects malformed kind %j',
    (kind) => expect(() => parseKnowledgeEntry({ ...valid, kind })).toThrow(),
  );

  it.each(['active', 'superseded', 'archived', 'disputed']) (
    'accepts the strict status %s',
    (status) => expect(parseKnowledgeEntry({ ...valid, status }).status).toBe(status),
  );

  it('rejects unknown statuses and malformed scopes', () => {
    expect(() => parseKnowledgeEntry({ ...valid, status: 'draft' })).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, scope: 'global' })).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, scope: 'repository:https://github.com/acme/api' })).toThrow();
  });

  it('accepts workspace scope and open Agent names', () => {
    const entry = parseKnowledgeEntry({
      ...valid,
      scope: 'workspace',
      applies_to: { paths: [], agents: ['future-agent'] },
      source: { ...valid.source, agent: 'future-agent' },
    });
    expect(entry.applies_to.agents).toEqual(['future-agent']);
  });

  it('validates source hashes, relation IDs, confidence, and timestamps', () => {
    expect(() => parseKnowledgeEntry({
      ...valid,
      supersedes: ['not-a-knowledge-id'],
    })).toThrow();
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, content_hash: 'sha256:nope' },
    })).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, confidence: 1.1 })).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, updated_at: 'yesterday' })).toThrow();
  });

  it('rejects unknown fields throughout the structured contract', () => {
    expect(() => parseKnowledgeEntry({ ...valid, body: '# unstructured' })).toThrow(/unrecognized/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, absolute_path: '/private/memory' },
    })).toThrow(/unrecognized/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      applies_to: { ...valid.applies_to, repositories: ['api'] },
    })).toThrow(/unrecognized/i);
  });
});
