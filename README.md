# Agent Context Sync

Agent Context Sync 是一套可移植的 Agent Skill，用于发现、采集并同步 Claude Code 与 Codex 在虚拟多仓库 Workspace 中预期加载的上下文。共享知识存放在独立的 Context Git 仓库中；业务仓库里的 `AGENTS.md` 与 `CLAUDE.md` 是由其派生生成、并纳入版本控制的文件。

完整操作说明见 **[使用手册](docs/user-manual.md)**。运维与排障见 [运维手册](docs/operations.md)。

## 安装

先构建独立启动器，再把整个 Skill 目录复制到所用 Agent 的 skills 目录：

```sh
npm ci
npm run build

mkdir -p ~/.codex/skills ~/.claude/skills
cp -R skill/agent-context-sync ~/.codex/skills/agent-context-sync
cp -R skill/agent-context-sync ~/.claude/skills/agent-context-sync
```

构建产物 `scripts/acs.mjs` 已打入运行时依赖。安装后不再需要源码检出目录及其 `node_modules`。环境需提供 Node.js 20+ 与 Git。

## Workspace 模型

Workspace 是虚拟的：各仓库保留真实文件系统路径，不会被挪到合成父目录下。稳定的 Workspace ID 与仓库身份共享在独立 Context Git 仓库中。本机绝对路径仅保存在私有注册表 `~/.agent-context-sync/workspaces/<workspace_id>.yaml`（或 `AGENT_CONTEXT_SYNC_HOME` 下），绝不写入共享 Manifest。

当前支持的 Agent 为 Claude Code 与 Codex。其 Adapter 会报告已知上下文源、加载顺序、可共享性，以及覆盖状态：`covered`、`partial`、`unknown`、`inaccessible`。`unknown` 表示边界，不能当作已完整覆盖的证据。

## 命令

每条命令在 stdout 输出一份 JSON 信封。写操作必须先经过 preview（或 prepare）阶段，再用不透明的 `preview_id` 显式审批并 apply。Preview 授权保存在 ACS 私有目录，权限模式 `0600`，会过期，且只能 apply 一次。下文用 `ACS` 表示已安装启动器，`PREVIEW_ID` 表示 `data.preview.preview_id`。
失败信封可包含经脱敏、稳定的 `error.details` 字段供自动化使用；原始 OS / 解析错误不会出现在该字段中。

```sh
ACS="$HOME/.codex/skills/agent-context-sync/scripts/acs.mjs"

node "$ACS" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
# 若 preview 报告重复克隆候选，请用显式绑定重新预览：
node "$ACS" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$ACS" init apply --preview-id "$PREVIEW_ID"

node "$ACS" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$ACS" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$ACS" join apply --preview-id "$PREVIEW_ID"

node "$ACS" add-repo preview --workspace "$WORKSPACE_ID" --repository /work/acme/api
node "$ACS" add-repo apply --preview-id "$PREVIEW_ID"

node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent codex --repository github.com/acme/api --cwd /work/acme/api/packages/api
node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent claude-code
node "$ACS" doctor --workspace "$WORKSPACE_ID"

node "$ACS" capture prepare --workspace "$WORKSPACE_ID" --agent claude-code
node "$ACS" capture preview --packet-id "$PACKET_ID" --proposal /tmp/proposal.json
node "$ACS" capture apply --preview-id "$PREVIEW_ID"

node "$ACS" apply preview --workspace "$WORKSPACE_ID" --agent codex
node "$ACS" apply apply --preview-id "$PREVIEW_ID"

node "$ACS" sync prepare --workspace "$WORKSPACE_ID" --agent claude-code

node "$ACS" check prepare --workspace "$WORKSPACE_ID" --repository github.com/acme/api
node "$ACS" check preview --packet-id "$PACKET_ID" --proposal /tmp/verification-proposal.json
node "$ACS" check apply --preview-id "$PREVIEW_ID"

node "$ACS" reconcile prepare --workspace "$WORKSPACE_ID"
node "$ACS" reconcile preview --packet-id "$PACKET_ID" --proposal /tmp/reconcile-proposal.json
node "$ACS" reconcile apply --preview-id "$PREVIEW_ID"

node "$ACS" trace run --workspace "$WORKSPACE_ID" --agent codex \
  --experimental --consent-path-metadata \
  --command /bin/true
```

可重复传入 `--scan-root` 以指定多个 join 根目录；重复传入 `--repository` 可限制 inspect / apply 范围。需要显式选择克隆时，重复传入 `--binding repo_id=path`；存在歧义的 preview 在全部重复身份绑定完成前无法 apply。省略 `--repository` 表示对所有本机已绑定仓库执行 inspect / apply。`apply preview` 省略 `--agent` 时会渲染两种 Agent；重复传入 `--agent` 可显式选择。

默认注册表根目录为 `~/.agent-context-sync`，可用 `AGENT_CONTEXT_SYNC_HOME` 覆盖。Agent 级发现使用 `HOME`；Codex 还会读取 `CODEX_HOME`。

`add-repo` 的 preview 会认证 `mode` 为 `add-shared` 或 `bind-existing`。绑定共享 Workspace 中已存在的身份时，仅更新私有本机注册表；绑定已完全一致时为确定性 no-op。

`sync prepare` 等价于 `capture prepare`。完整同步编排由 Skill 驱动：prepare capture → Agent 提案 → capture preview/apply → apply preview/apply。

日常工作流概要：

1. **init** 或 **join** Workspace（对接 Context remote）。
2. **inspect** / **doctor** 了解 Adapter 覆盖范围与本机健康状况。
3. **capture**（或 **sync prepare**）提取并发布共享知识。
4. **apply** 将原生 Agent 指导文件渲染到业务仓库。
5. 知识可能相对代码证据过期时使用 **check**。
6. Context Git 历史分叉时使用 **reconcile**。
7. 排查未知来源时，仅在显式实验同意后使用 **trace**。

## 安全边界

- `inspect` 与 `doctor` 为只读。`doctor` 只报告固定诊断项，不会修复任何问题，包括损坏的缓存条目（见 [docs/operations.md](docs/operations.md)）。
- Preview 阶段不会持久化 Workspace 或业务仓库变更；只写入私有、会过期的授权记录。Apply 会拒绝已变更、已过期、已复用、过时或被并发占用的 preview ID。
- Context 的 commit / push 仅发生在已批准的 capture、check、reconcile 的 apply 阶段。
- 生成的 Agent 文件仅在已批准的 apply apply 阶段写入，并带漂移检测；发生漂移的目标文件绝不会被静默覆盖。
- 任何命令都不会对业务仓库执行 commit、push、reset、clean 或 force-update。
- 发现与验证证据可缓存在 ACS home；缓存命中可减少重复读文件。`inspect` JSON 可包含 `data.stats.files_read`。

## 文档索引

| 文档 | 说明 |
|---|---|
| [使用手册](docs/user-manual.md) | 安装、概念、日常流程与命令详解 |
| [运维手册](docs/operations.md) | 备份、迁移、分叉、漂移与缓存维护 |
| [设计规格](docs/superpowers/specs/2026-07-11-agent-context-sync-design.md) | 产品目标、架构与知识模型 |
| [实施计划总览](docs/superpowers/plans/2026-07-11-agent-context-sync-plan-index.md) | v0.1 / v0.2 / v0.3 计划入口 |
| [Skill 说明](skill/agent-context-sync/SKILL.md) | Agent 执行本 Skill 时的工作流契约 |
