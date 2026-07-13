---
name: agent-context-sync
description: 在虚拟多仓库 Workspace 中发现 Claude Code 与 Codex 上下文，采集共享知识，并应用生成的 Agent 指导文件。
---

# Agent Context Sync

使用附带的 `scripts/acs.mjs` 启动器。它在 stdout 恰好输出一份 JSON 信封：
`{"ok":true,"command":"...","data":...}` 或
`{"ok":false,"command":"...","error":{"code":"...","message":"...","details":{...}}}`。
`details` 可选，且只包含经脱敏、稳定的补救字段。
不要把 stderr 或异常文本当作结构化输出。

当注册表需要放在 `~/.agent-context-sync` 以外时，设置 `AGENT_CONTEXT_SYNC_HOME`。
`HOME` 是用于上下文发现的 Agent home；Codex 还会读取 `CODEX_HOME`。

## 安全与审批

`inspect` 与 `doctor` 严格只读。它们可以读文件、查询 Git，但不得修复、暂存、提交、推送或修改业务仓库。

`init`、`join`、`add-repo`、`capture`、`check`、`apply` 是两阶段（或三阶段）操作。始终先运行 prepare/preview，向用户展示确切影响，并保留不透明的 `preview_id`。每次只问一个审批问题。
仅在用户明确批准该次 preview 后，才运行对应的 apply 命令。
Preview ID 会过期且一次性使用。绝不复用或伪造。
若 preview 报告克隆候选存在歧义，不要请求 apply 审批。
用可重复的 `--binding repo_id=path` 选项重新运行同一 preview 命令，直到每个歧义身份都有唯一本机绑定。

覆盖状态为 `covered`、`partial`、`unknown`、`inaccessible`。
绝不要把 `unknown` 覆盖解释为完整。把 `partial`、`unknown`、`inaccessible` 当作必须向用户可见的限制。

绝不要静默覆盖已漂移的生成文件。若 `apply preview` 报告 `drift_candidates`，停止并先采集手工编辑，或请用户丢弃后再重新渲染。绝不在业务仓库中运行 `git add`、`commit` 或 `push`。

## 精确工作流

下文 `$SKILL_DIR` 为已安装的 `agent-context-sync` Skill 目录。
`$PREVIEW_ID` 必须是前一次成功响应中 `data.preview.preview_id` 的精确字符串。

初始化 Workspace：

```sh
node "$SKILL_DIR/scripts/acs.mjs" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" init apply --preview-id "$PREVIEW_ID"
```

加入已有 Workspace。需要时可重复传入 `--scan-root`：

```sh
node "$SKILL_DIR/scripts/acs.mjs" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" join apply --preview-id "$PREVIEW_ID"
```

添加或绑定仓库：

```sh
node "$SKILL_DIR/scripts/acs.mjs" add-repo preview --workspace ws_01J00000000000000000000000 --repository /work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" add-repo apply --preview-id "$PREVIEW_ID"
```

展示 preview 认证后的 `normalized_input.mode`。`add-shared`
可能写入并推送 Context 文件。`bind-existing` 可能仅更新私有本机注册表；已完全一致的绑定是 no-op。

对一个受支持 Agent 检查本机已绑定仓库。重复传入 `--repository` 可限制范围；省略则检查全部本机绑定：

```sh
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent codex
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent claude-code --repository github.com/acme/api
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent codex --repository github.com/acme/api --cwd /work/acme/api/packages/api
```

运行固定的只读诊断：

```sh
node "$SKILL_DIR/scripts/acs.mjs" doctor --workspace ws_01J00000000000000000000000
```

### 将知识采集到 Context Git

1. 准备经脱敏的提取 packet。
2. 请当前 Agent 返回符合该 packet Schema 约束的提案 JSON。
3. Preview 采集影响并获得批准。
4. Apply 以发布一次 Context Git 提交（绝不 force-push）。

```sh
node "$SKILL_DIR/scripts/acs.mjs" capture prepare --workspace ws_01J00000000000000000000000 --agent claude-code
node "$SKILL_DIR/scripts/acs.mjs" capture preview --packet-id "$PACKET_ID" --proposal /tmp/proposal.json
node "$SKILL_DIR/scripts/acs.mjs" capture apply --preview-id "$PREVIEW_ID"
```

### 用代码证据检查活跃知识

1. 为作用域内活跃知识准备有界验证 packet。
2. 请当前 Agent 返回符合 Schema 约束的验证结论。
3. Preview 创建/更新/替代/归档影响并获得批准。
4. Apply 仅发布 Context Git 知识（`required_apply: true`）；若需要刷新 Agent 文件，再单独运行一次 `apply` preview/apply。

不要仅凭时间推断 `stale`。证据不足时使用 `unverifiable`，并引用 `attempted_checks`。对 `valid`、`stale`、`contradicted` 引用具体的文件、依赖、配置或 git-commit 证据。

```sh
node "$SKILL_DIR/scripts/acs.mjs" check prepare --workspace ws_01J00000000000000000000000 --repository github.com/acme/api
node "$SKILL_DIR/scripts/acs.mjs" check preview --packet-id "$PACKET_ID" --proposal /tmp/check-proposal.json
node "$SKILL_DIR/scripts/acs.mjs" check apply --preview-id "$PREVIEW_ID"
```

### 应用生成的 Agent 文件

将 Context 知识编译为原生 `AGENTS.md` / `CLAUDE.md`。Preview 展示完整 unified diff、Context HEAD、业务 HEAD 与漂移候选。
Apply 先在本机 ACS home 下写入备份，再按仓库原子替换文件。业务 Git 历史保持不变，由用户自行提交。

```sh
node "$SKILL_DIR/scripts/acs.mjs" apply preview --workspace ws_01J00000000000000000000000 --agent codex
node "$SKILL_DIR/scripts/acs.mjs" apply preview --workspace ws_01J00000000000000000000000 --agent claude-code --agent codex
node "$SKILL_DIR/scripts/acs.mjs" apply apply --preview-id "$PREVIEW_ID"
```

省略 `--agent` 时同时渲染 Claude Code 与 Codex。重复传入 `--agent` 可显式选择其一或两者。

### 同步工作流（由 Skill 编排）

CLI 中的 `sync` 仅提供 prepare。完整循环需自行编排：

1. `sync prepare` 或 `capture prepare` → 提取 packet
2. 请 Agent 返回 Schema JSON 提案
3. `capture preview` → 批准 → `capture apply`（发布到 Context Git）
4. `apply preview` → 批准 → `apply apply`（替换业务文件）

```sh
node "$SKILL_DIR/scripts/acs.mjs" sync prepare --workspace ws_01J00000000000000000000000 --agent claude-code
```

### 实验性运行时追踪（可选）

通过追踪 Agent 进程的文件访问，发现未知上下文文件路径。
需要同时提供 `--experimental` 与 `--consent-path-metadata`。仅记录路径元数据（open/stat/readlink 类事件）；从不读取文件内容。
不可用的 provider 会报告，但不会使稳定发现失败。Windows 在 v0.3 不可用。

```sh
node "$SKILL_DIR/scripts/acs.mjs" trace run --experimental --consent-path-metadata --workspace ws_01J00000000000000000000000 --agent claude-code --command /usr/bin/true
```

重复传入 `--arg` 可提供命令参数。候选结果是后续稳定 `inspect` / `capture` 的提示——追踪从不自动修改 Adapter 覆盖。

报告失败的 JSON 信封时，不要编造修复方案。若修复会写入，回到对应的 preview / 审批 / apply 工作流。
