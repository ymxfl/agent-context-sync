# Agent Context Sync v0.2 知识同步与编译实现计划

> **面向智能体执行者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤使用 checkbox（- [ ]）跟踪。

**目标：** 将已审阅的 Agent 提案转换为结构化的、由 Git 支持的知识，并以确定性方式将适用知识编译到受跟踪的 AGENTS.md 和 CLAUDE.md 文件中。

**架构：** 发现输出会成为不可变的提取包。当前活动的 Agent 写入受 schema 约束的提案；确定性代码负责验证、预览、存储、发布、编译，并以原子方式应用该提案。预览 ID 会将每次批准绑定到精确的 Context 和业务仓库状态，从而避免过期批准执行写入。

**技术栈：** v0.1 的 Node.js 20+/TypeScript/Vitest 技术栈，加上来自 Zod 的 JSON Schema 导出、SHA-256 源哈希、用于 unified diff 的 diff package，以及现有的安全 Git wrapper。

## 全局约束

- 完成 v0.1，并保持所有 v0.1 验收测试通过。
- Context Git 是唯一事实来源；生成的 Agent 文件是派生的、受跟踪的业务仓库文件。
- 知识 kind 是开放的 kebab-case；行为不得依赖封闭的 kind enum。
- 共享来源不得包含绝对本地路径或未选中的 private-memory 副本。
- 每次 Context 或业务仓库写入都需要未过期的预览和明确的用户批准。
- Context Git 可在批准后 commit 和 push；业务仓库绝不能由工具 commit 或 push。
- 已知活动冲突会导致编译失败，而不是按时间戳解决。
- 相同输入和 Context commit 必须产生字节完全一致的输出。

---

## 文件映射

- src/schema/knowledge.ts：规范 KnowledgeEntry 和关系验证。
- src/schema/extraction.ts：Agent 提案和拒绝 schema。
- src/knowledge/store.ts：每个 Markdown 一个条目的持久化。
- src/knowledge/graph.ts：supersedes/conflicts 图和活动集合验证。
- src/security/redact.ts：secret 和本地路径检测。
- src/extraction/packet.ts：不可变发现包创建。
- src/extraction/proposal.ts：提案验证、去重和预览。
- src/git/context-publisher.ts：fast-forward 预检、commit 和 push。
- src/compiler/select.ts：scope/path/agent 选择。
- src/compiler/compile.ts：确定性 section 模型。
- src/adapters/claude/render.ts 和 src/adapters/codex/render.ts：原生渲染器。
- src/apply/preview.ts 和 src/apply/atomic-apply.ts：diff、drift 检查和原子替换。
- src/commands/capture.ts、apply.ts、sync.ts：暴露给 Skill 的工作流。

### 任务 1：定义规范知识和提取 schema

**文件：**
- 新建：src/schema/knowledge.ts
- 新建：src/schema/extraction.ts
- 新建：tests/schema/knowledge.test.ts
- 新建：tests/schema/extraction.test.ts
- 修改：src/domain/model.ts

**接口：**
- 产出：KnowledgeEntry, KnowledgeStatus, KnowledgeScope, SourceReference
- 产出：ExtractionProposal, ProposedKnowledge, RejectedCandidate
- 产出：parseKnowledgeEntry(value: unknown): KnowledgeEntry
- 产出：parseExtractionProposal(value: unknown): ExtractionProposal

- [ ] **步骤 1：编写失败的开放 kind 和关系测试**

~~~ts
expect(parseKnowledgeEntry({
  schema_version: 1,
  id: 'kn_01J00000000000000000000000',
  kind: 'database-failure-mode',
  scope: 'repository:github.com/acme/api',
  status: 'active',
  applies_to: { paths: ['src/db/**'], agents: ['claude-code', 'codex'] },
  source: { agent: 'claude-code', source_type: 'auto-memory', locator: 'memory/MEMORY.md', content_hash: hash, observed_at: now },
  confidence: 0.9,
  supersedes: [],
  conflicts_with: [],
  created_at: now,
  updated_at: now,
  last_verified_at: null,
  statement: 'Use WAL only in a single writer process.',
  reason: 'Multiple writers produced SQLITE_BUSY.',
}).kind).toBe('database-failure-mode');

expect(() => parseKnowledgeEntry({ ...valid, kind: 'Bad Kind' })).toThrow();
expect(() => parseExtractionProposal({ ...proposal, accepted: [], rejected: [] })).not.toThrow();
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/schema/knowledge.test.ts tests/schema/extraction.test.ts

预期：FAIL，因为 schema 尚不存在。

- [ ] **步骤 3：实现严格 schema**

使用字面量 schema_version 1。Knowledge status 为 active、superseded、archived 或 disputed。Scope 为 workspace 或 repository:<repo-id>。kind 匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/。Agent 名称是开放字符串，但 MVP 渲染器识别 claude-code 和 codex。将 statement 和 reason 存储为 schema 字段，使验证无需解析 Markdown 标题。

- [ ] **步骤 4：运行聚焦测试和回归测试**

运行：npm test -- --run tests/schema && npm run verify

预期：所有 v0.1 和新的 schema 测试通过。

- [ ] **步骤 5：Commit**

~~~bash
git add src/schema src/domain/model.ts tests/schema
git commit -m "feat: define structured knowledge proposals"
~~~

### 任务 2：将知识存储为规范 Markdown

**文件：**
- 新建：src/knowledge/markdown.ts
- 新建：src/knowledge/store.ts
- 新建：src/knowledge/graph.ts
- 测试：tests/knowledge/store.test.ts
- 测试：tests/knowledge/graph.test.ts

**接口：**
- 消费：KnowledgeEntry
- 产出：serializeKnowledge(entry: KnowledgeEntry): string
- 产出：parseKnowledgeMarkdown(text: string): KnowledgeEntry
- 产出：KnowledgeStore.list(), get(id), put(entry)
- 产出：validateKnowledgeGraph(entries: KnowledgeEntry[]): GraphIssue[]

- [ ] **步骤 1：编写失败的往返和图测试**

~~~ts
const text = serializeKnowledge(entry);
expect(parseKnowledgeMarkdown(text)).toEqual(entry);
expect(text).not.toContain('/Users/alice');

expect(validateKnowledgeGraph([
  { ...a, supersedes: [b.id] },
  { ...b, supersedes: [a.id] },
])).toContainEqual(expect.objectContaining({ code: 'SUPERSEDES_CYCLE' }));
~~~

同时断言 ID 决定路径、archived 条目不会被移动，并且 conflicts_with 关系在规范化后是对称的。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/knowledge

预期：FAIL，因为存储模块尚不存在。

- [ ] **步骤 3：实现确定性序列化和图检查**

排序 frontmatter key 和数组，使用 LF 行尾并保留一个最终换行。将 workspace 条目映射到 knowledge/workspace/<id>.md，将 repository 条目映射到 knowledge/repositories/<repo-id>/<id>.md。拒绝重复 ID、缺失的关系目标、自引用关系、supersedes 循环，以及被缺失知识 supersede 的 active 条目。

- [ ] **步骤 4：验证聚焦测试和完整测试**

运行：npm test -- --run tests/knowledge && npm run verify

预期：全部通过，且重复序列化得到字节完全一致的结果。

- [ ] **步骤 5：Commit**

~~~bash
git add src/knowledge tests/knowledge
git commit -m "feat: persist canonical knowledge markdown"
~~~

### 任务 3：构建安全的提取包和脱敏

**文件：**
- 新建：src/security/redact.ts
- 新建：src/extraction/packet.ts
- 新建：tests/security/redact.test.ts
- 新建：tests/extraction/packet.test.ts

**接口：**
- 消费：CoverageReport[] 和现有 KnowledgeEntry[]
- 产出：redactCandidate(value: string, localRoots: string[]): RedactionResult
- 产出：createExtractionPacket(input: PacketInput): ExtractionPacket
- ExtractionPacket 包含 packet_id、context_head、source hashes、selected excerpts、existing summaries 和 JSON output contract

- [ ] **步骤 1：编写失败的 secret 和不可变性测试**

~~~ts
expect(redactCandidate('token=ghp_abcdefghijklmnopqrstuvwxyz123456', roots).redacted)
  .toContain('[REDACTED_SECRET]');
expect(redactCandidate('/Users/alice/work/api/src/a.ts', roots).redacted)
  .toContain('[REPOSITORY_ROOT]/src/a.ts');

const packet = createExtractionPacket(input);
expect(packet.sources[0]).not.toHaveProperty('absolutePath');
expect(Object.isFrozen(packet)).toBe(true);
expect(packet.packet_hash).toMatch(/^sha256:/);
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/security tests/extraction/packet.test.ts

预期：FAIL，因为 packet 和 redaction 模块缺失。

- [ ] **步骤 3：实现保守脱敏和 packet 哈希**

检测 private key headers、常见 token 前缀、credential URLs、赋值风格 secrets，以及已注册的绝对根路径。仅保留 source locator、line range、content hash 和 selected excerpt。哈希前规范化 packet JSON，并对返回的 packet 进行 deep-freeze。

- [ ] **步骤 4：运行聚焦测试和完整测试**

运行：npm test -- --run tests/security tests/extraction && npm run verify

预期：全部通过，且 snapshots 不包含 fixture secrets 或绝对路径。

- [ ] **步骤 5：Commit**

~~~bash
git add src/security src/extraction tests/security tests/extraction
git commit -m "feat: prepare redacted extraction packets"
~~~

### 任务 4：验证 Agent 提案并预览知识变更

**文件：**
- 新建：src/extraction/proposal.ts
- 新建：src/preview/store.ts
- 新建：src/commands/capture.ts
- 修改：src/main.ts
- 测试：tests/extraction/proposal.test.ts
- 测试：tests/integration/capture-preview.test.ts

**接口：**
- 产出：prepareCapture(input: CaptureInput): Promise<ExtractionPacket>
- 产出：previewCapture(packetId: string, proposal: unknown): Promise<CapturePreview>
- 产出：带有 preview_id、packet_hash、context_head、creates、updates、archives、rejections、warnings 的 CapturePreview

- [ ] **步骤 1：编写失败的去重和过期提案测试**

~~~ts
const preview = await previewCapture(packet.packet_id, proposal);
expect(preview.creates).toHaveLength(1);
expect(preview.duplicates).toContainEqual(expect.objectContaining({ existing_id: existing.id }));

expect(preview.context_head).toBe(packet.context_head);
expect(preview.packet_hash).toBe(packet.packet_hash);
~~~

同时拒绝引用其 packet 中不存在的 source hash 的提案，或在没有明确 include_personal 批准时尝试共享标记为 personal 的候选项的提案。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/extraction/proposal.test.ts tests/integration/capture-preview.test.ts

预期：FAIL，因为 proposal previewing 尚不存在。

- [ ] **步骤 3：实现提案规范化和预览存储**

先使用精确的 source hashes，再使用规范化的 statement hashes 来确定性识别重复候选项。MVP 中绝不使用 model embeddings。以 mode 0o600 将 previews 存储在 local home 下；绑定 packet hash、Context HEAD、proposed file bytes 和 24 小时过期时间。previewCapture 不写入任何 Context 文件。在此任务中将 diff 添加为 runtime dependency，并将其锁定到 package-lock.json。

- [ ] **步骤 4：运行聚焦测试和回归测试**

运行：npm test -- --run tests/extraction tests/integration/capture-preview.test.ts && npm run verify

预期：全部通过，且预览后 Context Git 保持 clean。

- [ ] **步骤 5：Commit**

~~~bash
git add src/extraction src/preview src/commands/capture.ts src/main.ts tests
git commit -m "feat: preview agent knowledge proposals"
~~~

### 任务 5：安全发布已批准知识

**文件：**
- 新建：src/git/context-publisher.ts
- 修改：src/commands/capture.ts
- 测试：tests/git/context-publisher.test.ts
- 测试：tests/integration/capture-apply.test.ts

**接口：**
- 消费：任务 4 的 CapturePreview 和任务 2 的 KnowledgeStore
- 产出：applyCapture(previewId: string): Promise<PublishResult>
- 产出：ContextRemoteState { head, upstream, ahead, behind, diverged }

- [ ] **步骤 1：编写失败的 fast-forward 和 race 测试**

~~~ts
const result = await applyCapture(preview.preview_id);
expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
expect(await remoteContains(result.commit)).toBe(true);

await createRemoteCommitFromOtherClone();
await expect(applyCapture(otherPreview.preview_id)).rejects.toMatchObject({
  code: 'STALE_PREVIEW',
});
expect(await currentBranchWasForcePushed()).toBe(false);
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/git/context-publisher.test.ts tests/integration/capture-apply.test.ts

预期：FAIL，因为 publication 缺失。

- [ ] **步骤 3：实现 fetch/preflight/write/commit/push**

写入前先 fetch。仅 behind 时执行 fast-forward，拒绝 divergence，然后根据 preview 重新计算 HEAD。以原子方式写入所有知识文件，验证整个图，仅 stage workspace.yaml、repositories、knowledge、sources 和 schema paths，创建一个语义化 commit，并在不 force 的情况下 push。发生 push race 时，保留本地 commit，并返回 REMOTE_CHANGED 及恢复指导。

- [ ] **步骤 4：运行 Git 和完整验证**

运行：npm test -- --run tests/git tests/integration/capture-apply.test.ts && npm run verify

预期：ahead、behind、diverged、auth-error fixture 和 push-race 场景全部通过。

- [ ] **步骤 5：Commit**

~~~bash
git add src/git src/commands/capture.ts tests/git tests/integration/capture-apply.test.ts
git commit -m "feat: publish approved context knowledge"
~~~

### 任务 6：选择并编译适用知识

**文件：**
- 新建：src/compiler/select.ts
- 新建：src/compiler/compile.ts
- 新建：src/compiler/conflicts.ts
- 测试：tests/compiler/select.test.ts
- 测试：tests/compiler/compile.test.ts

**接口：**
- 产出：selectKnowledge(input: SelectionInput): KnowledgeEntry[]
- 产出：detectActiveConflicts(entries: KnowledgeEntry[]): CompileConflict[]
- 产出：compileSections(input: CompileInput): CompiledContext

- [ ] **步骤 1：编写失败的 scope 和 conflict 测试**

~~~ts
const selected = selectKnowledge({
  entries,
  repoId: 'github.com/acme/api',
  agent: 'codex',
  relativePath: 'src/auth/session.ts',
});
expect(selected.map((item) => item.id)).toEqual([workspaceRule.id, repoRule.id, pathRule.id]);

expect(() => compileSections({ entries: conflicting, target })).toThrowError(
  expect.objectContaining({ code: 'ACTIVE_KNOWLEDGE_CONFLICT' }),
);
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/compiler

预期：FAIL，因为 compiler modules 尚不存在。

- [ ] **步骤 3：实现确定性选择和 section 排序**

排除非 active 条目和 target-agent 不匹配项。使用 repository-relative POSIX globs 匹配路径。排序顺序为 Workspace、Repository、path-specific、Agent-specific，然后 active-work；section 内按稳定 ID 排序。当 active conflicts 缺少 supersedes resolution 或指向 disputed knowledge 时失败。

- [ ] **步骤 4：运行 compiler 和完整测试**

运行：npm test -- --run tests/compiler && npm run verify

预期：全部通过，且 100-run determinism assertion 只产生一个唯一 SHA-256。

- [ ] **步骤 5：Commit**

~~~bash
git add src/compiler tests/compiler
git commit -m "feat: compile scoped agent context"
~~~

### 任务 7：渲染原生 Claude 和 Codex 文件

**文件：**
- 新建：src/adapters/claude/render.ts
- 新建：src/adapters/codex/render.ts
- 修改：src/adapters/adapter.ts
- 测试：tests/adapters/claude-render.test.ts
- 测试：tests/adapters/codex-render.test.ts
- 新建：tests/fixtures/render-golden/
- 新建：tests/helpers/golden.ts

**接口：**
- 产出：render(input: RenderInput): RenderedFile[]
- RenderedFile 包含 relativePath、bytes、sha256、sourceKnowledgeIds
- 产出：goldenFiles(agent: 'claude' | 'codex'): Promise<RenderedFile[]>

- [ ] **步骤 1：编写失败的 golden 测试**

~~~ts
expect(renderClaude(input)).toEqual(await goldenFiles('claude'));
expect(renderCodex(input)).toEqual(await goldenFiles('codex'));
expect(renderCodex(input)[0].bytes.byteLength).toBeLessThanOrEqual(32768);
expect(decode(renderClaude(input)[0].bytes)).not.toContain('@AGENTS.md');
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/adapters/*-render.test.ts

预期：FAIL，因为 renderers 尚不存在。

- [ ] **步骤 3：实现完整原生渲染**

两个 root 文件都包含 generated warning、Workspace ID、Context commit、content hash 和简洁 sections。绝不包含 source absolute paths。当 root 超过配置的 max bytes 时，Codex 会将 path-scoped 内容拆分到嵌套的 AGENTS.md。Claude 会为 path-scoped knowledge 输出 .claude/rules/<stable-scope-id>.md，并尽可能将 CLAUDE.md 控制在 200 行以内。不要让 CLAUDE.md import AGENTS.md，因为两者都是完整投影。

- [ ] **步骤 4：运行 golden 和完整测试**

运行：npm test -- --run tests/adapters tests/compiler && npm run verify

预期：全部通过，且 golden files 使用 LF 行尾并有一个最终换行。

- [ ] **步骤 5：Commit**

~~~bash
git add src/adapters tests/adapters tests/fixtures/render-golden
git commit -m "feat: render native agent guidance"
~~~

### 任务 8：预览并原子应用生成文件

**文件：**
- 新建：src/apply/preview.ts
- 新建：src/apply/atomic-apply.ts
- 新建：src/apply/drift.ts
- 新建：src/commands/apply.ts
- 新建：src/commands/sync.ts
- 修改：src/main.ts
- 修改：skill/agent-context-sync/SKILL.md
- 测试：tests/integration/apply.test.ts
- 测试：tests/e2e/v02-sync.test.ts

**接口：**
- 产出：previewApply(input: ApplyInput): Promise<ApplyPreview>
- 产出：applyRendered(previewId: string): Promise<ApplyResult>
- 产出：syncPrepare(input: SyncInput): Promise<ExtractionPacket>
- ApplyPreview 包含 Context HEAD、business HEADs、完整 unified diffs、generated hashes 和 drift candidates

- [ ] **步骤 1：编写失败的 drift 和端到端测试**

~~~ts
const preview = await previewApply({ workspaceId, agents: ['claude-code', 'codex'] });
expect(preview.files.map((file) => file.relativePath)).toContain('AGENTS.md');
expect(preview.files.map((file) => file.relativePath)).toContain('CLAUDE.md');
expect(await fs.readFile(existingAgents, 'utf8')).toBe(original);

await fs.appendFile(existingAgents, '\nmanual edit\n');
await expect(applyRendered(preview.preview_id)).rejects.toMatchObject({ code: 'TARGET_DRIFT' });
expect(await businessGitLog()).toEqual(beforeLog);
~~~

e2e 测试必须捕获 Claude knowledge，发布 Context Git，从带有一个 repository 的第二个 home 加入，渲染 Codex，添加 Codex knowledge，发布，并在第一个 home 上重新渲染 Claude。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/integration/apply.test.ts tests/e2e/v02-sync.test.ts

预期：FAIL，因为 apply 和 sync 缺失。

- [ ] **步骤 3：实现 preview、atomic replacement 和 Skill workflow**

显示 diff 前，将所有 repositories 编译到 temporary directories。将 previews 绑定到 Context HEAD、business HEAD 和当前 target hashes。如果某个 target 与其 prior generated hash 不同，则将其 diff 作为 capture candidate 返回，并拒绝覆盖。批准后，在 local home 下写入 backups，fsync temporary files，按 repository rename，并在第一个 repository failure 后停止，同时返回 completed/pending lists。绝不在业务仓库中运行 git add 或 commit。

更新 SKILL.md，使 sync 执行 prepare-capture，要求 Agent 提供 schema JSON，预览 capture，获得批准，应用并 push Context Git，预览 render，获得批准，然后应用 business files。

- [ ] **步骤 4：运行 v0.2 验收套件**

运行：npm run verify && npm test -- --run tests/e2e/v02-sync.test.ts

预期：所有测试通过；Context remote 包含 knowledge commits；两个业务仓库都包含未提交但受跟踪的 AGENTS.md 和 CLAUDE.md 变更；两个 business log 均无变化。

- [ ] **步骤 5：Commit**

~~~bash
git add src/apply src/commands src/main.ts skill tests/integration tests/e2e
git commit -m "feat: deliver reviewed cross-agent context sync"
~~~

## v0.2 完成门禁

运行：

~~~bash
npm ci
npm run verify
npm test -- --run tests/e2e/v02-sync.test.ts
git status --short
~~~

预期：

- 所有 v0.1 和 v0.2 测试通过。
- Claude-to-Codex 和 Codex-to-Claude 流程已通过两个 homes 和一个 bare Context remote 验证。
- 当 preview 过期时，Context writes 和 business file writes 会失败。
- Active conflicts 和手动编辑过的 generated files 绝不会被静默覆盖。
- 业务仓库不包含工具创建的 commits。
