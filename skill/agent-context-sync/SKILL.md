---
name: agent-context-sync
description: Discover Claude Code and Codex context across a virtual multi-repository Workspace, capture shared knowledge, and apply generated Agent guidance files.
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

`init`, `join`, `add-repo`, `capture`, `check`, and `apply` are two-phase (or
three-phase) operations. Always run the prepare/preview phase first, show the
user the exact impact, and preserve the opaque `preview_id`. Ask exactly one approval question at a time.
Run the matching apply command only after explicit approval of that exact preview.
Preview IDs expire and are one-time. Never reuse or invent them.
If a preview reports ambiguous clone candidates, do not ask for apply approval.
Rerun the same preview command with repeatable `--binding repo_id=path` options
until each ambiguous identity has one explicit local binding.

Coverage states are `covered`, `partial`, `unknown`, and `inaccessible`.
Never interpret `unknown` coverage as complete. Treat `partial`, `unknown`, and
`inaccessible` as limits that must remain visible to the user.

Never silently overwrite drifted generated files. If `apply preview` reports
`drift_candidates`, stop and either capture the manual edits or ask the user to
discard them before rendering again. Never run `git add`, `commit`, or `push` in
a business repository.

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

### Capture knowledge into Context Git

1. Prepare a redacted extraction packet.
2. Ask the active Agent to return schema-constrained proposal JSON for that packet.
3. Preview the capture impact and obtain approval.
4. Apply to publish one Context Git commit (never force-push).

```sh
node "$SKILL_DIR/scripts/acs.mjs" capture prepare --workspace ws_01J00000000000000000000000 --agent claude-code
node "$SKILL_DIR/scripts/acs.mjs" capture preview --packet-id "$PACKET_ID" --proposal /tmp/proposal.json
node "$SKILL_DIR/scripts/acs.mjs" capture apply --preview-id "$PREVIEW_ID"
```

### Check active knowledge against code evidence

1. Prepare bounded verification packets for active knowledge in scope.
2. Ask the active Agent for schema-constrained verification findings.
3. Preview creates/updates/supersede/archive impact and obtain approval.
4. Apply publishes Context Git knowledge only (`required_apply: true`); then run
   a separate `apply` preview/apply if Agent files must refresh.

Do not infer `stale` from age alone. Use `unverifiable` when evidence is
insufficient, and cite `attempted_checks`. Cite concrete file, dependency,
config, or git-commit evidence for `valid`, `stale`, and `contradicted`.

```sh
node "$SKILL_DIR/scripts/acs.mjs" check prepare --workspace ws_01J00000000000000000000000 --repository github.com/acme/api
node "$SKILL_DIR/scripts/acs.mjs" check preview --packet-id "$PACKET_ID" --proposal /tmp/check-proposal.json
node "$SKILL_DIR/scripts/acs.mjs" check apply --preview-id "$PREVIEW_ID"
```

### Apply generated Agent files

Compile Context knowledge into native `AGENTS.md` / `CLAUDE.md` files. Preview
shows complete unified diffs, Context HEAD, business HEADs, and drift candidates.
Apply writes backups under the local ACS home, then atomically replaces files per
repository. Business Git history is left unchanged for the user to commit.

```sh
node "$SKILL_DIR/scripts/acs.mjs" apply preview --workspace ws_01J00000000000000000000000 --agent codex
node "$SKILL_DIR/scripts/acs.mjs" apply preview --workspace ws_01J00000000000000000000000 --agent claude-code --agent codex
node "$SKILL_DIR/scripts/acs.mjs" apply apply --preview-id "$PREVIEW_ID"
```

Omit `--agent` to render both Claude Code and Codex. Repeat `--agent` to choose
one or both explicitly.

### Sync workflow (Skill-orchestrated)

`sync` is prepare-only in the CLI. Orchestrate the full loop yourself:

1. `sync prepare` or `capture prepare` → extraction packet
2. Ask the Agent for schema JSON proposal
3. `capture preview` → approval → `capture apply` (Context Git publish)
4. `apply preview` → approval → `apply apply` (business file replacement)

```sh
node "$SKILL_DIR/scripts/acs.mjs" sync prepare --workspace ws_01J00000000000000000000000 --agent claude-code
```

### Experimental runtime tracing (opt-in)

Discover unknown context file paths by tracing Agent process file access.
Requires both `--experimental` and `--consent-path-metadata`. Records path
metadata only (open/stat/readlink-style events); never reads file contents.
Unavailable providers are reported without failing stable discovery. Windows is
unavailable in v0.3.

```sh
node "$SKILL_DIR/scripts/acs.mjs" trace run --experimental --consent-path-metadata --workspace ws_01J00000000000000000000000 --agent claude-code --command /usr/bin/true
```

Repeat `--arg` for command arguments. Candidates are hints for a later stable
`inspect` / `capture` — tracing never mutates Adapter coverage.

Report failed JSON envelopes without inventing a repair. If a repair would
write, return to the relevant preview/approval/apply workflow.
