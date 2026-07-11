# Agent Context Sync 设计规格

**日期：** 2026-07-11
**状态：** 待最终验收
**产品定位：** Skill-first Workspace Context Compiler

## 1. 背景

开发者会在 Claude Code、Codex 等多个 coding agent 之间切换。每个 Agent 的项目规则、自动记忆、加载路径和层级规则不同，导致同一团队的架构决策、开发约定、踩坑记录和当前工作状态彼此割裂。

问题不只发生在单个 Git 仓库。一个产品 Workspace 可能包含多个独立业务仓库；不同成员只克隆其中一部分，目录布局也不一致。因此，同步单个仓库中的 `CLAUDE.md`、`AGENTS.md` 或 `.context/` 目录不能形成完整的团队上下文。

Agent Context Sync 将共享上下文视为独立资产：发现各 Agent 已有知识，将其提炼成中立的结构化知识，经用户审核后存入独立 Context Git 仓库，再编译为目标 Agent 原生加载的上下文文件。

## 2. 产品目标

### 2.1 MVP 目标

1. 支持一个稳定 Workspace 关联任意目录中的多个业务 Git 仓库。
2. 深度支持 Claude Code 与 Codex 的上下文发现和目标文件生成。
3. 从 Workspace、业务仓库、Agent 规则文件和项目记忆中发现候选知识。
4. 由当前 Agent 动态提炼、分类、去重和提出冲突处理方案。
5. 所有导入、覆盖、更新、归档和删除在执行前展示差异并获得用户确认。
6. 使用独立 Context Git 仓库共享结构化知识并保留历史。
7. 将适用知识完整生成到业务仓库的 `CLAUDE.md` 和 `AGENTS.md`，默认纳入业务仓库版本控制。
8. 提供 `check` 工作流，让 Agent 结合代码证据识别过期或冲突规则。

### 2.2 非目标

- 不同步完整聊天记录、隐藏推理链或终端原始输出。
- 不修改 Agent 的内部数据库或依赖未公开写入接口。
- 不自动提交或推送业务仓库。
- 不默认共享用户级个人偏好、凭据或组织托管策略。
- 不承诺发现所有未公开的内部上下文源。
- MVP 不完整支持 Cursor、Gemini CLI 或其他 Agent。
- MVP 不提供云服务、实时协作服务或 Web 管理后台。

## 3. 核心原则

1. **Workspace 第一：** Workspace 身份不由当前目录或已克隆仓库集合计算。
2. **知识优于文件：** Context Git 中保存中立知识；Agent 文件是编译产物。
3. **发现优先：** 同步前先明确每个 Agent 的已知输入源和未覆盖范围。
4. **默认可审计：** 每条知识保留来源、时间、哈希、关系和验证状态。
5. **人类确认写入：** Agent 可以判断和建议，不能绕过确认执行破坏性变更。
6. **完整生成：** 目标文件不维护并列的手写区和托管区，避免重复或冲突规则同时进入上下文。
7. **适用范围明确：** Workspace 知识和 Repository 知识分层，按 Agent、仓库和路径过滤。
8. **确定性内核：** 文件发现、Git 操作、Schema 校验、diff 和写入由 Skill 内脚本执行；语义提炼由 Agent 完成。

## 4. 参考项目对比

### 4.1 Intina47/context-sync

[Intina47/context-sync](https://github.com/Intina47/context-sync) 是 local-first MCP 项目记忆库，提供 SQLite 存储、结构化 remember/recall、项目分析、文件读取和 Git 上下文。

可借鉴：

- 结构化上下文类别和召回思路；
- 项目扫描、Git 分析与路径规范化；
- 本地缓存和 Schema 迁移意识。

不直接复用其核心架构，原因是：

- 以单项目路径和本地 SQLite 为中心，不以团队 Workspace 为身份；
- 依赖 Agent 主动 remember/recall，不发现现有原生上下文；
- 缺少独立团队知识仓库和跨 Agent 编译；
- MCP-first 的产品边界与本项目的 Skill-first 入口不同。

### 4.2 1EchA/context-sync-mcp

[1EchA/context-sync-mcp](https://github.com/1EchA/context-sync-mcp) 将结构化 Markdown 写入业务仓库 `.context/`，通过 Git push/load 实现跨设备和跨 Agent 恢复。

可借鉴：

- Git remote preflight、ahead/behind 和 fast-forward 检查；
- 用户可理解的 init/save/load 工作流；
- 对 `.context/` 变更限定 pathspec 的安全处理；
- 端到端和跨设备测试思路。

不直接复用其核心架构，原因是：

- 上下文绑定单个业务仓库；
- 固定 Markdown 文档不是开放的结构化知识模型；
- 不发现 Agent 私有项目记忆或加载链；
- 不提供 Adapter、完整覆盖编译、规则证据验证或多仓 Workspace。

### 4.3 结论

本项目独立实现 Workspace Context Compiler，吸收上述项目的局部实践，不 fork 其数据模型或 MCP 接口。

## 5. 总体架构

系统由六个独立模块组成。

### 5.1 Workspace Registry

管理：

- 稳定 `workspace_id`；
- Context Git 仓库地址和本地缓存位置；
- 业务仓库稳定身份；
- 本机 Workspace 根目录和业务仓库绝对路径映射。

`workspace_id` 在创建 Context 仓库时生成，新增、删除或移动业务仓库不会改变它。

业务仓库身份优先使用规范化 Git remote URL。规范化时移除协议、凭据、`.git` 后缀和末尾斜杠，并统一主机名大小写。没有 remote 的本地仓库必须由用户显式命名，之后可以绑定 remote，但不得静默生成新 `repo_id`。

团队共享 Manifest 存在 Context Git 仓库；本机绝对路径存在 `~/.agent-context-sync/workspaces/<workspace_id>.yaml`，不得提交。

### 5.2 Agent Adapters

每个 Adapter 实现统一接口：

```text
detectVersion() -> AgentCapability
discover(workspace, repositories) -> ContextSource[]
explainCoverage() -> CoverageReport
render(knowledge, target) -> RenderedFile[]
verifyLoadPlan(target) -> LoadPlanReport
```

Adapter 只负责 Agent 机制差异，不负责语义提炼或 Git 同步。

### 5.3 Extraction Protocol

脚本将候选来源切分成带来源元数据的材料包。Agent 返回符合 Extraction Schema 的 JSON：

- 新知识候选；
- 与已有知识的重复关系；
- 冲突或替代关系；
- 建议作用域和路径范围；
- 不应导入的个人、临时或敏感内容及理由。

脚本必须重新校验 JSON。校验失败时只要求 Agent 修复结构，不保留部分写入。

### 5.4 Knowledge Store

独立 Context Git 仓库是结构化共享知识的唯一事实来源。Git 提供团队分发、历史、审计和回滚；业务仓库中的 Agent 文件是可重新生成的派生结果。

### 5.5 Context Compiler

Compiler 按目标 Agent、目标仓库、当前目录和知识状态选择条目，解析替代与冲突关系，生成完整目标文件。Compiler 不调用模型，保证相同知识版本和配置产生相同结果。

### 5.6 Rule Verifier

Verifier 准备待验证规则、代码搜索结果、依赖清单、配置文件和有限 Git 历史。Agent 判断每条规则状态并提供可定位证据。脚本只接受合法状态和实际存在的证据路径。

## 6. 知识模型

每条知识保存为独立 Markdown 文件。YAML Front Matter 保存机器字段，正文保存人类可读内容。

```yaml
---
schema_version: 1
id: kn_01J00000000000000000000000
kind: architecture-decision
scope: repository:github.com/acme/backend
status: active
applies_to:
  paths:
    - src/auth/**
  agents:
    - claude-code
    - codex
source:
  agent: claude-code
  source_type: auto-memory
  locator: claude-auto-memory/MEMORY.md
  content_hash: sha256:<hash>
  observed_at: 2026-07-11T10:00:00Z
confidence: 0.92
supersedes: []
conflicts_with: []
created_at: 2026-07-11T10:10:00Z
updated_at: 2026-07-11T10:10:00Z
last_verified_at: null
---

认证模块使用服务端 Session，不使用 JWT。

## Reason

需要支持服务端主动撤销登录状态。
```

### 6.1 分类

`kind` 是开放、非空、格式受限的 kebab-case 字符串。Skill 可以建议 `rule`、`architecture-decision`、`workflow`、`gotcha`、`active-work`、`command` 和 `domain-knowledge`，但 Agent 可生成新类型。

系统行为不得依赖有限的 `kind` 枚举。过滤和优先级依赖 `scope`、`status`、`applies_to`、`supersedes` 和 `conflicts_with`。

### 6.2 状态

知识状态固定为：

- `active`：参与编译；
- `superseded`：被另一条知识明确替代；
- `archived`：保留历史但不参与编译；
- `disputed`：存在未解决冲突，不得默认参与发布编译。

### 6.3 来源

来源记录只保存用户确认导入的脱敏逻辑位置、类型、选定引用、摘要和内容哈希。本机绝对路径仅保存在本机 Manifest。默认不复制完整私有记忆文件，以降低敏感信息扩散风险。

同一来源内容哈希再次出现时不得创建重复候选。来源变化但语义相同时更新观察记录，不创建新知识。

## 7. Context Git 仓库结构

```text
context-repo/
├── workspace.yaml
├── repositories/
│   └── <repo-id>.yaml
├── knowledge/
│   ├── workspace/
│   │   └── <knowledge-id>.md
│   └── repositories/
│       └── <repo-id>/
│           └── <knowledge-id>.md
├── sources/
│   └── <import-id>.json
└── schema/
    ├── knowledge.schema.json
    ├── extraction.schema.json
    └── verification.schema.json
```

知识文件使用稳定 ID 命名，避免标题变化造成重命名冲突。归档和替代不移动文件，只修改状态与关系。

## 8. Agent 上下文发现

### 8.1 Claude Code Adapter

稳定发现范围包括：

- 组织托管 `CLAUDE.md`，只报告，不导入或覆盖；
- 用户级 `~/.claude/CLAUDE.md`，默认标为个人来源，不导入团队知识；
- 从工作目录向上的 `CLAUDE.md`、`.claude/CLAUDE.md` 和 `CLAUDE.local.md`；
- 当前仓库内嵌套的 `CLAUDE.md` 与 `CLAUDE.local.md`；
- `.claude/rules/*.md` 及其 path scope；
- `@path` 导入链，限制在 Claude Code 支持的深度内并防止循环；
- `claudeMdExcludes` 和 additional directory 配置；
- `~/.claude/projects/<project>/memory/` 或 `autoMemoryDirectory` 指定目录中的 Auto Memory。

官方文档说明 Claude Code 会同时加载层级化 `CLAUDE.md` 与 Auto Memory，Auto Memory 按仓库共享并存放在机器本地。因此 Adapter 必须将两者作为不同来源处理，而不是只复制项目文件：<https://code.claude.com/docs/en/memory>。

### 8.2 Codex Adapter

稳定发现范围包括：

- `CODEX_HOME` 或默认 `~/.codex` 中的 `AGENTS.override.md` / `AGENTS.md`；
- 从项目根到当前工作目录的 `AGENTS.override.md`、`AGENTS.md` 和 `project_doc_fallback_filenames`；
- `project_doc_max_bytes` 对实际加载结果的截断影响；
- 项目 `.codex/config.toml` 中影响发现的设置；
- `~/.codex/memories/` 中可审查的本地记忆文件，仅提取与已绑定 Workspace/Repository 有明确关联的候选。

Codex 官方文档说明每层目录最多采用一个指导文件，并按根目录到当前目录顺序合并，默认总上限为 32 KiB：<https://developers.openai.com/codex/guides/agents-md>。官方同时说明本地 memories 位于 Codex home 下的 `memories/`，属于生成状态，不应作为必须遵循规则的唯一来源：<https://learn.chatgpt.com/docs/customization/memories>。

### 8.3 Coverage Report

每次 `inspect` 输出：

- Agent 和 Adapter 版本；
- 发现的来源、作用域和预计加载顺序；
- 被排除、为空、超限、不可读或无法归属的来源；
- Adapter 已知但当前 Agent 版本无法确认的能力；
- 是否启用实验追踪。

报告使用 `covered`、`partial`、`unknown`、`inaccessible`，不得使用未经证实的“完整发现”表述。

### 8.4 实验性运行时追踪

实验功能可使用操作系统允许的文件访问追踪或 Agent 调试日志，记录会话期间读取的候选上下文路径。它必须：

- 默认关闭；
- 明确提示可能收集的路径元数据；
- 不记录文件正文；
- 不将读取过的任意代码文件误判为上下文；
- 只产生 Adapter 更新建议或待人工确认候选。

追踪失败不得阻塞稳定发现流程。

## 9. 编译与覆盖策略

### 9.1 选择规则

目标仓库最终知识集合为：

```text
active workspace knowledge
+ active repository:<repo-id> knowledge
+ matching path-scoped knowledge
- superseded, archived, disputed knowledge
- knowledge excluded for target agent
```

当两条 active 知识显式冲突且没有 `supersedes` 关系时，编译失败并要求先解决冲突，不按更新时间静默选择。

### 9.2 优先级

生成内容按以下顺序排列：

1. Workspace 基础规则；
2. Repository 规则；
3. 路径特定规则；
4. Agent 特定规则；
5. 工作状态和临时提醒。

顺序只影响展示和 Agent 原生加载语义，不能用来掩盖已知冲突。

### 9.3 目标文件

MVP 在每个已绑定业务仓库根目录生成：

- `AGENTS.md`：Codex 完整上下文；
- `CLAUDE.md`：Claude Code 完整上下文。

需要路径级规则时，Adapter 可以生成嵌套 `AGENTS.md` 或 `.claude/rules/*.md`。根文件保持简洁，详细内容按目标 Agent 原生机制拆分。

生成文件默认纳入业务仓库 Git。文件头包含生成声明、Workspace ID、Context Git commit 和内容摘要。生成文件不得包含本机绝对路径或私有来源路径。

### 9.4 覆盖

首次接管时：

1. 发现现有目标文件；
2. 将其作为候选来源提炼；
3. 展示未导入、合并、冲突和新增内容；
4. 展示目标文件完整 diff；
5. 用户确认后创建本机备份并覆盖；
6. 成功编译后才允许删除临时备份。

后续发现生成文件被手动修改时，Skill 不直接覆盖。它先将差异作为候选知识处理，待确认导入或丢弃后重新生成。

## 10. 用户工作流与 Skill 命令

Skill 是唯一推荐入口。命令名称表示意图，不要求用户直接执行内部脚本。

### 10.1 `init`

为新团队创建 Workspace：

1. 创建或连接空的 Context Git 仓库；
2. 生成稳定 Workspace ID；
3. 扫描指定父目录下限定深度的 Git 仓库；
4. 展示并确认加入的仓库；
5. 初始化团队和本机 Manifest；
6. 执行首次 `inspect`，但不自动导入或覆盖。

### 10.2 `join`

加入已有 Workspace：

1. 克隆 Context Git 仓库；
2. 校验 Schema 与 Workspace ID；
3. 扫描当前父目录并按 remote URL 匹配业务仓库；
4. 允许手动添加父目录外仓库；
5. 报告团队 Manifest 中存在但本机未克隆的仓库；
6. 生成本机路径映射。

### 10.3 `add-repo`

将真实路径中的业务仓库加入 Workspace。软链接可以被识别，但 Registry 必须记录解析后的真实路径。软链接聚合视图不参与身份和加载路径计算。

### 10.4 `inspect`

只读发现当前或全部已绑定仓库的上下文源，生成 Coverage Report，不调用 Git push，不修改知识或目标文件。

### 10.5 `capture`

发现并提炼新增知识：

1. 拉取并 fast-forward Context Git；
2. 运行 `inspect`；
3. 与来源哈希和现有知识比较；
4. Agent 动态分类、去重和提出关系；
5. 展示候选知识和敏感内容排除结果；
6. 用户确认后写入 Context Git；
7. 创建提交并推送；
8. 不修改业务仓库，除非用户继续执行 `apply` 或 `sync`。

### 10.6 `apply`

从当前 Context Git commit 编译目标 Agent 文件：

1. 检查 Context Git 与远端状态；
2. 检测业务仓库目标文件手动修改；
3. 编译全部目标文件到临时目录；
4. 展示完整 diff；
5. 用户确认后原子替换；
6. 留下业务仓库工作区变更，由用户正常提交。

### 10.7 `sync`

组合工作流：`capture → Context Git commit/push → apply`。每个写入阶段分别展示影响；一次用户确认可以覆盖同一份最终变更集，但远端状态在确认后变化时必须重新确认。

### 10.8 `check`

对当前仓库或指定作用域的 active 知识进行代码核实，输出：

- `valid`：证据支持；
- `stale`：原事实曾成立但当前已过时；
- `contradicted`：当前代码直接冲突；
- `unverifiable`：现有材料不足。

每条结果包含证据路径、行号或 Git commit，以及建议动作。用户确认后才能更新、替代或归档知识，并重新 `apply`。

### 10.9 `doctor`

检查 Skill 版本、脚本运行时、Git、Context 仓库、Manifest、Adapter 能力、文件权限、目标文件漂移和 Schema 版本。只报告和给出修复建议；涉及写入时转入对应确认工作流。

## 11. Git 同步与并发

### 11.1 Context Git

Context Git 是工具管理仓库。写入前必须：

1. fetch 远端；
2. 判断 ahead/behind；
3. 只在可 fast-forward 时自动更新；
4. divergent 时停止并生成知识级冲突报告；
5. 用户确认写入后创建单一语义提交并 push。

如果 push 前远端发生变化，禁止自动 force push。重新 fetch、重新计算 diff 并再次请求确认。

### 11.2 知识级合并

不同知识 ID 的新增通常可以自动合并。相同知识 ID 的并发修改、`supersedes` 图冲突或同一适用范围的矛盾规则必须交给 Agent 解释并由用户确认。

### 11.3 业务仓库

Skill 只生成文件变更，不执行业务仓库 commit、push、merge 或 PR。生成文件默认是 tracked 文件，用户将其与正常业务变更一起提交。

跨多个业务仓库的 `apply` 不是原子 Git 事务。Skill 先为全部仓库完成编译和 diff，再逐仓库原子替换文件；任何写入失败时停止后续仓库并报告已完成和未完成列表，可安全重新执行。

## 12. 安全与隐私

- 发现阶段只读，不将内容发送给当前 Agent 之外的服务。
- 用户级规则和记忆默认分类为个人来源，不进入团队知识候选，除非用户显式要求。
- 提炼前运行秘密模式扫描；疑似 token、密码、私钥、连接串和个人路径默认排除。
- Context Git 中不得保存凭据、完整终端输出、完整聊天记录或未经选择的私有记忆副本。
- 来源路径在共享仓库中脱敏；绝对路径只保存在本机 Manifest。
- 组织托管策略只报告，不覆盖、不降级、不同步到团队仓库。
- 目标文件写入使用临时文件、Schema 校验、内容摘要和原子 rename。
- 任何自动 Git 操作仅限 Context Git 仓库，不使用 force、reset 或清理未跟踪文件。

## 13. 错误处理

| 场景 | 行为 |
|---|---|
| Context Git 无法访问 | 保留本地状态，禁止发布，允许只读 inspect |
| 远端分支领先 | fast-forward 后重新计算候选和 diff |
| 远端与本地分叉 | 停止写入，生成知识级冲突报告 |
| Agent 输出不符合 Schema | 不写入，要求 Agent仅修复结构 |
| 发现不可读来源 | 标记 inaccessible，继续处理其他来源 |
| Adapter 不认识当前 Agent 版本 | 标记 partial/unknown，禁止声称完整覆盖 |
| 目标文件被手动修改 | 先 capture 差异或经用户确认丢弃，禁止静默覆盖 |
| active 知识存在未解决冲突 | 编译失败，要求先解决 disputed 知识 |
| 某业务仓库写入失败 | 停止后续写入，报告已完成/未完成，可幂等重试 |
| 生成内容超过 Agent 限制 | 优先路径拆分；仍超限则失败并给出精简建议 |
| 实验追踪不可用 | 降级为稳定发现，不影响正常流程 |

## 14. 测试策略

### 14.1 单元测试

- remote URL 和真实路径规范化；
- Workspace/Repository 身份稳定性；
- Knowledge、Extraction、Verification Schema；
- 来源哈希和重复检测；
- scope/path/agent 过滤；
- supersedes/conflicts 图校验；
- 确定性编译和排序；
- 秘密与绝对路径脱敏；
- Git ahead/behind 状态机。

### 14.2 Adapter 契约测试

每个 Adapter 使用固定文件树 fixture 验证：

- 根目录、父目录、嵌套目录和 override 加载；
- 用户级、项目级和本地来源分类；
- import、fallback、exclude、size limit；
- Auto Memory 或 local memories 的归属过滤；
- 版本未知时的 Coverage Report。

### 14.3 集成测试

- 新 Workspace init 和已有 Workspace join；
- 同父目录多仓库和任意路径混合布局；
- Claude → Context Git → Codex；
- Codex → Context Git → Claude；
- 目标文件首次接管、手动漂移和重新生成；
- Context Git fast-forward、divergence 和 push race；
- check 结果确认后替代旧规则；
- 部分业务仓库未克隆时仍可同步 Workspace。

### 14.4 端到端验收

使用两个临时用户目录、两个业务仓库和一个 bare Context remote 模拟两名成员：

1. 成员 A 从 Claude Code 来源提取 Workspace 和 Repo 知识；
2. Context Git 发布成功；
3. 成员 B 只克隆其中一个业务仓库并 join；
4. Codex 目标文件只包含 Workspace 与已克隆仓库适用知识；
5. 成员 B 新增冲突规则时系统阻止编译；
6. 解决并发布后，成员 A 能同步并生成一致的 Claude 文件；
7. 两端生成结果在相同知识版本下可重复且内容摘要一致。

## 15. MVP 验收标准

MVP 完成必须同时满足：

1. Skill 可完成 `init`、`join`、`add-repo`、`inspect`、`capture`、`apply`、`sync`、`check` 和 `doctor` 工作流。
2. 同一 Workspace 可关联至少十个业务仓库，成员只克隆任意子集仍能工作。
3. 同父目录扫描与父目录外手动添加均可用，业务仓库无需移动或软链接。
4. Claude Code Adapter 能报告项目规则、嵌套规则、imports、rules 和 Auto Memory 来源。
5. Codex Adapter 能报告 AGENTS 层级、override/fallback、size limit 和可归属的 local memories。
6. Agent 动态分类输出必须通过 Schema，分类新类型无需改脚本。
7. 未经确认，Context Git 和业务仓库均无内容写入。
8. 确认后 Context Git 自动提交和推送；业务仓库只产生 tracked 文件变更，不自动提交。
9. 已知冲突、目标文件漂移或 Git divergence 不会被静默覆盖。
10. `check` 为每条结论提供可定位证据，修改仍需确认。
11. 相同输入和知识版本生成完全相同的目标文件。
12. 端到端测试覆盖 Claude 与 Codex 双向闭环。

## 16. 分阶段范围

### v0.1：发现与 Workspace

- Skill 骨架和内部脚本；
- init/join/add-repo/inspect/doctor；
- Context Git 和本机 Manifest；
- Claude/Codex 稳定 Adapter 与 Coverage Report。

### v0.2：知识闭环

- Extraction Schema 和动态分类；
- capture、Knowledge Store、Git 发布；
- Compiler、apply、sync；
- 完整覆盖与漂移检测。

### v0.3：治理

- check 和证据模型；
- 知识级冲突处理；
- 实验性运行时追踪；
- 性能与大 Workspace 优化。

### 后续方向

- Cursor 和其他 Agent Adapter；
- MCP 或独立 CLI 作为额外入口；
- Context Git PR 审核模式；
- 团队权限、签名和策略；
- 可视化知识时间线。

## 17. 已确认产品决策

- 团队 Workspace 优先，同时覆盖个人本机多 Agent 切换。
- 使用独立 Context Git 仓库。
- 发现只读，所有应用先展示并确认。
- 知识结构化，分类由 Agent 动态决定。
- MVP 深度支持 Claude Code 与 Codex。
- Skill-first，内部脚本承担确定性操作。
- 支持 Workspace 与 Repository 两级知识，并提取各业务仓库已有知识。
- 目标 Agent 文件完整覆盖生成，不维护重复托管区块。
- `check` 只给证据和建议，确认后才修改。
- 使用 Manifest 路径映射；软链接聚合视图不是核心机制。
- 支持同父目录自动扫描和任意目录手动添加。
- 生成文件默认提交到业务仓库。
- 稳定 Adapter 为主，运行时文件追踪作为实验功能。
- Context Git 自动提交推送；业务仓库不自动提交。
