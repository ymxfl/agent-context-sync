import { describe, expect, it } from 'vitest';

import type { KnowledgeEntry } from '../../src/domain/model.js';
import { threeWayKnowledgeMerge } from '../../src/merge/knowledge-merge.js';

const hash = `sha256:${'a'.repeat(64)}`;
const now = '2026-07-11T10:00:00Z';
const later = '2026-07-11T11:00:00Z';

const ids = {
  a: 'kn_01J0000000000000000000000A',
  b: 'kn_01J0000000000000000000000B',
  c: 'kn_01J0000000000000000000000C',
  z: 'kn_01J0000000000000000000000Z',
} as const;

function entry(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id,
    kind: 'architecture-decision',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: ['src/**'], agents: ['claude-code', 'codex'] },
    source: {
      agent: 'claude-code',
      source_type: 'project-instructions',
      locator: 'AGENTS.md',
      content_hash: hash,
      observed_at: now,
    },
    confidence: 0.9,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: `Statement for ${id}.`,
    reason: `Reason for ${id}.`,
    ...overrides,
  };
}

describe('threeWayKnowledgeMerge', () => {
  it('auto-merges different new knowledge IDs from each side', () => {
    const a = entry(ids.a, { statement: 'Local-only rule.' });
    const b = entry(ids.b, { statement: 'Remote-only rule.' });
    const base: KnowledgeEntry[] = [];
    const localAddsA = [a];
    const remoteAddsB = [b];

    expect(threeWayKnowledgeMerge(base, localAddsA, remoteAddsB)).toMatchObject({
      automatic: expect.arrayContaining([a.id, b.id]),
      conflicts: [],
    });
  });

  it('auto-merges byte-identical edits to the same entry', () => {
    const baseEntry = entry(ids.a, { statement: 'Original.' });
    const edited = entry(ids.a, {
      statement: 'Same edit on both sides.',
      updated_at: later,
    });

    const result = threeWayKnowledgeMerge([baseEntry], [edited], [edited]);
    expect(result.automatic).toContain(ids.a);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.find((item) => item.id === ids.a)?.statement)
      .toBe('Same edit on both sides.');
  });

  it('classifies divergent edits to the same entry as SAME_ENTRY_EDIT', () => {
    const baseEntry = entry(ids.a, { statement: 'Original.' });
    const localEditsA = [entry(ids.a, {
      statement: 'Local edit.',
      updated_at: later,
    })];
    const remoteEditsA = [entry(ids.a, {
      statement: 'Remote edit.',
      updated_at: later,
    })];

    expect(threeWayKnowledgeMerge([baseEntry], localEditsA, remoteEditsA).conflicts)
      .toContainEqual(expect.objectContaining({ knowledge_id: ids.a, type: 'SAME_ENTRY_EDIT' }));
  });

  it('classifies simultaneous status changes on the same entry', () => {
    const baseEntry = entry(ids.a, { status: 'active' });
    const local = [entry(ids.a, { status: 'archived', updated_at: later })];
    const remote = [entry(ids.a, { status: 'disputed', updated_at: later })];

    expect(threeWayKnowledgeMerge([baseEntry], local, remote).conflicts)
      .toContainEqual(expect.objectContaining({
        knowledge_id: ids.a,
        type: 'STATUS_CHANGE',
      }));
  });

  it('classifies competing supersedes relations on the same entry', () => {
    const target = entry(ids.z, { status: 'superseded', statement: 'Old rule.' });
    const baseEntry = entry(ids.a, { supersedes: [] });
    const local = [
      target,
      entry(ids.a, { supersedes: [ids.z], updated_at: later, statement: 'Local replacement.' }),
    ];
    const remote = [
      target,
      entry(ids.a, { supersedes: [ids.c], updated_at: later, statement: 'Remote replacement.' }),
      entry(ids.c, { status: 'superseded', statement: 'Other old rule.' }),
    ];
    const base = [target, baseEntry, entry(ids.c, { status: 'superseded', statement: 'Other old rule.' })];

    expect(threeWayKnowledgeMerge(base, local, remote).conflicts)
      .toContainEqual(expect.objectContaining({
        knowledge_id: ids.a,
        type: 'SUPERSEDES_CONFLICT',
      }));
  });

  it('classifies explicit conflicts_with divergence on the same entry', () => {
    const other = entry(ids.b);
    const baseEntry = entry(ids.a, { conflicts_with: [] });
    const local = [
      other,
      entry(ids.a, { conflicts_with: [ids.b], updated_at: later }),
    ];
    const remote = [
      other,
      entry(ids.a, {
        conflicts_with: [ids.c],
        updated_at: later,
        statement: 'Also edited remotely.',
      }),
      entry(ids.c),
    ];
    const base = [other, baseEntry, entry(ids.c)];

    expect(threeWayKnowledgeMerge(base, local, remote).conflicts)
      .toContainEqual(expect.objectContaining({
        knowledge_id: ids.a,
        type: 'CONFLICTS_WITH',
      }));
  });

  it('surfaces cross-ID semantic contradictions in conflicts instead of silent auto-merge', () => {
    const localOnly = entry(ids.a, {
      statement: 'Use Postgres for persistence.',
      applies_to: { paths: ['src/db/**'], agents: ['claude-code', 'codex'] },
    });
    const remoteOnly = entry(ids.b, {
      statement: 'Use SQLite for persistence.',
      applies_to: { paths: ['src/db/**'], agents: ['claude-code', 'codex'] },
      conflicts_with: [ids.a],
    });

    const result = threeWayKnowledgeMerge([], [localOnly], [remoteOnly]);
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      type: 'SEMANTIC_CONTRADICTION',
    }));
    expect(result.automatic).not.toEqual(expect.arrayContaining([ids.a, ids.b]));
    const conflict = result.conflicts.find((item) => item.type === 'SEMANTIC_CONTRADICTION');
    expect(conflict?.related_ids ?? []).toEqual(expect.arrayContaining([ids.a, ids.b]));
  });

  it('takes one-sided edits without conflict', () => {
    const baseEntry = entry(ids.a, { statement: 'Original.' });
    const localEdited = entry(ids.a, { statement: 'Local only.', updated_at: later });
    const remoteUnchanged = entry(ids.a, { statement: 'Original.' });

    const result = threeWayKnowledgeMerge([baseEntry], [localEdited], [remoteUnchanged]);
    expect(result.automatic).toContain(ids.a);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.find((item) => item.id === ids.a)?.statement).toBe('Local only.');
  });
});
