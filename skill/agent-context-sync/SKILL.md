---
name: agent-context-sync
description: Synchronize portable agent context across Git repositories.
---

# Agent Context Sync

Use the bundled `scripts/acs.mjs` command to manage portable agent context.

All writes require a preview followed by explicit user approval before the write is performed.

## Commands

- `init` initializes an agent context workspace.
- `join` joins an existing context workspace.
- `add-repo` adds a repository to the workspace.
- `inspect` inspects the current context configuration.
- `doctor` diagnoses configuration and repository problems.
