# 运维手册

Agent Context Sync（ACS）在 Workspace init/join 之后的运维手册。

## 备份

同时备份私有 ACS home 与共享 Context Git remote。

- **私有 home**（`~/.agent-context-sync` 或 `AGENT_CONTEXT_SYNC_HOME`）：本机 Workspace 注册表 YAML、preview 授权记录、验证 packet、reconcile packet，以及 `cache/` 下的内容缓存。将该目录视为机器本地数据；其中可能包含绝对路径。
- **Context remote**：独立 Context Git 仓库是共享 Workspace Manifest 与知识的事实来源。使用常规 Git 托管备份或镜像即可。不要 force-push；ACS 从不强制改写 Context 历史。

恢复步骤：重新安装 Skill，按需恢复 ACS home 目录，再针对 Context remote 重新 join 或重新绑定仓库。

## Context remote 迁移

迁移 Context remote URL 时：

1. 确保每位成员已推送或 reconcile 完未完成的 Context 工作。
2. 在干净的 Context 检出上更新 remote（`git remote set-url origin <new-url>`），推送成员需要的全部 refs，并用 `ls-remote` 验证。
3. 通过经审核的 Context 提交更新共享 Workspace Manifest 中的 `context_remote`（仅在创建新 Workspace 身份时才考虑重新 init）。
4. 请每位成员刷新本机 Context 检出（重新 join，或重新克隆到 ACS 期望的 contexts 路径），保证注册表路径仍可解析。

不要改写已发布的 Context commit SHA。历史已分叉的成员应运行 `reconcile`，而不是 reset。

## Schema 兼容性

共享 Context 文档与本机 preview packet 使用显式 `schema_version` 字段。ACS 在读取时校验。

- 较新客户端可能拒绝不受支持的旧 schema 版本；迁移数据格式前请先升级 Skill。
- 较旧客户端不得把未知字段写入共享知识或 Workspace Manifest。
- 引入破坏性 schema 时，发布仅新客户端可 apply 的 Context 提交，并在 Workspace 中记录最低 Skill 版本要求。

## 处理分叉

当本机与远端 Context 历史分叉时：

1. `reconcile prepare --workspace <id>` 会对知识级自动合并与冲突进行分类。
2. 审核冲突；返回的提案必须为每个冲突给出显式决议。
3. `reconcile preview` 然后 `reconcile apply` 会发布 merge commit，且不 force-push。

两侧的增量变更通常可自动合并。同一条目的编辑需要 Agent 选择（`local`、`remote`、`combine` 或 `disputed`）。

## 生成文件漂移

`apply preview` / `apply apply` 仅在批准后写入生成的 `AGENTS.md` / `CLAUDE.md`（及相关原生文件）。若目标文件已相对上次 ACS 托管内容发生漂移，apply 会拒绝静默覆盖。处理方式：恢复托管文件、在有意编辑协调后再接受新的 preview，或在希望重新生成时删除漂移文件。ACS 从不对业务仓库执行 commit 或 push。

## 隐私边界

- 本机绝对路径只存在于私有 ACS home 注册表，不得提交到 Context remote。
- Capture 与 check 的脱敏会在发布到 Context 前，从共享 packet 中剥离密钥与本机绝对根路径。
- 个人 / 托管 Agent 源仍由 Adapter 报告；发布共享知识前必须满足团队可共享性要求。
- Preview 授权 MAC、缓存内容与验证 packet 均为仅本机制品。

## 实验性 trace 同意

`trace run` 为可选、实验性功能：

- 需要显式开启实验标志与路径元数据同意。
- 仅记录路径元数据，不存储文件内容。
- 失败或平台 provider 不可用时，不得阻塞稳定的 `inspect` 覆盖报告。
- 不要把 trace 候选自动升级为 Adapter 覆盖；更改发现契约前必须先审核。

## 缓存维护

ACS 在 `<ACS_HOME>/cache/` 下保存有界、按哈希键控的缓存，用于发现报告与验证证据。写入是原子的。

当条目损坏时，`doctor` 会报告 `cache-integrity` 警告，并建议手动删除。Doctor 从不删除缓存文件。审核后清理缓存：

```sh
rm -rf "${AGENT_CONTEXT_SYNC_HOME:-$HOME/.agent-context-sync}/cache"
```
