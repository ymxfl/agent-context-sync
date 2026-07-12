---
name: agent-context-sync
description: Discover Claude Code and Codex context across a virtual multi-repository Workspace.
---

# Agent Context Sync

Use the bundled `scripts/acs.mjs` launcher. It emits exactly one JSON envelope on stdout:
`{"ok":true,"command":"...","data":...}` or
`{"ok":false,"command":"...","error":{"code":"...","message":"..."}}`.
Do not treat stderr or exception text as structured output.

Set `AGENT_CONTEXT_SYNC_HOME` when the registry should live somewhere other than
`~/.agent-context-sync`. `HOME` is the Agent home used for context discovery;
Codex also honors `CODEX_HOME`.

## Safety and approval

`inspect` and `doctor` are strictly read-only. They may read files and query Git,
but must not repair, stage, commit, push, or change a business repository.

`init`, `join`, and `add-repo` are two-phase operations. Always run `preview`
first, show the user the exact `files_to_write`, repositories, and warnings, and
preserve the exact `data.preview` JSON object. Ask exactly one approval question at a time.
Run the matching `apply` command only after explicit approval of that
exact preview. Never reuse, edit, summarize, or reconstruct preview JSON.

Coverage states are `covered`, `partial`, `unknown`, and `inaccessible`.
Never interpret `unknown` coverage as complete. Treat `partial`, `unknown`, and
`inaccessible` as limits that must remain visible to the user.

## Exact workflows

`$SKILL_DIR` below is the installed `agent-context-sync` Skill directory.
`$PREVIEW_JSON` must be the exact compact JSON value at `data.preview` in the
preceding successful response, not the entire response envelope.

Initialize a Workspace:

```sh
node "$SKILL_DIR/scripts/acs.mjs" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" init apply --preview-json "$PREVIEW_JSON"
```

Join an existing Workspace. Repeat `--scan-root` when needed:

```sh
node "$SKILL_DIR/scripts/acs.mjs" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$SKILL_DIR/scripts/acs.mjs" join apply --preview-json "$PREVIEW_JSON"
```

Add or bind a repository:

```sh
node "$SKILL_DIR/scripts/acs.mjs" add-repo preview --workspace ws_01J00000000000000000000000 --repository /work/acme/api
node "$SKILL_DIR/scripts/acs.mjs" add-repo apply --preview-json "$PREVIEW_JSON"
```

Inspect locally bound repositories for one supported Agent. Repeat
`--repository` to restrict the request; omit it to inspect every local binding:

```sh
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent codex
node "$SKILL_DIR/scripts/acs.mjs" inspect --workspace ws_01J00000000000000000000000 --agent claude-code --repository github.com/acme/api
```

Run fixed, read-only diagnostics:

```sh
node "$SKILL_DIR/scripts/acs.mjs" doctor --workspace ws_01J00000000000000000000000
```

Report failed JSON envelopes without inventing a repair. If a repair would
write, return to the relevant preview/approval/apply workflow.
