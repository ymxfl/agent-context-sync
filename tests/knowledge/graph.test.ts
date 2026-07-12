import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { validateKnowledgeGraph } from '../../src/knowledge/graph.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'b'.repeat(64)}`;
const ids = [
  'kn_01J00000000000000000000000',
  'kn_01J00000000000000000000001',
  'kn_01J00000000000000000000002',
] as const;

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id,
    kind: 'rule',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: [], agents: [] },
    source: {
      agent: 'codex',
      source_type: 'project-instruction',
      locator: 'AGENTS.md',
      content_hash: hash,
      observed_at: now,
    },
    confidence: 1,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Use deterministic output.',
    reason: 'Reviews must be reproducible.',
    ...overrides,
  };
}

describe('validateKnowledgeGraph', () => {
  it('reports duplicate IDs across the whole graph', () => {
    expect(validateKnowledgeGraph([entry(ids[0]), entry(ids[0])])).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_ID', entry_id: ids[0] }),
    );
  });

  it('reports missing targets, self relations, and overlapping relation types', () => {
    const value = entry(ids[0], {
      supersedes: [ids[0], ids[1]],
      conflicts_with: [ids[0], ids[1], ids[2]],
    });
    const issues = validateKnowledgeGraph([value]);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SELF_RELATION', entry_id: ids[0] }),
      expect.objectContaining({ code: 'RELATION_OVERLAP', entry_id: ids[0], target_id: ids[1] }),
      expect.objectContaining({ code: 'MISSING_RELATION_TARGET', target_id: ids[1] }),
      expect.objectContaining({ code: 'MISSING_RELATION_TARGET', target_id: ids[2] }),
    ]));
  });

  it('reports every member of a supersedes cycle', () => {
    const issues = validateKnowledgeGraph([
      entry(ids[0], { supersedes: [ids[1]] }),
      entry(ids[1], { supersedes: [ids[0]] }),
    ]);

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'SUPERSEDES_CYCLE',
      entry_id: ids[0],
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'SUPERSEDES_CYCLE',
      entry_id: ids[1],
    }));
  });

  it('reports superseded entries whose replacement knowledge is missing', () => {
    expect(validateKnowledgeGraph([
      entry(ids[0], { status: 'superseded' }),
    ])).toContainEqual(expect.objectContaining({
      code: 'SUPERSEDED_WITHOUT_REPLACEMENT',
      entry_id: ids[0],
    }));
  });

  it('returns issues in deterministic code-unit order', () => {
    const input = [entry(ids[2], { supersedes: [ids[1]] }), entry(ids[0])];
    expect(validateKnowledgeGraph(input)).toEqual(validateKnowledgeGraph([...input].reverse()));
  });
});
