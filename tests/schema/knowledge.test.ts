import { describe, expect, it } from 'vitest';
import { parseKnowledgeEntry } from '../../src/schema/knowledge.js';

const hash = `sha256:${'a'.repeat(64)}`;
const now = '2026-07-11T10:00:00Z';
const context = { registeredRepositoryIds: new Set(['github.com/acme/api']) };
const otherKnowledgeId = 'kn_01J00000000000000000000001';
const thirdKnowledgeId = 'kn_01J00000000000000000000002';

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
    expect(parseKnowledgeEntry(valid, context)).toMatchObject({
      kind: 'database-failure-mode',
      statement: valid.statement,
      reason: valid.reason,
    });
  });

  it.each(['Bad Kind', 'bad_kind', '-bad', 'bad-', 'bad--kind', '']) (
    'rejects malformed kind %j',
    (kind) => expect(() => parseKnowledgeEntry({ ...valid, kind }, context)).toThrow(),
  );

  it.each(['active', 'superseded', 'archived', 'disputed']) (
    'accepts the strict status %s',
    (status) => expect(parseKnowledgeEntry({ ...valid, status }, context).status).toBe(status),
  );

  it('rejects unknown statuses and malformed scopes', () => {
    expect(() => parseKnowledgeEntry({ ...valid, status: 'draft' }, context)).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, scope: 'global' }, context)).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, scope: 'repository:https://github.com/acme/api' }, context)).toThrow();
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

  it('requires repository scope context and registration', () => {
    expect(() => parseKnowledgeEntry(valid)).toThrow(/repository scope.*context/i);
    expect(() => parseKnowledgeEntry(valid, {
      registeredRepositoryIds: new Set(['github.com/acme/other']),
    })).toThrow(/repository scope.*registered/i);
    expect(parseKnowledgeEntry(valid, context).scope).toBe(valid.scope);
  });

  it.each([
    '/Users/alice/.claude/memory.md',
    String.raw`C:\Users\alice\.claude\memory.md`,
    String.raw`\\server\share\memory.md`,
    'file:///Users/alice/.claude/memory.md',
    'FILE:///C:/Users/alice/memory.md',
    '',
    '   ',
    '.',
    '..',
    './memory.md',
    '../memory.md',
    'memory/../private.md',
    String.raw`memory\..\private.md`,
  ])('rejects local or traversal-shaped source locator %j', (locator) => {
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, locator },
    }, context)).toThrow(/locator/i);
  });

  it.each([
    'memory/MEMORY.md',
    'claude-auto-memory/MEMORY.md',
    'AGENTS.md',
  ])('preserves safe logical source locator %j', (locator) => {
    expect(parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, locator },
    }, context).source.locator).toBe(locator);
  });

  it('validates source hashes, relation IDs, confidence, and timestamps', () => {
    expect(() => parseKnowledgeEntry({
      ...valid,
      supersedes: ['not-a-knowledge-id'],
    }, context)).toThrow();
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, content_hash: 'sha256:nope' },
    }, context)).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, confidence: 1.1 }, context)).toThrow();
    expect(() => parseKnowledgeEntry({ ...valid, updated_at: 'yesterday' }, context)).toThrow();
  });

  it('requires unique, disjoint relations without self references', () => {
    expect(() => parseKnowledgeEntry({
      ...valid,
      supersedes: [otherKnowledgeId, otherKnowledgeId],
    }, context)).toThrow(/unique/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      supersedes: [valid.id],
    }, context)).toThrow(/self/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      supersedes: [otherKnowledgeId],
      conflicts_with: [otherKnowledgeId, thirdKnowledgeId],
    }, context)).toThrow(/overlap/i);
  });

  it('accepts equal timestamp boundaries', () => {
    expect(parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, observed_at: now },
      created_at: now,
      updated_at: now,
      last_verified_at: now,
    }, context).last_verified_at).toBe(now);
  });

  it('enforces source, creation, and verification chronology', () => {
    const earlier = '2026-07-11T09:00:00Z';
    const later = '2026-07-11T11:00:00Z';
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, observed_at: later },
    }, context)).toThrow(/observed_at.*updated_at/i);
    expect(() => parseKnowledgeEntry({ ...valid, created_at: later }, context))
      .toThrow(/created_at.*updated_at/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      created_at: now,
      updated_at: later,
      last_verified_at: earlier,
    }, context)).toThrow(/last_verified_at.*created_at/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      created_at: earlier,
      last_verified_at: later,
    }, context)).toThrow(/last_verified_at.*updated_at/i);
  });

  it('rejects unknown fields throughout the structured contract', () => {
    expect(() => parseKnowledgeEntry({ ...valid, body: '# unstructured' }, context)).toThrow(/unrecognized/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      source: { ...valid.source, absolute_path: '/private/memory' },
    }, context)).toThrow(/unrecognized/i);
    expect(() => parseKnowledgeEntry({
      ...valid,
      applies_to: { ...valid.applies_to, repositories: ['api'] },
    }, context)).toThrow(/unrecognized/i);
  });
});
