# Agent Context Sync v0.3 验证和实验性发现实施计划

> **面向智能体执行者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现本计划。步骤使用 checkbox（- [ ]）跟踪。

**目标：** 根据代码证据验证共享知识，安全解决知识层面的并发问题，并可选择跟踪 Agent 文件访问，以发现稳定 Adapter 中缺失的上下文来源。

**架构：** 确定性收集器准备有界证据包；活动 Agent 返回受 schema 约束的验证或合并提案；preview/apply 门控仍然是唯一写入路径。实验性 tracing 基于 provider，默认禁用，只记录路径元数据，并且绝不能自动改变稳定 Adapter 覆盖范围。

**技术栈：** v0.2 TypeScript/Vitest 栈、ripgrep 子进程集成、Git 历史证据、面向 macOS fs_usage 和 Linux strace 的平台特定 trace 解析器，以及由 fixture 驱动的解析器。

## 全局约束

- 完成 v0.2 并保留所有先前的验收套件。
- check 在没有经过审查且非过期的 preview 时，绝不更改知识。
- 每个验证结论都引用一个已存在的仓库相对路径、行范围、依赖记录或 Git commit。
- unverifiable 是有效结果，且不得转换为 stale。
- 实验性 tracing 按每次运行选择启用，不存储任何文件内容，且失败绝不阻塞稳定发现。
- 不进行自动 force push、业务 commit、业务 push 或破坏性 Git 操作。
- 限制证据大小和命令持续时间，避免大型 Workspace 耗尽 Agent 上下文。

---

## 文件映射

- src/schema/verification.ts: 验证提案和证据 schema。
- src/verification/collect.ts: 有界代码/config/dependency/Git 证据。
- src/verification/proposal.ts: 校验 Agent 结论并预览变更。
- src/commands/check.ts: 准备、预览并应用 check 工作流。
- src/merge/knowledge-merge.ts: 条目的三方合并和语义冲突包。
- src/commands/reconcile.ts: 无需 force 即可解决分歧的 Context 分支。
- src/tracing/provider.ts: 实验性 provider 合约。
- src/tracing/macos-fs-usage.ts: macOS 解析器和运行器。
- src/tracing/linux-strace.ts: Linux 解析器和运行器。
- src/tracing/classify.ts: 上下文路径候选过滤器。
- src/commands/trace.ts: 显式选择启用的 trace 工作流。
- src/performance/cache.ts: 以 hash 为键的发现和证据缓存。

### 任务 1：定义验证证据和提案 schema

**文件：**
- 创建：src/schema/verification.ts
- 创建：tests/schema/verification.test.ts
- 修改：src/domain/model.ts

**接口：**
- 产生：VerificationStatus = valid | stale | contradicted | unverifiable
- 产生：EvidenceRef, VerificationFinding, VerificationProposal
- 产生：parseVerificationProposal(value: unknown): VerificationProposal

- [ ] **步骤 1：编写失败的证据校验测试**

~~~ts
expect(parseVerificationProposal({
  schema_version: 1,
  packet_id: 'packet_01J00000000000000000000000',
  packet_hash: hash,
  findings: [{
    knowledge_id: knowledge.id,
    status: 'contradicted',
    explanation: 'The package now uses Prisma.',
    evidence: [{ type: 'file', repo_id: repoId, path: 'package.json', start_line: 12, end_line: 12, content_hash: hash }],
    proposed_action: { type: 'supersede', statement: 'Use Prisma for persistence.', reason: 'The active dependency and code imports use Prisma.' },
  }],
})).toBeTruthy();

expect(() => parseVerificationProposal({
  ...proposal,
  findings: [{ ...finding, status: 'stale', evidence: [] }],
})).toThrow(/evidence/i);
~~~

unverifiable 结论可以没有证据，但必须包含 attempted_checks。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/schema/verification.test.ts

预期：FAIL，因为 schema 不存在。

- [ ] **步骤 3：实现严格的验证 schema**

证据类型为 file、dependency、config 和 git-commit。文件路径是仓库相对 POSIX 路径；行号为正数且有序；commit 是 40 位小写十六进制字符。提议的 action 为 none、update、supersede 或 archive。valid 不能提议 mutation；stale 和 contradicted 必须提议带理由的 mutation 或显式 none。

- [ ] **步骤 4：运行 schema 和完整回归测试**

运行：npm test -- --run tests/schema && npm run verify

预期：全部通过。

- [ ] **步骤 5：提交**

~~~bash
git add src/schema/verification.ts src/domain/model.ts tests/schema/verification.test.ts
git commit -m "feat: define rule verification contracts"
~~~

### 任务 2：收集有界代码和 Git 证据

**文件：**
- 创建：src/verification/collect.ts
- 创建：src/verification/dependencies.ts
- 创建：src/verification/git-evidence.ts
- 创建：tests/verification/collect.test.ts
- 创建：tests/fixtures/verification-repo/

**接口：**
- 产生：collectEvidence(input: EvidenceInput): Promise<VerificationPacket>
- VerificationPacket 包含 knowledge、searches、files、dependencies、configs、commits、limits、packet_hash

- [ ] **步骤 1：编写失败的有界收集测试**

~~~ts
const packet = await collectEvidence({
  entry,
  repositoryPath: fixture,
  limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 5_000 },
});
expect(packet.files.some((file) => file.path === 'package.json')).toBe(true);
expect(packet.dependencies).toContainEqual(expect.objectContaining({ name: 'prisma' }));
expect(packet.total_bytes).toBeLessThanOrEqual(200_000);
expect(packet.files.every((file) => !path.isAbsolute(file.path))).toBe(true);
~~~

添加一个包含被忽略 secrets 和命令超时的 fixture；断言 truncation 和 timeout 会被报告，而不是作为通用错误抛出。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/verification/collect.test.ts

预期：FAIL，因为收集器不存在。

- [ ] **步骤 3：实现证据收集**

从 knowledge statement、reason 和 applies_to 路径派生保守的固定字符串搜索词，然后使用参数数组运行 rg。只读取真实仓库根目录内的文本文件，遵守 .gitignore，遮蔽 secrets，解析受支持的依赖 manifest，并包含有界的 git log/blame 数据。对证据包进行规范化并计算 hash。

- [ ] **步骤 4：运行聚焦测试和完整测试**

运行：npm test -- --run tests/verification && npm run verify

预期：全部通过；超时 fixture 在 10 秒内完成。

- [ ] **步骤 5：提交**

~~~bash
git add src/verification tests/verification tests/fixtures/verification-repo
git commit -m "feat: collect bounded rule evidence"
~~~

### 任务 3：实现经过审查的 check 工作流

**文件：**
- 创建：src/verification/proposal.ts
- 创建：src/commands/check.ts
- 修改：src/main.ts
- 修改：skill/agent-context-sync/SKILL.md
- 测试：tests/integration/check.test.ts

**接口：**
- 产生：prepareCheck(input: CheckInput): Promise<VerificationPacket[]>
- 产生：previewCheck(packetIds: string[], proposal: unknown): Promise<CheckPreview>
- 产生：applyCheck(previewId: string): Promise<PublishResult>

- [ ] **步骤 1：编写失败的证据解析和批准测试**

~~~ts
const preview = await previewCheck([packet.packet_id], proposal);
expect(preview.changes.supersede).toHaveLength(1);
expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });

await applyCheck(preview.preview_id);
expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'superseded' });
expect((await knowledgeStore.list()).some((item) => item.statement === 'Use Prisma for persistence.')).toBe(true);
~~~

同时断言不存在的 evidence paths、已变化的 evidence hashes 和已变化的 Context HEAD 会返回 INVALID_EVIDENCE 或 STALE_PREVIEW，且不写入。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/integration/check.test.ts

预期：FAIL，因为 check 不存在。

- [ ] **步骤 3：实现 prepare/preview/apply 和 Skill 指引**

prepareCheck 按 scope 选择 active knowledge 并创建证据包。previewCheck 基于当前仓库解析每个 evidence reference，并验证 hashes/commits。applyCheck 将已批准的 update、supersede 和 archive actions 转换为 KnowledgeEntry changes，并使用现有 Context publisher；随后返回 required_apply flag，且不触碰业务文件。

SKILL.md 必须指示 Agent 不要仅根据时间推断 stale，并在 evidence 不足时使用 unverifiable。

- [ ] **步骤 4：运行 check 和回归套件**

运行：npm test -- --run tests/integration/check.test.ts && npm run verify

预期：全部通过，且在单独的 apply preview 获批之前，业务仓库保持不变。

- [ ] **步骤 5：提交**

~~~bash
git add src/verification/proposal.ts src/commands/check.ts src/main.ts skill tests/integration/check.test.ts
git commit -m "feat: verify and review stale context rules"
~~~

### 任务 4：在知识层面调和分歧的 Context Git 历史

**文件：**
- 创建：src/merge/knowledge-merge.ts
- 创建：src/commands/reconcile.ts
- 修改：src/main.ts
- 测试：tests/merge/knowledge-merge.test.ts
- 测试：tests/integration/reconcile.test.ts

**接口：**
- 产生：threeWayKnowledgeMerge(base, local, remote): MergeResult
- 产生：prepareReconcile(input: ReconcileInput): Promise<ReconcilePacket>
- 产生：previewReconcile(packetId: string, proposal: unknown): Promise<ReconcilePreview>
- 产生：applyReconcile(previewId: string): Promise<PublishResult>

- [ ] **步骤 1：编写失败的合并分类测试**

~~~ts
expect(threeWayKnowledgeMerge(base, localAddsA, remoteAddsB)).toMatchObject({
  automatic: expect.arrayContaining([a.id, b.id]),
  conflicts: [],
});

expect(threeWayKnowledgeMerge(base, localEditsA, remoteEditsA).conflicts)
  .toContainEqual(expect.objectContaining({ knowledge_id: a.id, type: 'SAME_ENTRY_EDIT' }));
~~~

为相互竞争的 supersedes 关系、显式 conflicts_with 关系，以及同一条目上的同时 status 变更添加确定性 conflicts。不同 IDs 之间潜在的语义矛盾会包含在 Agent reconciliation packet 中，绝不静默自动合并。

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/merge tests/integration/reconcile.test.ts

预期：FAIL，因为合并支持不存在。

- [ ] **步骤 3：实现安全的三方 reconciliation**

使用 merge base 并解析全部三个 Knowledge stores。自动合并不同 IDs 和字节完全相同的 edits。为语义冲突发出一个 schema packet；Agent 可以选择 local、remote、合并为新 entry，或标记为 disputed。Apply 创建普通 merge 或 reconciliation commit，并且只在重新 fetch 后 push。绝不 force push 或重写已发布历史。

- [ ] **步骤 4：运行合并和完整测试**

运行：npm test -- --run tests/merge tests/integration/reconcile.test.ts && npm run verify

预期：全部通过；remote history 保留两个 parent commits。

- [ ] **步骤 5：提交**

~~~bash
git add src/merge src/commands/reconcile.ts src/main.ts tests/merge tests/integration/reconcile.test.ts
git commit -m "feat: reconcile context knowledge conflicts"
~~~

### 任务 5：添加可选启用的运行时 Context Tracing

**文件：**
- 创建：src/tracing/provider.ts
- 创建：src/tracing/macos-fs-usage.ts
- 创建：src/tracing/linux-strace.ts
- 创建：src/tracing/classify.ts
- 创建：src/commands/trace.ts
- 修改：src/main.ts
- 测试：tests/tracing/macos-fs-usage.test.ts
- 测试：tests/tracing/linux-strace.test.ts
- 测试：tests/tracing/classify.test.ts
- 创建：tests/fixtures/tracing/

**接口：**
- 产生：TraceProvider.isAvailable(), start(command, args), stop()
- 产生：TraceEvent { timestamp, pid, operation, path }
- 产生：classifyTrace(events, stableReport): TraceCandidate[]

- [ ] **步骤 1：编写失败的解析器和隐私测试**

~~~ts
expect(parseFsUsage(fixture)).toContainEqual(expect.objectContaining({
  operation: 'open',
  path: '/tmp/repo/CLAUDE.md',
}));
expect(parseStrace(fixture)).toContainEqual(expect.objectContaining({
  operation: 'openat',
  path: '/tmp/repo/AGENTS.md',
}));

const candidates = classifyTrace(events, stableReport);
expect(candidates.map((item) => item.path)).toContain('/tmp/repo/custom.rules');
expect(JSON.stringify(candidates)).not.toContain('file contents');
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/tracing

预期：FAIL，因为 tracing 模块不存在。

- [ ] **步骤 3：实现 provider 门控的 tracing**

macOS 仅在已安装并授权时使用 fs_usage；Linux 仅在已安装 strace 且允许 ptrace 时使用 strace；Windows 在 v0.3 返回 unavailable。要求 --experimental 和 --consent-path-metadata 标志。只捕获已启动 Agent 进程树的 open/stat/readlink 风格路径事件，限制运行时间和事件数量，丢弃已由普通仓库读取解释的代码路径，并返回未知上下文候选。在用户稍后运行稳定的 inspect/capture 之前，不读取候选内容。

- [ ] **步骤 4：运行解析器、可用性和完整测试**

运行：npm test -- --run tests/tracing && npm run verify

预期：fixture 测试在所有平台通过；live-provider 冒烟测试在 unavailable 时以明确原因跳过。

- [ ] **步骤 5：提交**

~~~bash
git add src/tracing src/commands/trace.ts src/main.ts tests/tracing tests/fixtures/tracing
git commit -m "feat: trace unknown context sources experimentally"
~~~

### 任务 6：添加缓存、完整 MVP 验收和运维文档

**文件：**
- 创建：src/performance/cache.ts
- 修改：src/verification/collect.ts
- 修改：src/commands/inspect.ts
- 修改：src/commands/doctor.ts
- 修改：README.md
- 创建：docs/operations.md
- 创建：tests/performance/large-workspace.test.ts
- 创建：tests/e2e/mvp-acceptance.test.ts

**接口：**
- 产生：ContentCache.get(key), put(key, value), invalidateByHead(repositoryId, head)
- 消费 v0.1-v0.3 的所有公开命令接口

- [ ] **步骤 1：编写失败的大型 Workspace 和最终验收测试**

~~~ts
const first = await inspectLargeWorkspace(fixture);
const second = await inspectLargeWorkspace(fixture);
expect(second.stats.files_read).toBeLessThan(first.stats.files_read);
expect(second.reports).toEqual(first.reports);

const result = await runMvpScenario();
expect(result).toMatchObject({
  workspaceRepositories: 10,
  memberBRepositories: 5,
  claudeToCodex: 'pass',
  codexToClaude: 'pass',
  staleRuleCheck: 'pass',
  divergentContextReconcile: 'pass',
  businessCommitsCreatedByTool: 0,
});
~~~

- [ ] **步骤 2：运行测试并验证失败**

运行：npm test -- --run tests/performance/large-workspace.test.ts tests/e2e/mvp-acceptance.test.ts

预期：FAIL，因为缓存和完整场景不存在。

- [ ] **步骤 3：实现以 hash 为键的缓存并完成 docs**

按 Adapter version、config hash、repository HEAD、target path 和相关 file mtimes 缓存 discovery；按 knowledge hash 和 repository HEAD 缓存 verification evidence。使用有界大小和原子写入在本地存储 cache。doctor 报告 cache corruption 并可建议移除，但未经批准不会移除。

README 记录安装和日常 workflows。docs/operations.md 记录 backup、Context remote migration、schema compatibility、resolving divergence、generated-file drift、privacy boundaries 和 experimental trace consent。

- [ ] **步骤 4：运行最终验证**

运行：npm ci && npm run verify && npm test -- --run tests/e2e/mvp-acceptance.test.ts

预期：每个测试都通过；大型 Workspace 测试在 test fixture 上 30 秒内完成；完整场景创建 Context commits 但不创建 business commits。

- [ ] **步骤 5：提交**

~~~bash
git add src/performance src/verification src/commands README.md docs/operations.md tests/performance tests/e2e
git commit -m "feat: complete agent context sync mvp"
~~~

## v0.3 完成门控

运行：

~~~bash
npm ci
npm run verify
npm test -- --run tests/e2e/mvp-acceptance.test.ts
git status --short
~~~

预期：

- 所有 v0.1、v0.2 和 v0.3 测试均通过。
- 十仓库和 partial-clone 验收场景通过。
- check 生成有证据支持的结果，并要求每个 mutation 都获得批准。
- 分歧的 Context history 在不 force push 的情况下得到调和。
- tracing 保持选择启用、仅路径，并且在不支持的位置安全地 unavailable。
- Git status 干净，且没有临时 preview、backup、trace 或 cache artifact 被跟踪。
