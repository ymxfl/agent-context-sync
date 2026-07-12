import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { compileSections } from '../../src/compiler/compile.js';
import { detectActiveConflicts } from '../../src/compiler/conflicts.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'d'.repeat(64)}`;
const ids = {
  workspace: 'kn_01J00000000000000000000020',
  repo: 'kn_01J00000000000000000000021',
  path: 'kn_01J00000000000000000000022',
  agent: 'kn_01J00000000000000000000023',
  activeWork: 'kn_01J00000000000000000000024',
  left: 'kn_01J00000000000000000000025',
  right: 'kn_01J00000000000000000000026',
  disputed: 'kn_01J00000000000000000000027',
  resolved: 'kn_01J00000000000000000000028',
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

describe('detectActiveConflicts', () => {
  it('reports active conflicts that lack a supersedes resolution', () => {
    const left = entry(ids.left, { conflicts_with: [ids.right] });
    const right = entry(ids.right, { conflicts_with: [ids.left] });
    const conflicts = detectActiveConflicts([left, right]);
    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        left_id: ids.left,
        right_id: ids.right,
      }),
    ]));
  });

  it('ignores conflicts resolved by supersedes on either side', () => {
    const left = entry(ids.left, {
      conflicts_with: [ids.resolved],
      supersedes: [ids.resolved],
    });
    const resolved = entry(ids.resolved, {
      status: 'superseded',
      conflicts_with: [ids.left],
    });
    expect(detectActiveConflicts([left, resolved])).toEqual([]);
  });

  it('reports conflicts that point at disputed knowledge', () => {
    const active = entry(ids.left, { conflicts_with: [ids.disputed] });
    const disputed = entry(ids.disputed, {
      status: 'disputed',
      conflicts_with: [ids.left],
    });
    expect(detectActiveConflicts([active, disputed])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        left_id: ids.left,
        right_id: ids.disputed,
      }),
    ]));
  });
});

describe('compileSections', () => {
  const target = {
    repoId: 'github.com/acme/api',
    agent: 'codex',
    relativePath: 'src/auth/session.ts',
    workspaceId: 'ws_01J00000000000000000000000',
    contextHead: 'abc123',
  };

  const workspaceRule = entry(ids.workspace, { scope: 'workspace' });
  const repoRule = entry(ids.repo, { scope: 'repository:github.com/acme/api' });
  const pathRule = entry(ids.path, {
    scope: 'repository:github.com/acme/api',
    applies_to: { paths: ['src/auth/**'], agents: [] },
  });
  const agentRule = entry(ids.agent, {
    scope: 'workspace',
    applies_to: { paths: [], agents: ['codex'] },
  });
  const activeWork = entry(ids.activeWork, {
    kind: 'active-work',
    scope: 'repository:github.com/acme/api',
  });

  it('fails compilation when active conflicts are unresolved', () => {
    const conflicting = [
      entry(ids.left, {
        scope: 'workspace',
        conflicts_with: [ids.right],
      }),
      entry(ids.right, {
        scope: 'workspace',
        conflicts_with: [ids.left],
      }),
    ];
    expect(() => compileSections({ entries: conflicting, target })).toThrowError(
      expect.objectContaining({ code: 'ACTIVE_KNOWLEDGE_CONFLICT' }),
    );
  });

  it('fails when an active entry conflicts with disputed knowledge', () => {
    const entries = [
      entry(ids.left, {
        scope: 'workspace',
        conflicts_with: [ids.disputed],
      }),
      entry(ids.disputed, {
        scope: 'workspace',
        status: 'disputed',
        conflicts_with: [ids.left],
      }),
    ];
    expect(() => compileSections({ entries, target })).toThrowError(
      expect.objectContaining({ code: 'ACTIVE_KNOWLEDGE_CONFLICT' }),
    );
  });

  it('fails when active conflicts involve a non-applicable agent-scoped entry', () => {
    const applicable = entry(ids.left, {
      scope: 'workspace',
      applies_to: { paths: [], agents: ['codex'] },
      conflicts_with: [ids.right],
    });
    const otherAgentOnly = entry(ids.right, {
      scope: 'workspace',
      applies_to: { paths: [], agents: ['claude-code'] },
      conflicts_with: [ids.left],
    });
    expect(() => compileSections({
      entries: [applicable, otherAgentOnly],
      target,
    })).toThrowError(
      expect.objectContaining({ code: 'ACTIVE_KNOWLEDGE_CONFLICT' }),
    );
  });

  it('emits deterministic sections in priority order', () => {
    const compiled = compileSections({
      entries: [activeWork, agentRule, pathRule, repoRule, workspaceRule],
      target,
    });

    expect(compiled).toEqual(expect.objectContaining({
      workspace_id: target.workspaceId,
      context_head: target.contextHead,
      agent: target.agent,
      repo_id: target.repoId,
      relative_path: target.relativePath,
    }));
    expect(compiled.sections.map((section) => section.id)).toEqual([
      'workspace',
      'repository',
      'path',
      'agent',
      'active-work',
    ]);
    expect(compiled.sections.map((section) => section.entries.map((item) => item.id))).toEqual([
      [workspaceRule.id],
      [repoRule.id],
      [pathRule.id],
      [agentRule.id],
      [activeWork.id],
    ]);
  });

  it('places path-scoped agent knowledge in the path section', () => {
    const pathAndAgent = entry(ids.path, {
      scope: 'repository:github.com/acme/api',
      applies_to: { paths: ['src/auth/**'], agents: ['codex'] },
    });
    const compiled = compileSections({
      entries: [pathAndAgent],
      target,
    });
    expect(compiled.sections.map((section) => section.id)).toEqual(['path']);
    expect(compiled.sections[0]?.entries.map((item) => item.id)).toEqual([pathAndAgent.id]);
  });

  it('produces one unique SHA-256 across 100 deterministic runs', () => {
    const entries = [activeWork, agentRule, pathRule, repoRule, workspaceRule];
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const shuffled = [...entries].sort((left, right) => {
        const spin = (i + left.id.length + right.id.length) % 3;
        return spin === 0 ? -1 : spin === 1 ? 1 : left.id < right.id ? -1 : 1;
      });
      const compiled = compileSections({ entries: shuffled, target });
      hashes.add(createHash('sha256').update(JSON.stringify(compiled)).digest('hex'));
    }
    expect(hashes.size).toBe(1);
  });
});
