# Agent Context Sync 使用手册

本手册面向日常使用者与运维人员，说明如何安装、配置并使用 Agent Context Sync（简称 ACS）。更细的运维排障见 [运维手册](./operations.md)；产品设计见 [设计规格](./superpowers/specs/2026-07-11-agent-context-sync-design.md)。

## 1. 它解决什么问题

团队在 Claude Code、Codex 等多个 coding agent 之间切换时，规则、记忆与加载路径往往彼此割裂。一个产品 Workspace 还可能包含多个业务仓库，成员只克隆其中一部分，目录布局也不一致。

ACS 把共享上下文当作独立资产：

1. **发现**各 Agent 已有上下文源与覆盖边界；
2. **采集**为中立、结构化的共享知识，经人审核后写入独立 Context Git；
3. **编译**为业务仓库中的原生 `AGENTS.md` / `CLAUDE.md`（默认纳入业务仓库版本控制）。

ACS **不会**自动提交或推送业务仓库；也 **不会**静默覆盖你手工改过的生成文件。

## 2. 核心概念

| 概念 | 含义 |
|---|---|
| Workspace | 虚拟工作区身份，由稳定 `workspace_id` 标识，不依赖本机目录布局 |
| Context Git | 独立 Git 仓库，保存共享 Manifest 与结构化知识，是团队事实来源 |
| 业务仓库 | 实际开发用的 Git 仓库；ACS 可写入生成文件，但不对其 commit/push |
| 本机注册表 | `~/.agent-context-sync`（或 `AGENT_CONTEXT_SYNC_HOME`）下的私有 YAML，保存绝对路径等本机信息 |
| Adapter | Claude Code / Codex 的适配层，负责发现来源与渲染目标文件 |
| Preview / Apply | 写操作两阶段：先预览影响并拿到 `preview_id`，经明确批准后再执行 |
| 覆盖状态 | `covered` / `partial` / `unknown` / `inaccessible`；`unknown` 不等于已完整覆盖 |

## 3. 环境要求

- Node.js 20 或更高
- Git
- 支持的 Agent：Claude Code、Codex

## 4. 安装

### 4.1 从源码构建并安装 Skill

```sh
npm ci
npm run build

mkdir -p ~/.codex/skills ~/.claude/skills
cp -R skill/agent-context-sync ~/.codex/skills/agent-context-sync
cp -R skill/agent-context-sync ~/.claude/skills/agent-context-sync
```

构建产物 `skill/agent-context-sync/scripts/acs.mjs` 已打包运行时依赖，安装后无需再依赖源码树或 `node_modules`。

### 4.2 启动器别名

下文统一使用：

```sh
ACS="$HOME/.codex/skills/agent-context-sync/scripts/acs.mjs"
# 若主要使用 Claude Code，也可改为：
# ACS="$HOME/.claude/skills/agent-context-sync/scripts/acs.mjs"
```

每条命令在 stdout 输出一份 JSON 信封：

```json
{"ok":true,"command":"...","data":{...}}
```

或：

```json
{"ok":false,"command":"...","error":{"code":"...","message":"...","details":{...}}}
```

请以 stdout JSON 为准；不要把 stderr 当作结构化结果。

### 4.3 环境变量

| 变量 | 作用 |
|---|---|
| `AGENT_CONTEXT_SYNC_HOME` | 覆盖默认注册表根目录 `~/.agent-context-sync` |
| `HOME` | Agent 级上下文发现使用的 home |
| `CODEX_HOME` | Codex 额外识别的 home（若已设置） |

## 5. 第一次使用

### 5.1 创建新 Workspace（init）

团队首次使用时，由一人初始化 Context remote，并扫描本机仓库：

```sh
node "$ACS" init preview \
  --name platform \
  --context-remote git@github.com:acme/platform-context.git \
  --scan-root /work/acme \
  --max-depth 2
```

查看 JSON 中的影响说明。若出现重复克隆候选，用 `--binding repo_id=path` 消除歧义后再 preview：

```sh
node "$ACS" init preview \
  --name platform \
  --context-remote git@github.com:acme/platform-context.git \
  --scan-root /work/acme \
  --max-depth 2 \
  --binding github.com/acme/api=/work/acme/api
```

确认无误后：

```sh
PREVIEW_ID='...'   # 取自 data.preview.preview_id
node "$ACS" init apply --preview-id "$PREVIEW_ID"
```

记下返回的 `workspace_id`，后续命令都会用到。

### 5.2 加入已有 Workspace（join）

其他成员加入同一 Context remote：

```sh
node "$ACS" join preview \
  --context-remote git@github.com:acme/platform-context.git \
  --scan-root /work/acme \
  --max-depth 2
node "$ACS" join apply --preview-id "$PREVIEW_ID"
```

可重复传入多个 `--scan-root`。路径布局不同没关系：共享的是仓库身份，不是本机绝对路径。

### 5.3 添加或绑定仓库（add-repo）

```sh
node "$ACS" add-repo preview \
  --workspace "$WORKSPACE_ID" \
  --repository /work/acme/api
node "$ACS" add-repo apply --preview-id "$PREVIEW_ID"
```

Preview 中的 `normalized_input.mode`：

- `add-shared`：可能写入并推送 Context
- `bind-existing`：仅更新本机注册表；已完全一致则为 no-op

## 6. 日常工作流

推荐顺序：

```text
init / join → inspect / doctor → capture → apply →（按需）check / reconcile
```

### 6.1 查看覆盖与健康状况

```sh
node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent codex
node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent claude-code \
  --repository github.com/acme/api \
  --cwd /work/acme/api/packages/api
node "$ACS" doctor --workspace "$WORKSPACE_ID"
```

- `inspect`：报告已知上下文源、加载顺序、可共享性与覆盖状态
- `doctor`：固定只读诊断；**不会修复**任何问题（包括损坏缓存）

省略 `--repository` 表示检查全部本机已绑定仓库。

### 6.2 采集共享知识（capture）

三阶段：

1. `capture prepare`：生成经脱敏的提取 packet
2. 由当前 Agent 按 Schema 写出提案 JSON
3. `capture preview` → 批准 → `capture apply`：发布一次 Context 提交

```sh
node "$ACS" capture prepare --workspace "$WORKSPACE_ID" --agent claude-code
# PACKET_ID 取自 prepare 结果；由 Agent 生成 /tmp/proposal.json
node "$ACS" capture preview --packet-id "$PACKET_ID" --proposal /tmp/proposal.json
node "$ACS" capture apply --preview-id "$PREVIEW_ID"
```

`sync prepare` 等价于 `capture prepare`。完整「同步」由 Skill 编排：采集发布后再执行 apply。

### 6.3 生成 Agent 文件（apply）

```sh
node "$ACS" apply preview --workspace "$WORKSPACE_ID" --agent codex
# 省略 --agent 时同时渲染 Claude Code 与 Codex
node "$ACS" apply preview --workspace "$WORKSPACE_ID"
node "$ACS" apply apply --preview-id "$PREVIEW_ID"
```

Preview 会展示完整 unified diff、Context HEAD、业务 HEAD，以及 `drift_candidates`。

- 有漂移时 **不会**静默覆盖；需先处理手工修改或恢复托管内容后再 apply
- Apply 会在 ACS home 写备份，再原子替换业务仓库中的目标文件
- 业务仓库的 commit / push 由你自行完成

### 6.4 用代码证据校验知识（check）

当规则可能过期或与代码矛盾时：

```sh
node "$ACS" check prepare --workspace "$WORKSPACE_ID" --repository github.com/acme/api
node "$ACS" check preview --packet-id "$PACKET_ID" --proposal /tmp/verification-proposal.json
node "$ACS" check apply --preview-id "$PREVIEW_ID"
```

结论状态：

| 状态 | 含义 |
|---|---|
| `valid` | 有证据支持仍然成立 |
| `stale` | 有证据表明已过时 |
| `contradicted` | 有证据表明与现状冲突 |
| `unverifiable` | 证据不足；**不要**改判为 `stale` |

`check apply` 只更新 Context 知识。若需要刷新业务仓库中的 Agent 文件，再单独跑一轮 `apply`。

### 6.5 协调 Context 分叉（reconcile）

本机与远端 Context 历史分叉时：

```sh
node "$ACS" reconcile prepare --workspace "$WORKSPACE_ID"
node "$ACS" reconcile preview --packet-id "$PACKET_ID" --proposal /tmp/reconcile-proposal.json
node "$ACS" reconcile apply --preview-id "$PREVIEW_ID"
```

- 两侧增量变更通常可自动合并
- 同一条目冲突需显式选择：`local` / `remote` / `combine` / `disputed`
- 不会 force-push；不要用 reset 强行对齐已发布历史

### 6.6 实验性追踪（trace）

仅在排查未知上下文源、且明确同意记录路径元数据时使用：

```sh
node "$ACS" trace run \
  --workspace "$WORKSPACE_ID" \
  --agent claude-code \
  --experimental \
  --consent-path-metadata \
  --command /usr/bin/true
```

- 只记录路径元数据，不读文件内容
- 候选结果仅供后续人工审核，不会自动改 Adapter 覆盖
- Windows 在当前版本不可用；provider 失败不得阻塞稳定 `inspect`

## 7. 命令速查

| 命令 | 阶段 | 作用 |
|---|---|---|
| `init` | preview → apply | 创建 Workspace 并绑定本机仓库 |
| `join` | preview → apply | 加入已有 Context remote |
| `add-repo` | preview → apply | 新增共享仓库或绑定本机路径 |
| `inspect` | 只读 | 报告上下文源与覆盖 |
| `doctor` | 只读 | 固定诊断，不修复 |
| `capture` | prepare → preview → apply | 提取并发布共享知识 |
| `sync` | prepare | 等价于 `capture prepare` |
| `apply` | preview → apply | 编译并写入 Agent 原生文件 |
| `check` | prepare → preview → apply | 用代码证据校验知识 |
| `reconcile` | prepare → preview → apply | 知识级合并分叉历史 |
| `trace` | run | 实验性文件访问追踪 |

写操作一律：**先 preview/prepare，再拿精确 `preview_id` 审批后 apply**。Preview ID 会过期且一次性使用；不要复用或伪造。

## 8. 安全边界（必读）

1. `inspect` / `doctor` 只读。
2. Preview 不改 Workspace / 业务仓库；只写私有、会过期的授权记录。
3. Context 的 commit/push 仅发生在已批准的 capture / check / reconcile apply。
4. 生成文件仅在已批准的 `apply apply` 写入，并检测漂移。
5. 任何命令都不会对业务仓库 `commit` / `push` / `reset` / `clean` / force-update。
6. 本机绝对路径与密钥不会进入共享 Context；capture / check 会脱敏。

## 9. 常见问题

### Preview 报克隆歧义，无法 apply

为每个重复身份补充 `--binding repo_id=/绝对路径`，重新 preview，直到无歧义。

### Apply 因 drift_candidates 失败

说明目标文件已相对 ACS 上次托管内容被手工修改。可选：

- 保留手工修改：先走 capture 把变更吸收进知识；或
- 丢弃手工修改后重新 `apply preview` / `apply apply`

### doctor 提示 cache-integrity

Doctor 不会删缓存。审核后可手动清理：

```sh
rm -rf "${AGENT_CONTEXT_SYNC_HOME:-$HOME/.agent-context-sync}/cache"
```

### 换了 Context remote URL

按 [运维手册 · Context remote 迁移](./operations.md#context-remote-迁移) 操作；不要改写已发布 SHA。

### 想备份本机状态

同时备份 ACS home 与 Context remote。详见 [运维手册 · 备份](./operations.md#备份)。

## 10. 文档地图

| 文档 | 读者 | 内容 |
|---|---|---|
| [README](../README.md) | 所有人 | 安装摘要与命令示例 |
| [本使用手册](./user-manual.md) | 使用者 / 运维 | 概念、流程、FAQ |
| [运维手册](./operations.md) | 运维 | 备份、迁移、分叉、缓存 |
| [Skill 说明](../skill/agent-context-sync/SKILL.md) | Agent | Skill 执行契约与精确命令 |
| [设计规格](./superpowers/specs/2026-07-11-agent-context-sync-design.md) | 设计 / 开发 | 目标、架构、知识模型 |
| [实施计划总览](./superpowers/plans/2026-07-11-agent-context-sync-plan-index.md) | 开发 | v0.1–v0.3 计划入口 |
