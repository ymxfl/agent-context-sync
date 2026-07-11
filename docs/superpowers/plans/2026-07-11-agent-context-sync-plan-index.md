# Agent Context Sync Implementation Program

The approved MVP is split into three independently testable plans. Execute them in order because each plan publishes interfaces consumed by the next.

1. [v0.1 Workspace and Discovery](./2026-07-11-agent-context-sync-v0.1-workspace-discovery.md)
   - Deliverable: a cross-agent Skill can init/join a virtual Workspace, map repositories, inspect Claude Code and Codex context sources, and run doctor.
2. [v0.2 Knowledge Sync and Compilation](./2026-07-11-agent-context-sync-v0.2-knowledge-sync.md)
   - Deliverable: reviewed Agent proposals become structured Git-backed knowledge and deterministically compile into tracked AGENTS.md and CLAUDE.md files.
3. [v0.3 Verification and Experimental Discovery](./2026-07-11-agent-context-sync-v0.3-governance.md)
   - Deliverable: check verifies knowledge against code evidence, knowledge conflicts are reviewable, and optional runtime tracing discovers unknown context sources.

Each plan must pass its own acceptance suite before the next begins. Do not combine commits across plans.

## Design Coverage

| Approved design area | Implemented by |
|---|---|
| Skill-first packaging and deterministic scripts | v0.1 Task 1 |
| Stable Workspace and repository identity | v0.1 Tasks 2-5 |
| Same-parent scan, arbitrary paths, and symlink-safe mapping | v0.1 Tasks 3-5 |
| Claude Code and Codex stable discovery Adapters | v0.1 Tasks 6-8 |
| Coverage Report and doctor | v0.1 Task 8 |
| Open structured knowledge and provenance | v0.2 Tasks 1-4 |
| Context Git review, commit, push, and race handling | v0.2 Task 5 |
| Scope filtering, active conflict blocking, and deterministic compilation | v0.2 Tasks 6-7 |
| Full generated-file replacement, drift detection, and business Git boundary | v0.2 Task 8 |
| Evidence-backed check and reviewed mutation | v0.3 Tasks 1-3 |
| Knowledge-level divergent-history reconciliation | v0.3 Task 4 |
| Opt-in runtime tracing | v0.3 Task 5 |
| Ten-repository, partial-clone, privacy, and performance acceptance | v0.3 Task 6 |
