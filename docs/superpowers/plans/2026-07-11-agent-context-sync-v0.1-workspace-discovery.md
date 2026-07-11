# Agent Context Sync v0.1 Workspace and Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a cross-agent Skill that creates or joins a stable virtual Workspace, maps repositories without moving them, and reports the context sources Claude Code and Codex are expected to load.

**Architecture:** A portable Agent Skill invokes a TypeScript executable bundled in its scripts directory. Deterministic modules own manifests, Git/path identity, source discovery, and reports; the Agent only interprets reports and requests confirmation. Shared Workspace metadata lives in a dedicated Context Git repository while absolute paths remain in a local registry.

**Tech Stack:** Node.js 20+, TypeScript 5.x in strict ESM mode, npm, Vitest, esbuild, Zod, YAML, fast-glob, minimatch, smol-toml, and Node child_process with argument arrays.

## Global Constraints

- MVP supports Claude Code and Codex only.
- The Skill is the recommended user entry; internal commands emit JSON and never ask interactive terminal questions.
- Discovery is read-only and must report covered, partial, unknown, or inaccessible rather than claiming completeness.
- Workspace identity is stable and independent of local directory layout or the set of cloned repositories.
- Shared manifests contain no absolute local paths; local paths live under AGENT_CONTEXT_SYNC_HOME or ~/.agent-context-sync.
- No command may commit, push, reset, clean, or force-update a business repository.
- Use TDD, deterministic fixtures, atomic file writes, and frequent commits.

---

## File Map

- package.json: package metadata, scripts, runtime and development dependencies.
- tsconfig.json: strict ESM type checking.
- vitest.config.ts: test discovery and coverage thresholds.
- src/domain/model.ts: shared domain types and discriminated result types.
- src/domain/errors.ts: stable error codes exposed to the Skill.
- src/schema/workspace.ts: Zod schemas for shared and local manifests.
- src/fs/atomic-write.ts: atomic UTF-8 and YAML writes.
- src/git/run-git.ts: safe Git subprocess wrapper using argument arrays.
- src/workspace/repository-id.ts: remote normalization and stable repository IDs.
- src/workspace/scanner.ts: bounded Git repository scanning with symlink resolution.
- src/workspace/local-registry.ts: local path registry.
- src/workspace/context-repository.ts: init/join and shared manifest validation.
- src/adapters/adapter.ts: Adapter interface and coverage types.
- src/adapters/claude/discover.ts: Claude Code known-source discovery.
- src/adapters/codex/discover.ts: Codex known-source discovery.
- src/adapters/registry.ts: Agent Adapter selection.
- src/commands/init.ts, join.ts, add-repo.ts, inspect.ts, doctor.ts: command use cases.
- src/main.ts: JSON command dispatcher.
- skill/agent-context-sync/SKILL.md: cross-agent workflow instructions.
- skill/agent-context-sync/scripts/acs.mjs: esbuild-bundled executable shipped inside the Skill.
- tests/helpers/fs.ts, git.ts, and invoke.ts: reusable fixture and command helpers with no production dependencies.
- tests: unit, contract, integration, and end-to-end fixtures.

### Task 1: Bootstrap the Tested Skill Runtime

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: src/main.ts
- Create: tests/main.test.ts
- Create: skill/agent-context-sync/SKILL.md
- Create by build: skill/agent-context-sync/scripts/acs.mjs
- Create: tests/helpers/fs.ts
- Create: tests/helpers/git.ts
- Create: tests/helpers/invoke.ts

**Interfaces:**
- Produces: run(argv: string[], io: CommandIO): Promise<number>
- Produces: JSON envelope { ok: boolean, command: string, data?: unknown, error?: AppError }
- Produces: invoke(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; json: any; stderr: string }>
- Produces: pathExists(path: string): Promise<boolean>
- Produces: initFixtureRepository(path: string, remote?: string): Promise<void>
- Produces: createBareRemote(path: string): Promise<string>
- Produces: fixtureGit(path: string, args: readonly string[]): Promise<string>

- [ ] **Step 1: Write the failing dispatcher test**

~~~ts
import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/main.js';

describe('run', () => {
  it('returns structured help without writing to stderr', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const code = await run(['help'], { stdout, stderr });
    expect(code).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      ok: true,
      command: 'help',
    });
    expect(stderr).not.toHaveBeenCalled();
  });
});
~~~

- [ ] **Step 2: Run the test and verify the expected failure**

Run: npm test -- --run tests/main.test.ts

Expected: FAIL because src/main.ts and the package configuration do not exist.

- [ ] **Step 3: Add the minimal runtime and Skill contract**

package.json must set type to module, engines.node to >=20, and scripts build, test, typecheck, and verify. build uses esbuild to bundle src/main.ts and its runtime dependencies into skill/agent-context-sync/scripts/acs.mjs with platform=node and format=esm. Add runtime dependencies zod, yaml, fast-glob, minimatch, and smol-toml; add TypeScript, Vitest, esbuild, and @types/node as development dependencies.

Implement:

~~~ts
export interface CommandIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const command = argv[0] ?? 'help';
  if (command === 'help') {
    io.stdout(JSON.stringify({ ok: true, command, data: { commands: [] } }));
    return 0;
  }
  io.stdout(JSON.stringify({
    ok: false,
    command,
    error: { code: 'UNKNOWN_COMMAND', message: 'Unknown command: ' + command },
  }));
  return 2;
}
~~~

When src/main.ts is the process entry, it must call run(process.argv.slice(2), process-backed IO) and set process.exitCode. The bundled acs.mjs therefore has no dependency on the source checkout after the Skill directory is copied. Implement the listed test helpers with fs/promises and child_process argument arrays; helpers throw with stderr on fixture setup failure. SKILL.md must include name and description, state that all writes require preview then explicit user approval, and list init, join, add-repo, inspect, and doctor.

- [ ] **Step 4: Verify build, typecheck, and test**

Run: npm install && npm run typecheck && npm test -- --run

Expected: all commands exit 0 and the dispatcher test passes.

- [ ] **Step 5: Commit**

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/main.ts tests/main.test.ts tests/helpers skill
git commit -m "chore: bootstrap agent context sync skill runtime"
~~~

### Task 2: Define Domain Errors and Manifest Schemas

**Files:**
- Create: src/domain/model.ts
- Create: src/domain/errors.ts
- Create: src/domain/ids.ts
- Create: src/schema/workspace.ts
- Test: tests/schema/workspace.test.ts
- Test: tests/domain/ids.test.ts

**Interfaces:**
- Produces: WorkspaceManifest, RepositoryManifest, LocalWorkspace, CoverageStatus, AppError
- Produces: parseWorkspaceManifest(value: unknown): WorkspaceManifest
- Produces: parseLocalWorkspace(value: unknown): LocalWorkspace
- Produces: createId(prefix: 'ws' | 'preview' | 'packet' | 'kn'): string

- [ ] **Step 1: Write failing schema tests**

~~~ts
import { describe, expect, it } from 'vitest';
import { parseLocalWorkspace, parseWorkspaceManifest } from '../../src/schema/workspace.js';

it('rejects local paths in the shared manifest', () => {
  expect(() => parseWorkspaceManifest({
    schema_version: 1,
    workspace_id: 'ws_01J00000000000000000000000',
    name: 'platform',
    context_remote: 'git@github.com:acme/platform-context.git',
    local_path: '/private/work',
    repositories: [],
  })).toThrow(/unrecognized/i);
});

it('accepts absolute paths only in the local registry', () => {
  expect(parseLocalWorkspace({
    schema_version: 1,
    workspace_id: 'ws_01J00000000000000000000000',
    context_path: '/tmp/context',
    repository_paths: {},
  }).context_path).toBe('/tmp/context');
});
~~~

- [ ] **Step 2: Run the tests and verify failure**

Run: npm test -- --run tests/schema/workspace.test.ts

Expected: FAIL because the schema module does not exist.

- [ ] **Step 3: Implement strict schemas and stable errors**

Define Zod strict objects. workspace_id must match /^ws_[0-9A-HJKMNP-TV-Z]{26}$/; repository IDs are normalized host/path strings; schema_version is literal 1. Local paths must satisfy path.isAbsolute. Define AppError as { code, message, details? } and appError(code, message, details?) without stack serialization. createId uses crypto.randomBytes and Crockford Base32 to produce 26 uppercase characters without adding an ID dependency.

- [ ] **Step 4: Run focused and full tests**

Run: npm test -- --run tests/schema/workspace.test.ts && npm run typecheck && npm test -- --run

Expected: all pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/domain src/schema tests/schema tests/domain
git commit -m "feat: define workspace manifest contracts"
~~~

### Task 3: Normalize Repository Identity and Scan Workspace Roots

**Files:**
- Create: src/git/run-git.ts
- Create: src/workspace/repository-id.ts
- Create: src/workspace/scanner.ts
- Test: tests/workspace/repository-id.test.ts
- Test: tests/workspace/scanner.test.ts
- Create: tests/fixtures/workspace-scan/

**Interfaces:**
- Produces: runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
- Produces: normalizeRemote(remote: string): string
- Produces: repositoryIdFromRemote(remote: string): string
- Produces: scanRepositories(root: string, options: { maxDepth: number }): Promise<DiscoveredRepository[]>

- [ ] **Step 1: Write identity and symlink scan tests**

~~~ts
expect(normalizeRemote('git@GitHub.com:Acme/API.git')).toBe('github.com/Acme/API');
expect(normalizeRemote('https://user@github.com/Acme/API/')).toBe('github.com/Acme/API');

const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });
expect(result.map((item) => item.realPath)).toEqual([realRepositoryPath]);
expect(result[0].encounteredViaSymlink).toBe(true);
~~~

Create the fixture repository during beforeEach with git init and git remote add origin. Create a directory symlink pointing to it; skip only the symlink assertion on Windows when creation is denied.

- [ ] **Step 2: Run the tests and verify failure**

Run: npm test -- --run tests/workspace/repository-id.test.ts tests/workspace/scanner.test.ts

Expected: FAIL because the functions do not exist.

- [ ] **Step 3: Implement normalization and bounded scanning**

Use new URL for URL remotes and a dedicated SCP-like parser for git@host:path. Remove credentials, .git, query, fragment, and trailing slash; lowercase only the host. Scanner follows a symlink once, records fs.realpath, de-duplicates by real path, stops at maxDepth, and never descends into .git, node_modules, or another discovered repository.

- [ ] **Step 4: Run focused and full verification**

Run: npm test -- --run tests/workspace && npm run typecheck && npm test -- --run

Expected: all pass on the current platform; Windows may report one explicit skipped symlink case.

- [ ] **Step 5: Commit**

~~~bash
git add src/git src/workspace tests/workspace tests/fixtures
git commit -m "feat: discover stable repository identities"
~~~

### Task 4: Persist the Local Registry Atomically

**Files:**
- Create: src/fs/atomic-write.ts
- Create: src/workspace/local-registry.ts
- Test: tests/workspace/local-registry.test.ts

**Interfaces:**
- Consumes: LocalWorkspace and parseLocalWorkspace from Task 2
- Produces: registryPath(home: string, workspaceId: string): string
- Produces: readLocalWorkspace(home: string, workspaceId: string): Promise<LocalWorkspace>
- Produces: writeLocalWorkspace(home: string, value: LocalWorkspace): Promise<void>
- Produces: bindRepositoryPath(local: LocalWorkspace, repoId: string, path: string): LocalWorkspace

- [ ] **Step 1: Write failing atomicity and privacy tests**

~~~ts
await writeLocalWorkspace(home, local);
const loaded = await readLocalWorkspace(home, local.workspace_id);
expect(loaded.repository_paths[repoId]).toBe(realRepo);
expect(await fs.readFile(registryFile, 'utf8')).not.toContain(contextRemote);
expect((await fs.stat(registryFile)).mode & 0o077).toBe(0);
~~~

Also inject a write adapter that throws before rename and assert the original registry remains byte-identical.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/workspace/local-registry.test.ts

Expected: FAIL because persistence is absent.

- [ ] **Step 3: Implement atomic YAML persistence**

Write a sibling temporary file with mode 0o600, fsync it, rename it over the target, and fsync the parent directory where supported. Resolve repository paths with realpath before binding. Reject non-existent and non-absolute paths.

- [ ] **Step 4: Run focused and full tests**

Run: npm test -- --run tests/workspace/local-registry.test.ts && npm run verify

Expected: all pass and no temporary files remain.

- [ ] **Step 5: Commit**

~~~bash
git add src/fs src/workspace/local-registry.ts tests/workspace/local-registry.test.ts
git commit -m "feat: persist private workspace path mappings"
~~~

### Task 5: Implement Context Repository init, join, and add-repo

**Files:**
- Create: src/workspace/context-repository.ts
- Create: src/commands/init.ts
- Create: src/commands/join.ts
- Create: src/commands/add-repo.ts
- Modify: src/main.ts
- Test: tests/integration/workspace-commands.test.ts

**Interfaces:**
- Produces: initWorkspace(input: InitInput): Promise<WorkspacePreview>
- Produces: applyInit(preview: WorkspacePreview): Promise<WorkspaceResult>
- Produces: joinWorkspace(input: JoinInput): Promise<WorkspacePreview>
- Produces: addRepository(input: AddRepositoryInput): Promise<WorkspacePreview>
- Preview includes preview_id, input_hash, files_to_write, repositories, warnings

- [ ] **Step 1: Write failing command integration tests**

~~~ts
const preview = await initWorkspace({
  name: 'platform',
  contextRemote: bareRemote,
  scanRoot: parent,
  maxDepth: 2,
  home,
});
expect(preview.repositories).toHaveLength(2);
expect(await pathExists(path.join(parent, 'workspace.yaml'))).toBe(false);

const result = await applyInit(preview);
expect(result.workspace.workspace_id).toMatch(/^ws_/);
expect(await gitRemote(result.local.context_path)).toBe(bareRemote);
~~~

Add join coverage where only one of two shared repositories exists locally, and add-repo coverage for a repository outside scanRoot.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/integration/workspace-commands.test.ts

Expected: FAIL because the commands do not exist.

- [ ] **Step 3: Implement preview/apply command use cases**

init clones an empty remote or initializes a local Context checkout, writes workspace.yaml and repository manifests only during apply, creates one Context commit, and pushes only after apply. join clones and validates an existing Context repository without writing it. add-repo updates the shared manifest only after preview approval and never changes the business repository.

preview_id is a ULID-like random ID; input_hash covers normalized inputs plus current Context HEAD. apply must reject STALE_PREVIEW when HEAD or inputs changed.

- [ ] **Step 4: Run integration and full verification**

Run: npm test -- --run tests/integration/workspace-commands.test.ts && npm run verify

Expected: all pass; git log in the bare Context remote contains the init commit and business repository logs are unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add src/workspace/context-repository.ts src/commands src/main.ts tests/integration
git commit -m "feat: initialize and join virtual workspaces"
~~~

### Task 6: Implement Claude Code Discovery Contract

**Files:**
- Create: src/adapters/adapter.ts
- Create: src/adapters/claude/discover.ts
- Create: tests/adapters/claude.test.ts
- Create: tests/fixtures/claude-home/
- Create: tests/fixtures/claude-repo/

**Interfaces:**
- Produces: ContextSource, CoverageItem, CoverageReport, LoadOrder
- Produces: ClaudeAdapter.discover(input: DiscoveryInput): Promise<CoverageReport>

- [ ] **Step 1: Write failing fixture tests**

~~~ts
const report = await adapter.discover(input);
expect(report.sources.map((source) => source.sourceType)).toEqual(expect.arrayContaining([
  'user-instructions',
  'project-instructions',
  'local-instructions',
  'project-rule',
  'import',
  'auto-memory',
]));
expect(report.sources.find((source) => source.sourceType === 'user-instructions')?.shareability)
  .toBe('personal');
expect(report.coverage.every((item) => ['covered', 'partial', 'unknown', 'inaccessible'].includes(item.status)))
  .toBe(true);
~~~

Fixtures must include parent and nested CLAUDE.md files, .claude/rules with paths, a recursive @ import, claudeMdExcludes, and a memory directory override.

- [ ] **Step 2: Run the contract test and verify failure**

Run: npm test -- --run tests/adapters/claude.test.ts

Expected: FAIL because ClaudeAdapter is absent.

- [ ] **Step 3: Implement known-source discovery**

Parse settings from managed, user, project, local, and explicit settings paths without importing organization-managed content. Walk ancestors and repository descendants according to documented Claude behavior. Parse @ imports outside code spans/fences with maximum four hops and cycle detection. Report excluded or unreadable paths instead of throwing. Resolve autoMemoryDirectory and otherwise derive the repository memory locator from the installed Claude layout; if derivation cannot be confirmed, report partial.

- [ ] **Step 4: Run Adapter and full tests**

Run: npm test -- --run tests/adapters/claude.test.ts && npm run verify

Expected: all pass and fixture ordering is deterministic across repeated runs.

- [ ] **Step 5: Commit**

~~~bash
git add src/adapters tests/adapters tests/fixtures/claude-*
git commit -m "feat: discover claude code context sources"
~~~

### Task 7: Implement Codex Discovery Contract

**Files:**
- Create: src/adapters/codex/discover.ts
- Create: src/adapters/registry.ts
- Test: tests/adapters/codex.test.ts
- Create: tests/fixtures/codex-home/
- Create: tests/fixtures/codex-repo/

**Interfaces:**
- Consumes: Adapter types from Task 6
- Produces: CodexAdapter.discover(input: DiscoveryInput): Promise<CoverageReport>
- Produces: adapterFor(name: 'claude-code' | 'codex'): AgentAdapter

- [ ] **Step 1: Write failing precedence and size-limit tests**

~~~ts
const report = await adapter.discover(input);
expect(report.loadPlan.map((item) => item.locator)).toEqual([
  'codex-home/AGENTS.override.md',
  'repo/AGENTS.md',
  'repo/packages/api/AGENTS.override.md',
]);
expect(report.sources.some((source) => source.status === 'excluded-by-precedence')).toBe(true);
expect(report.limits).toMatchObject({ maxBytes: 32768, truncated: true });
expect(report.sources.find((source) => source.sourceType === 'local-memory')?.shareability)
  .toBe('personal');
~~~

Fixtures must cover AGENTS.override.md, fallback filenames, project_doc_max_bytes, CODEX_HOME, and memories with and without a repository locator.

- [ ] **Step 2: Run the test and verify failure**

Run: npm test -- --run tests/adapters/codex.test.ts

Expected: FAIL because CodexAdapter is absent.

- [ ] **Step 3: Implement Codex discovery**

Parse config.toml using smol-toml. At global scope select the first non-empty override/base file. At each directory from project root to cwd select at most one override/base/fallback file. Accumulate UTF-8 bytes until project_doc_max_bytes and report truncation. Inspect local memory metadata only when it can be associated with a registered repository; never classify unrelated memories as team candidates.

- [ ] **Step 4: Run Adapter and full tests**

Run: npm test -- --run tests/adapters/codex.test.ts && npm run verify

Expected: all pass and load order matches the official precedence fixture.

- [ ] **Step 5: Commit**

~~~bash
git add src/adapters tests/adapters tests/fixtures/codex-*
git commit -m "feat: discover codex context sources"
~~~

### Task 8: Expose inspect and doctor Through the Skill

**Files:**
- Create: src/commands/inspect.ts
- Create: src/commands/doctor.ts
- Modify: src/main.ts
- Modify: skill/agent-context-sync/SKILL.md
- Test: tests/integration/inspect-doctor.test.ts
- Test: tests/e2e/v01-skill.test.ts
- Create: README.md

**Interfaces:**
- Consumes: adapterFor, local registry, and Workspace manifest
- Produces: inspect(input: InspectInput): Promise<CoverageReport[]>
- Produces: doctor(input: DoctorInput): Promise<DoctorReport>

- [ ] **Step 1: Write failing end-to-end tests**

~~~ts
const inspectResult = await invoke(['inspect', '--workspace', workspaceId, '--agent', 'codex'], env);
expect(inspectResult.exitCode).toBe(0);
expect(inspectResult.json.data.reports[0].agent).toBe('codex');
expect(inspectResult.json.data.reports[0].sources.length).toBeGreaterThan(0);

const doctorResult = await invoke(['doctor', '--workspace', workspaceId], env);
expect(doctorResult.json.data.checks).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: 'node-version', status: 'pass' }),
  expect.objectContaining({ id: 'context-git', status: 'pass' }),
  expect.objectContaining({ id: 'adapter-coverage' }),
]));
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/integration/inspect-doctor.test.ts tests/e2e/v01-skill.test.ts

Expected: FAIL because inspect and doctor are not dispatched.

- [ ] **Step 3: Implement reports and Skill instructions**

inspect must be read-only and return one report per requested repository. doctor checks Node version, Git availability, Context remote reachability, registry validity, repository path drift, Adapter version support, and permissions. Update SKILL.md with exact preview/apply invocations, one-question-at-a-time approval language, and explicit prohibition on interpreting unknown coverage as complete.

README must document installation into ~/.codex/skills/agent-context-sync and ~/.claude/skills/agent-context-sync, the virtual Workspace model, supported Agents, and the v0.1 command examples.

- [ ] **Step 4: Run the v0.1 acceptance suite**

Run: npm run verify && npm test -- --run tests/e2e/v01-skill.test.ts

Expected: typecheck and all tests pass; the end-to-end fixture initializes a two-repository Workspace, joins with one repository present, and emits Claude and Codex coverage reports without modifying either business repository.

- [ ] **Step 5: Commit**

~~~bash
git add src/commands src/main.ts skill README.md tests/integration tests/e2e
git commit -m "feat: deliver workspace discovery skill"
~~~

## v0.1 Completion Gate

Run:

~~~bash
npm ci
npm run verify
git status --short
~~~

Expected:

- Build, typecheck, unit, Adapter contract, integration, and v0.1 end-to-end tests pass.
- git status is clean except for intentionally ignored local test artifacts.
- init, join, add-repo, inspect, and doctor are documented and callable through the Skill launcher.
- No business repository commit or file content changes during the acceptance test.
