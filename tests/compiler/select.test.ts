import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { selectKnowledge } from '../../src/compiler/select.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'c'.repeat(64)}`;
const ids = {
  workspace: 'kn_01J00000000000000000000000',
  repo: 'kn_01J00000000000000000000001',
  path: 'kn_01J00000000000000000000002',
  agent: 'kn_01J00000000000000000000003',
  activeWork: 'kn_01J00000000000000000000004',
  otherRepo: 'kn_01J00000000000000000000005',
  archived: 'kn_01J00000000000000000000006',
  wrongAgent: 'kn_01J00000000000000000000007',
  unmatchedPath: 'kn_01J00000000000000000000008',
};

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
    statement: `Statement for ${id}`,
    reason: `Reason for ${id}`,
    ...overrides,
  };
}

describe('selectKnowledge', () => {
  const workspaceRule = entry(ids.workspace, {
    scope: 'workspace',
    statement: 'Prefer deterministic reviews.',
  });
  const repoRule = entry(ids.repo, {
    scope: 'repository:github.com/acme/api',
    statement: 'Use repository-local conventions.',
  });
  const pathRule = entry(ids.path, {
    scope: 'repository:github.com/acme/api',
    applies_to: { paths: ['src/auth/**'], agents: [] },
    statement: 'Sessions stay server-side.',
  });
  const agentRule = entry(ids.agent, {
    scope: 'workspace',
    applies_to: { paths: [], agents: ['codex'] },
    statement: 'Codex-only reminder.',
  });
  const activeWork = entry(ids.activeWork, {
    kind: 'active-work',
    scope: 'repository:github.com/acme/api',
    statement: 'Auth rewrite in progress.',
  });
  const otherRepoRule = entry(ids.otherRepo, {
    scope: 'repository:github.com/acme/web',
  });
  const archivedRule = entry(ids.archived, {
    status: 'archived',
    scope: 'workspace',
  });
  const wrongAgentRule = entry(ids.wrongAgent, {
    scope: 'workspace',
    applies_to: { paths: [], agents: ['claude-code'] },
  });
  const unmatchedPathRule = entry(ids.unmatchedPath, {
    scope: 'repository:github.com/acme/api',
    applies_to: { paths: ['src/db/**'], agents: [] },
  });

  const entries = [
    unmatchedPathRule,
    activeWork,
    pathRule,
    wrongAgentRule,
    agentRule,
    archivedRule,
    otherRepoRule,
    repoRule,
    workspaceRule,
  ];

  it('selects active workspace, repository, and matching path knowledge in section order', () => {
    const selected = selectKnowledge({
      entries,
      repoId: 'github.com/acme/api',
      agent: 'codex',
      relativePath: 'src/auth/session.ts',
    });
    expect(selected.map((item) => item.id)).toEqual([
      workspaceRule.id,
      repoRule.id,
      pathRule.id,
      agentRule.id,
      activeWork.id,
    ]);
  });

  it('excludes non-active, other-repo, agent-mismatched, and unmatched path entries', () => {
    const selected = selectKnowledge({
      entries,
      repoId: 'github.com/acme/api',
      agent: 'codex',
      relativePath: 'src/auth/session.ts',
    });
    const selectedIds = new Set(selected.map((item) => item.id));
    expect(selectedIds.has(archivedRule.id)).toBe(false);
    expect(selectedIds.has(otherRepoRule.id)).toBe(false);
    expect(selectedIds.has(wrongAgentRule.id)).toBe(false);
    expect(selectedIds.has(unmatchedPathRule.id)).toBe(false);
  });

  it('matches repository-relative POSIX globs with minimatch semantics', () => {
    const nested = entry('kn_01J00000000000000000000009', {
      scope: 'repository:github.com/acme/api',
      applies_to: { paths: ['src/**/*.ts'], agents: [] },
    });
    const selected = selectKnowledge({
      entries: [nested],
      repoId: 'github.com/acme/api',
      agent: 'codex',
      relativePath: 'src/auth/session.ts',
    });
    expect(selected.map((item) => item.id)).toEqual([nested.id]);
  });

  it('includes all path-scoped entries when relativePath is omitted (repo projection)', () => {
    const selected = selectKnowledge({
      entries,
      repoId: 'github.com/acme/api',
      agent: 'codex',
    });
    const selectedIds = new Set(selected.map((item) => item.id));
    expect(selectedIds.has(pathRule.id)).toBe(true);
    expect(selectedIds.has(unmatchedPathRule.id)).toBe(true);
    expect(selected.map((item) => item.id)).toEqual([
      workspaceRule.id,
      repoRule.id,
      pathRule.id,
      unmatchedPathRule.id,
      agentRule.id,
      activeWork.id,
    ]);
  });

  it('orders entries within a section by stable ID', () => {
    const later = entry('kn_01J0000000000000000000000b', { scope: 'workspace' });
    const earlier = entry('kn_01J0000000000000000000000a', { scope: 'workspace' });
    const selected = selectKnowledge({
      entries: [later, earlier],
      repoId: 'github.com/acme/api',
      agent: 'codex',
    });
    expect(selected.map((item) => item.id)).toEqual([earlier.id, later.id]);
  });
});

describe('selectKnowledge determinism', () => {
  it('returns identical ID sequences across shuffled inputs', () => {
    const a = entry('kn_01J00000000000000000000010', { scope: 'workspace' });
    const b = entry('kn_01J00000000000000000000011', {
      scope: 'repository:github.com/acme/api',
    });
    const c = entry('kn_01J00000000000000000000012', {
      scope: 'repository:github.com/acme/api',
      applies_to: { paths: ['src/**'], agents: [] },
    });
    const hashes = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const shuffled = [a, b, c].sort(() => (i % 2 === 0 ? -1 : 1));
      const selected = selectKnowledge({
        entries: shuffled,
        repoId: 'github.com/acme/api',
        agent: 'codex',
        relativePath: 'src/main.ts',
      });
      hashes.add(createHash('sha256').update(selected.map((item) => item.id).join('\n')).digest('hex'));
    }
    expect(hashes.size).toBe(1);
  });
});
