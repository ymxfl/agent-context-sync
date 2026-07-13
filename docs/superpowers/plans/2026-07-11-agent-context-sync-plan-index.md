# Agent Context Sync 实施计划总览

已批准的 MVP 拆分为三个可独立验收的计划。请按顺序执行：每一版都会发布下一版依赖的接口。

1. [v0.1 Workspace 与发现](./2026-07-11-agent-context-sync-v0.1-workspace-discovery.md)
   - 交付物：跨 Agent 的 Skill 可 init/join 虚拟 Workspace、映射仓库、inspect Claude Code 与 Codex 上下文源，并运行 doctor。
2. [v0.2 知识同步与编译](./2026-07-11-agent-context-sync-v0.2-knowledge-sync.md)
   - 交付物：经审核的 Agent 提案成为结构化、Git 托管的知识，并确定性编译为受版本控制的 `AGENTS.md` 与 `CLAUDE.md`。
3. [v0.3 验证与实验性发现](./2026-07-11-agent-context-sync-v0.3-governance.md)
   - 交付物：`check` 用代码证据校验知识、知识冲突可审核，可选运行时追踪用于发现未知上下文源。

每个计划必须先通过自身验收套件，再开始下一计划。不要跨计划合并提交。

## 设计覆盖对照

| 已批准设计范围 | 由谁实现 |
|---|---|
| Skill-first 打包与确定性脚本 | v0.1 Task 1 |
| 稳定 Workspace 与仓库身份 | v0.1 Tasks 2-5 |
| 同父目录扫描、任意路径与符号链接安全映射 | v0.1 Tasks 3-5 |
| Claude Code 与 Codex 稳定发现 Adapter | v0.1 Tasks 6-8 |
| Coverage Report 与 doctor | v0.1 Task 8 |
| 开放结构化知识与溯源 | v0.2 Tasks 1-4 |
| Context Git 审核、提交、推送与竞态处理 | v0.2 Task 5 |
| 作用域过滤、活跃冲突阻断与确定性编译 | v0.2 Tasks 6-7 |
| 完整生成文件替换、漂移检测与业务 Git 边界 | v0.2 Task 8 |
| 证据驱动的 check 与审核后变更 | v0.3 Tasks 1-3 |
| 知识级分叉历史协调 | v0.3 Task 4 |
| 可选运行时追踪 | v0.3 Task 5 |
| 十仓、部分克隆、隐私与性能验收 | v0.3 Task 6 |
