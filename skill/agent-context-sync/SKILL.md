---
name: agent-context-sync
description: Discover Claude Code and Codex context across a virtual multi-repository Workspace.
---

# Agent Context Sync

Use the bundled `scripts/acs.mjs` launcher. It emits exactly one JSON envelope on stdout:
`{"ok":true,"command":"...","data":...}` or
`{"ok":false,"command":"...","error":{"code":"...","message":"...","details":{...}}}`.
`details` is optional and contains only sanitized, stable remediation fields.
Do not treat stderr or exception text as structured output.

Set `AGENT_CONTEXT_SYNC_HOME` when the registry should live somewhere other than
`~/.agent-context-sync`. `HOME` is the Agent home used for context discovery;
Codex also honors `CODEX_HOME`.

## Safety and approval

`inspect` and `doctor` are strictly read-only. They may read files and query Git,
but must not repair, stage, commit, push, or change a business repository.

`init`, `join`, and `add-repo` are two-phase operations. Always run `preview`
first, show the user the exact `files_to_write`, repositories, and warnings, and
preserve the opaque `data.preview.preview_id`. Ask exactly one approval question at a time.
Run the matching `apply` command only after explicit approval of that
exact preview. Preview IDs expire and are one-time. Never reuse or invent them.
If a preview reports ambiguous clone candidates, do not ask for apply approval.
Rerun the same preview command with repeatable `--binding repo_id=path` options
until each ambiguous identity has one explicit local binding.

Coverage states are `covered`, `partial`, `unknown`, and `inaccessible`.
Never interpret `unknown` coverage as complete. Treat `partial`, `unknown`, and
`inaccessible` as limits that must remain visible to the user.

## Exact workflows

`$SKILL_DIR` below is the installed `agent-context-sync` Skill directory.
`$PREVIEW_ID` must be the exact string at `data.preview.preview_id` in the
preceding successful response.

Initialize a Workspace:

```sh
node "$SKILL_DIR/scripts/acs.mjs" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" init apply --preview-id "$PREVIEW_ID"
```

Join an existing Workspace. Repeat `--scan-root` when needed:

```sh
node "$SKILL_DIR/scripts/acs.mjs" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2 --binding github.com/acme/api=/work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" join apply --preview-id "$PREVIEW_ID"
```

Add or bind a repository:

```sh
node "$SKILL_DIR/scripts/acs.mjs" add-repo preview --workspace ws_01J00000000000000000000000 --repository /work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" add-repo apply --preview-id "$PREVIEW_ID"
```

Show the authenticated `normalized_input.mode` from the preview. `add-shared`
may write and push Context files. `bind-existing` may update only the private
local registry, and an already-identical binding is a no-op.

Inspect locally bound repositories for one supported Agent. Repeat
`--repository` to restrict the request; omit it to inspect every local binding:

```sh
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent codex
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent claude-code --repository github.com/acme/api
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent codex --repository github.com/acme/api --cwd /work/acme/api/packages/api
```

Run fixed, read-only diagnostics:

```sh
node "$SKILL_DIR/scripts/acs.mjs" doctor --workspace ws_01J00000000000000000000000
```

Report failed JSON envelopes without inventing a repair. If a repair would
write, return to the relevant preview/approval/apply workflow.
