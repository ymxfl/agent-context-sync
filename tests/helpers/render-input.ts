import type { KnowledgeEntry } from '../../src/domain/model.js';
import { compileSections } from '../../src/compiler/compile.js';
import type { RenderInput } from '../../src/adapters/adapter.js';

const now = '2026-07-11T10:00:00Z';
const hash = `sha256:${'c'.repeat(64)}`;

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

const claudeIds = {
  workspace: 'kn_01J00000000000000000000040',
  repo: 'kn_01J00000000000000000000041',
  path: 'kn_01J00000000000000000000042',
  agent: 'kn_01J00000000000000000000043',
  activeWork: 'kn_01J00000000000000000000044',
};

const codexIds = {
  workspace: 'kn_01J00000000000000000000050',
  repo: 'kn_01J00000000000000000000051',
  path: 'kn_01J00000000000000000000052',
  pathNested: 'kn_01J00000000000000000000053',
  agent: 'kn_01J00000000000000000000054',
  activeWork: 'kn_01J00000000000000000000055',
};

function bulkyPathStatement(): string {
  return `Auth module guidance.\n\n${'Keep session tokens server-side only. '.repeat(80)}`.trim();
}

export function claudeRenderInput(): RenderInput {
  const compiled = compileSections({
    entries: [
      entry(claudeIds.workspace, {
        source: {
          agent: 'claude-code',
          source_type: 'project-instruction',
          locator: 'CLAUDE.md',
          content_hash: hash,
          observed_at: now,
        },
        statement: 'Prefer pnpm for installs across the workspace.',
        reason: 'Keeps lockfiles consistent.',
      }),
      entry(claudeIds.repo, {
        scope: 'repository:github.com/acme/api',
        statement: 'API handlers must validate input at the boundary.',
        reason: 'Prevents untrusted data from reaching domain logic.',
        source: {
          agent: 'claude-code',
          source_type: 'project-instruction',
          locator: 'packages/api/CLAUDE.md',
          content_hash: hash,
          observed_at: now,
        },
      }),
      entry(claudeIds.path, {
        scope: 'repository:github.com/acme/api',
        applies_to: { paths: ['src/auth/**'], agents: [] },
        statement: 'Auth sessions are server-side; do not issue JWTs.',
        reason: 'Matches the current session store design.',
        source: {
          agent: 'claude-code',
          source_type: 'project-rule',
          locator: '.claude/rules/api.md',
          content_hash: hash,
          observed_at: now,
        },
      }),
      entry(claudeIds.agent, {
        applies_to: { paths: [], agents: ['claude-code'] },
        statement: 'When unsure, ask before editing generated guidance files.',
        reason: 'Generated files are projections of Context Git.',
        source: {
          agent: 'claude-code',
          source_type: 'project-instruction',
          locator: 'CLAUDE.md',
          content_hash: hash,
          observed_at: now,
        },
      }),
      entry(claudeIds.activeWork, {
        kind: 'active-work',
        scope: 'repository:github.com/acme/api',
        statement: 'Migrating auth session storage to Redis.',
        reason: 'Active cutover work.',
        source: {
          agent: 'claude-code',
          source_type: 'project-instruction',
          locator: 'CLAUDE.md',
          content_hash: hash,
          observed_at: now,
        },
      }),
    ],
    target: {
      repoId: 'github.com/acme/api',
      agent: 'claude-code',
      relativePath: 'src/auth/session.ts',
      workspaceId: 'ws_01J00000000000000000000000',
      contextHead: 'abc123def456',
    },
  });
  return { compiled };
}

export function codexRenderInput(maxBytes = 32768): RenderInput {
  const compiled = compileSections({
    entries: [
      entry(codexIds.workspace, {
        statement: 'Prefer pnpm for installs across the workspace.',
        reason: 'Keeps lockfiles consistent.',
      }),
      entry(codexIds.repo, {
        scope: 'repository:github.com/acme/api',
        statement: 'API handlers must validate input at the boundary.',
        reason: 'Prevents untrusted data from reaching domain logic.',
      }),
      entry(codexIds.path, {
        scope: 'repository:github.com/acme/api',
        applies_to: { paths: ['src/auth/**'], agents: [] },
        statement: bulkyPathStatement(),
        reason: 'Path-scoped auth rules are detailed.',
      }),
      entry(codexIds.pathNested, {
        scope: 'repository:github.com/acme/api',
        applies_to: { paths: ['packages/api/**'], agents: [] },
        statement: 'Package API code uses Zod at request edges.',
        reason: 'Matches existing validation middleware.',
      }),
      entry(codexIds.agent, {
        applies_to: { paths: [], agents: ['codex'] },
        statement: 'Prefer nested AGENTS.md over oversized root files.',
        reason: 'Respects Codex project-doc size limits.',
      }),
      entry(codexIds.activeWork, {
        kind: 'active-work',
        scope: 'repository:github.com/acme/api',
        statement: 'Migrating auth session storage to Redis.',
        reason: 'Active cutover work.',
      }),
    ],
    target: {
      repoId: 'github.com/acme/api',
      agent: 'codex',
      relativePath: 'src/auth/session.ts',
      workspaceId: 'ws_01J00000000000000000000000',
      contextHead: 'abc123def456',
    },
  });
  return { compiled, limits: { maxBytes } };
}
