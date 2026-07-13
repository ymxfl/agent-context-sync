# Agent Context Sync v0.1 Workspace 和发现功能实现计划

> **面向智能体执行者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤使用 checkbox（- [ ]）跟踪。

**目标：** 构建一个跨智能体 Skill，用于创建或加入稳定的虚拟 Workspace，在不移动仓库的情况下映射仓库，并报告 Claude Code 和 Codex 预期会加载的上下文来源。

**架构：** 一个可移植的 Agent Skill 调用打包在其 scripts 目录中的 TypeScript 可执行文件。确定性模块负责 manifests、Git/路径身份、来源发现和报告；Agent 只解读报告并请求确认。共享 Workspace 元数据保存在专用的 Context Git 仓库中，而绝对路径保留在本地 registry 中。

**技术栈：** Node.js 20+、严格 ESM 模式下的 TypeScript 5.x、npm、Vitest、esbuild、Zod、YAML、fast-glob、minimatch、smol-toml，以及使用参数数组的 Node child_process。

## 全局约束

- MVP 仅支持 Claude Code 和 Codex。
- Skill 是推荐的用户入口；内部命令输出 JSON，且绝不提出交互式终端问题。
- 发现过程是只读的，并且必须报告 covered、partial、unknown 或 inaccessible，而不是声称完整性。
- Workspace 身份是稳定的，并且独立于本地目录布局或已克隆仓库集合。
- 共享 manifests 不包含本地绝对路径；本地路径保存在 AGENT_CONTEXT_SYNC_HOME 或 ~/.agent-context-sync 下。
- 任何命令都不得对业务仓库执行 commit、push、reset、clean 或强制更新。
- 使用 TDD、确定性 fixtures、原子文件写入和频繁提交。

---

## 文件映射

- package.json：package 元数据、脚本、运行时依赖和开发依赖。
- tsconfig.json：严格 ESM 类型检查。
- vitest.config.ts：测试发现和覆盖率阈值。
- src/domain/model.ts：共享领域类型和判别式结果类型。
- src/domain/errors.ts：暴露给 Skill 的稳定错误码。
- src/schema/workspace.ts：共享和本地 manifests 的 Zod schemas。
- src/fs/atomic-write.ts：原子的 UTF-8 和 YAML 写入。
- src/git/run-git.ts：使用参数数组的安全 Git 子进程封装。
- src/workspace/repository-id.ts：remote 规范化和稳定 repository IDs。
- src/workspace/scanner.ts：带边界的 Git 仓库扫描和 symlink 解析。
- src/workspace/local-registry.ts：本地路径 registry。
- src/workspace/context-repository.ts：init/join 和共享 manifest 校验。
- src/adapters/adapter.ts：Adapter 接口和覆盖范围类型。
- src/adapters/claude/discover.ts：Claude Code 已知来源发现。
- src/adapters/codex/discover.ts：Codex 已知来源发现。
- src/adapters/registry.ts：Agent Adapter 选择。
- src/commands/init.ts、join.ts、add-repo.ts、inspect.ts、doctor.ts：命令用例。
- src/main.ts：JSON 命令调度器。
- skill/agent-context-sync/SKILL.md：跨智能体工作流说明。
- skill/agent-context-sync/scripts/acs.mjs：随 Skill 一起发布的 esbuild 打包可执行文件。
- tests/helpers/fs.ts、git.ts 和 invoke.ts：无生产依赖的可复用 fixture 和命令 helper。
- tests：unit、contract、integration 和 end-to-end fixtures。

### 任务 1：引导已测试的 Skill 运行时

**文件：**
- 创建：package.json
- 创建：tsconfig.json
- 创建：vitest.config.ts
- 创建：src/main.ts
- 创建：tests/main.test.ts
- 创建：skill/agent-context-sync/SKILL.md
- 由构建创建：skill/agent-context-sync/scripts/acs.mjs
- 创建：tests/helpers/fs.ts
- 创建：tests/helpers/git.ts
- 创建：tests/helpers/invoke.ts

**接口：**
- 产出：run(argv: string[], io: CommandIO): Promise<number>
- 产出：JSON envelope { ok: boolean, command: string, data?: unknown, error?: AppError }
- 产出：invoke(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number; json: any; stderr: string }>
- 产出：pathExists(path: string): Promise<boolean>
- 产出：initFixtureRepository(path: string, remote?: string): Promise<void>
- 产出：createBareRemote(path: string): Promise<string>
- 产出：fixtureGit(path: string, args: readonly string[]): Promise<string>

- [ ] **步骤 1：编写失败的 dispatcher 测试**

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

- [ ] **步骤 2：运行测试并验证预期失败**

运行：npm test -- --run tests/main.test.ts

预期：FAIL，因为 src/main.ts 和 package configuration 不存在。

- [ ] **步骤 3：添加最小运行时和 Skill contract**

package.json 必须将 type 设置为 module，将 engines.node 设置为 >=20，并提供 build、test、typecheck 和 verify scripts。build 使用 esbuild 将 src/main.ts 及其运行时依赖打包到 skill/agent-context-sync/scripts/acs.mjs，platform=node，format=esm。添加运行时依赖 zod、yaml、fast-glob、minimatch 和 smol-toml；添加 TypeScript、Vitest、esbuild 和 @types/node 作为开发依赖。

实现：

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

当 src/main.ts 是 process entry 时，它必须调用 run(process.argv.slice(2), process-backed IO) 并设置 process.exitCode。因此，在复制 Skill 目录后，打包后的 acs.mjs 不依赖 source checkout。使用 fs/promises 和 child_process 参数数组实现列出的测试 helpers；fixture setup 失败时，helpers 会携带 stderr 抛出。SKILL.md 必须包含 name 和 description，声明所有写入都需要 preview 后再获得明确用户批准，并列出 init、join、add-repo、inspect 和 doctor。

- [ ] **步骤 4：验证 build、typecheck 和 test**

运行：npm install && npm run typecheck && npm test -- --run

预期：所有命令 exit 0，dispatcher 测试通过。

- [ ] **步骤 5：提交**

~~~bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/main.ts tests/main.test.ts tests/helpers skill
git commit -m "chore: bootstrap agent context sync skill runtime"
~~~

### 任务 2：定义 Domain Errors 和 Manifest Schemas

**文件：**
- 创建：src/domain/model.ts
- 创建：src/domain/errors.ts
- 创建：src/domain/ids.ts
- 创建：src/schema/workspace.ts
- 测试：tests/schema/workspace.test.ts
- 测试：tests/domain/ids.test.ts

**接口：**
- 产出：WorkspaceManifest、RepositoryManifest、LocalWorkspace、CoverageStatus、AppError
- 产出：parseWorkspaceManifest(value: unknown): WorkspaceManifest
- 产出：parseLocalWorkspace(value: unknown): LocalWorkspace
- 产出：createId(prefix: 'ws' | 'preview' | 'packet' | 'kn'): string

- [ ] **步骤 1：编写失败的 schema 测试**

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

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/schema/workspace.test.ts

预期：FAIL，因为 schema module 不存在。

- [ ] **步骤 3：实现严格 schemas 和稳定 errors**

定义 Zod strict objects。workspace_id 必须匹配 /^ws_[0-9A-HJKMNP-TV-Z]{26}$/；repository IDs 是规范化的 host/path 字符串；schema_version 是 literal 1。Local paths 必须满足 path.isAbsolute。将 AppError 定义为 { code, message, details? }，并定义 appError(code, message, details?)，不序列化 stack。createId 使用 crypto.randomBytes 和 Crockford Base32 生成 26 个大写字符，且不添加 ID 依赖。

- [ ] **步骤 4：运行聚焦测试和完整测试**

运行：npm test -- --run tests/schema/workspace.test.ts && npm run typecheck && npm test -- --run

预期：全部通过。

- [ ] **步骤 5：提交**

~~~bash
git add src/domain src/schema tests/schema tests/domain
git commit -m "feat: define workspace manifest contracts"
~~~

### 任务 3：规范化 Repository Identity 并扫描 Workspace Roots

**文件：**
- 创建：src/git/run-git.ts
- 创建：src/workspace/repository-id.ts
- 创建：src/workspace/scanner.ts
- 测试：tests/workspace/repository-id.test.ts
- 测试：tests/workspace/scanner.test.ts
- 创建：tests/fixtures/workspace-scan/

**接口：**
- 产出：runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
- 产出：normalizeRemote(remote: string): string
- 产出：repositoryIdFromRemote(remote: string): string
- 产出：scanRepositories(root: string, options: { maxDepth: number }): Promise<DiscoveredRepository[]>

- [ ] **步骤 1：编写 identity 和 symlink scan 测试**

~~~ts
expect(normalizeRemote('git@GitHub.com:Acme/API.git')).toBe('github.com/Acme/API');
expect(normalizeRemote('https://user@github.com/Acme/API/')).toBe('github.com/Acme/API');

const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });
expect(result.map((item) => item.realPath)).toEqual([realRepositoryPath]);
expect(result[0].encounteredViaSymlink).toBe(true);
~~~

在 beforeEach 中使用 git init 和 git remote add origin 创建 fixture repository。创建一个指向它的目录 symlink；仅当 Windows 上拒绝创建时才跳过 symlink 断言。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/workspace/repository-id.test.ts tests/workspace/scanner.test.ts

预期：FAIL，因为这些函数不存在。

- [ ] **步骤 3：实现规范化和有界扫描**

对 URL remotes 使用 new URL，并为 git@host:path 使用专用的类 SCP parser。移除 credentials、.git、query、fragment 和 trailing slash；仅将 host 转为小写。Scanner 跟随 symlink 一次，记录 fs.realpath，按 real path 去重，在 maxDepth 停止，并且绝不进入 .git、node_modules 或另一个已发现的 repository。

- [ ] **步骤 4：运行聚焦验证和完整验证**

运行：npm test -- --run tests/workspace && npm run typecheck && npm test -- --run

预期：在当前平台上全部通过；Windows 可能报告一个明确跳过的 symlink case。

- [ ] **步骤 5：提交**

~~~bash
git add src/git src/workspace tests/workspace tests/fixtures
git commit -m "feat: discover stable repository identities"
~~~

### 任务 4：原子化持久化 Local Registry

**文件：**
- 创建：src/fs/atomic-write.ts
- 创建：src/workspace/local-registry.ts
- 测试：tests/workspace/local-registry.test.ts

**接口：**
- 使用：Task 2 中的 LocalWorkspace 和 parseLocalWorkspace
- 产出：registryPath(home: string, workspaceId: string): string
- 产出：readLocalWorkspace(home: string, workspaceId: string): Promise<LocalWorkspace>
- 产出：writeLocalWorkspace(home: string, value: LocalWorkspace): Promise<void>
- 产出：bindRepositoryPath(local: LocalWorkspace, repoId: string, path: string): LocalWorkspace

- [ ] **步骤 1：编写失败的 atomicity 和 privacy 测试**

~~~ts
await writeLocalWorkspace(home, local);
const loaded = await readLocalWorkspace(home, local.workspace_id);
expect(loaded.repository_paths[repoId]).toBe(realRepo);
expect(await fs.readFile(registryFile, 'utf8')).not.toContain(contextRemote);
expect((await fs.stat(registryFile)).mode & 0o077).toBe(0);
~~~

另注入一个在 rename 前抛出的 write adapter，并断言原始 registry 保持 byte-identical。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/workspace/local-registry.test.ts

预期：FAIL，因为 persistence 缺失。

- [ ] **步骤 3：实现原子 YAML 持久化**

写入一个 sibling temporary file，mode 为 0o600，对其 fsync，然后 rename 覆盖目标，并在支持的情况下 fsync parent directory。绑定前用 realpath 解析 repository paths。拒绝不存在和非绝对路径。

- [ ] **步骤 4：运行聚焦测试和完整测试**

运行：npm test -- --run tests/workspace/local-registry.test.ts && npm run verify

预期：全部通过，并且没有 temporary files 残留。

- [ ] **步骤 5：提交**

~~~bash
git add src/fs src/workspace/local-registry.ts tests/workspace/local-registry.test.ts
git commit -m "feat: persist private workspace path mappings"
~~~

### 任务 5：实现 Context Repository init、join 和 add-repo

**文件：**
- 创建：src/workspace/context-repository.ts
- 创建：src/commands/init.ts
- 创建：src/commands/join.ts
- 创建：src/commands/add-repo.ts
- 修改：src/main.ts
- 测试：tests/integration/workspace-commands.test.ts

**接口：**
- 产出：initWorkspace(input: InitInput): Promise<WorkspacePreview>
- 产出：applyInit(preview: WorkspacePreview): Promise<WorkspaceResult>
- 产出：joinWorkspace(input: JoinInput): Promise<WorkspacePreview>
- 产出：addRepository(input: AddRepositoryInput): Promise<WorkspacePreview>
- Preview 包含 preview_id、input_hash、files_to_write、repositories、warnings

- [ ] **步骤 1：编写失败的 command integration 测试**

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

添加 join 覆盖：两个共享 repositories 中只有一个在本地存在；并添加 add-repo 覆盖：repository 位于 scanRoot 外部。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/integration/workspace-commands.test.ts

预期：FAIL，因为 commands 不存在。

- [ ] **步骤 3：实现 preview/apply 命令用例**

init 克隆空 remote 或初始化本地 Context checkout，仅在 apply 期间写入 workspace.yaml 和 repository manifests，创建一个 Context commit，并且只在 apply 后 push。join 克隆并校验已有 Context repository，不写入它。add-repo 仅在 preview approval 后更新共享 manifest，并且绝不更改 business repository。

preview_id 是类 ULID 的随机 ID；input_hash 覆盖规范化输入以及当前 Context HEAD。当 HEAD 或 inputs 发生变化时，apply 必须拒绝 STALE_PREVIEW。

- [ ] **步骤 4：运行 integration 和完整验证**

运行：npm test -- --run tests/integration/workspace-commands.test.ts && npm run verify

预期：全部通过；bare Context remote 中的 git log 包含 init commit，business repository logs 保持不变。

- [ ] **步骤 5：提交**

~~~bash
git add src/workspace/context-repository.ts src/commands src/main.ts tests/integration
git commit -m "feat: initialize and join virtual workspaces"
~~~

### 任务 6：实现 Claude Code Discovery Contract

**文件：**
- 创建：src/adapters/adapter.ts
- 创建：src/adapters/claude/discover.ts
- 创建：tests/adapters/claude.test.ts
- 创建：tests/fixtures/claude-home/
- 创建：tests/fixtures/claude-repo/

**接口：**
- 产出：ContextSource、CoverageItem、CoverageReport、LoadOrder
- 产出：ClaudeAdapter.discover(input: DiscoveryInput): Promise<CoverageReport>

- [ ] **步骤 1：编写失败的 fixture 测试**

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

Fixtures 必须包含父级和嵌套的 CLAUDE.md 文件、带 paths 的 .claude/rules、递归 @ import、claudeMdExcludes，以及 memory directory override。

- [ ] **步骤 2：运行 contract test 并验证失败**

运行：npm test -- --run tests/adapters/claude.test.ts

预期：FAIL，因为 ClaudeAdapter 缺失。

- [ ] **步骤 3：实现已知来源发现**

解析来自 managed、user、project、local 和 explicit settings paths 的 settings，但不导入 organization-managed content。根据已文档化的 Claude 行为遍历 ancestors 和 repository descendants。在 code spans/fences 外解析 @ imports，最多四跳并检测循环。报告 excluded 或 unreadable paths，而不是抛出。解析 autoMemoryDirectory，否则从已安装 Claude layout 推导 repository memory locator；如果无法确认推导结果，则报告 partial。

- [ ] **步骤 4：运行 Adapter 和完整测试**

运行：npm test -- --run tests/adapters/claude.test.ts && npm run verify

预期：全部通过，且 fixture ordering 在重复运行之间保持确定性。

- [ ] **步骤 5：提交**

~~~bash
git add src/adapters tests/adapters tests/fixtures/claude-*
git commit -m "feat: discover claude code context sources"
~~~

### 任务 7：实现 Codex Discovery Contract

**文件：**
- 创建：src/adapters/codex/discover.ts
- 创建：src/adapters/registry.ts
- 测试：tests/adapters/codex.test.ts
- 创建：tests/fixtures/codex-home/
- 创建：tests/fixtures/codex-repo/

**接口：**
- 使用：Task 6 中的 Adapter types
- 产出：CodexAdapter.discover(input: DiscoveryInput): Promise<CoverageReport>
- 产出：adapterFor(name: 'claude-code' | 'codex'): AgentAdapter

- [ ] **步骤 1：编写失败的 precedence 和 size-limit 测试**

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

Fixtures 必须覆盖 AGENTS.override.md、fallback filenames、project_doc_max_bytes、CODEX_HOME，以及带有和不带 repository locator 的 memories。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/adapters/codex.test.ts

预期：FAIL，因为 CodexAdapter 缺失。

- [ ] **步骤 3：实现 Codex discovery**

使用 smol-toml 解析 config.toml。在 global scope 选择第一个非空的 override/base file。在从 project root 到 cwd 的每个 directory 中，最多选择一个 override/base/fallback file。累计 UTF-8 bytes，直到 project_doc_max_bytes，并报告 truncation。仅当 local memory metadata 可关联到已注册 repository 时才检查它；绝不将无关 memories 分类为 team candidates。

- [ ] **步骤 4：运行 Adapter 和完整测试**

运行：npm test -- --run tests/adapters/codex.test.ts && npm run verify

预期：全部通过，load order 与官方 precedence fixture 匹配。

- [ ] **步骤 5：提交**

~~~bash
git add src/adapters tests/adapters tests/fixtures/codex-*
git commit -m "feat: discover codex context sources"
~~~

### 任务 8：通过 Skill 暴露 inspect 和 doctor

**文件：**
- 创建：src/commands/inspect.ts
- 创建：src/commands/doctor.ts
- 修改：src/main.ts
- 修改：skill/agent-context-sync/SKILL.md
- 测试：tests/integration/inspect-doctor.test.ts
- 测试：tests/e2e/v01-skill.test.ts
- 创建：README.md

**接口：**
- 使用：adapterFor、local registry 和 Workspace manifest
- 产出：inspect(input: InspectInput): Promise<CoverageReport[]>
- 产出：doctor(input: DoctorInput): Promise<DoctorReport>

- [ ] **步骤 1：编写失败的 end-to-end 测试**

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

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/integration/inspect-doctor.test.ts tests/e2e/v01-skill.test.ts

预期：FAIL，因为 inspect 和 doctor 尚未 dispatch。

- [ ] **步骤 3：实现 reports 和 Skill instructions**

inspect 必须是只读的，并为每个请求的 repository 返回一份 report。doctor 检查 Node version、Git availability、Context remote reachability、registry validity、repository path drift、Adapter version support 和 permissions。更新 SKILL.md，加入精确的 preview/apply invocations、一次只问一个问题的 approval language，以及明确禁止将 unknown coverage 解读为 complete。

README 必须记录如何安装到 ~/.codex/skills/agent-context-sync 和 ~/.claude/skills/agent-context-sync、virtual Workspace model、supported Agents，以及 v0.1 command examples。

- [ ] **步骤 4：运行 v0.1 acceptance suite**

运行：npm run verify && npm test -- --run tests/e2e/v01-skill.test.ts

预期：typecheck 和所有测试通过；end-to-end fixture 会初始化一个双 repository Workspace，在仅有一个 repository 存在的情况下 join，并在不修改任一 business repository 的情况下输出 Claude 和 Codex coverage reports。

- [ ] **步骤 5：提交**

~~~bash
git add src/commands src/main.ts skill README.md tests/integration tests/e2e
git commit -m "feat: deliver workspace discovery skill"
~~~

## v0.1 完成门槛

运行：

~~~bash
npm ci
npm run verify
git status --short
~~~

预期：

- Build、typecheck、unit、Adapter contract、integration 和 v0.1 end-to-end tests 通过。
- git status 是 clean，除了有意忽略的本地测试 artifacts。
- init、join、add-repo、inspect 和 doctor 已文档化，并可通过 Skill launcher 调用。
- acceptance test 期间没有 business repository commit 或文件内容变化。
