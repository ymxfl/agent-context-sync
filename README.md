# Agent Context Sync

Agent Context Sync is a portable Agent Skill for discovering the context that
Claude Code and Codex are expected to load across a virtual multi-repository
Workspace. v0.1 discovers and reports existing context; it does not compile or
overwrite Agent instruction files.

## Install

Build the standalone launcher, then copy the whole Skill directory into the
Agent you use:

```sh
npm ci
npm run build

mkdir -p ~/.codex/skills ~/.claude/skills
cp -R skill/agent-context-sync ~/.codex/skills/agent-context-sync
cp -R skill/agent-context-sync ~/.claude/skills/agent-context-sync
```

The built `scripts/acs.mjs` includes its runtime dependencies. The source
checkout and its `node_modules` directory are not needed after installation.
Node.js 20 or newer and Git must be available.

## Workspace model

A Workspace is virtual: repositories stay at their real filesystem locations
and are never moved under a synthetic parent directory. A stable Workspace ID
and repository identities are shared in a dedicated Context Git repository.
Absolute local paths remain private in
`~/.agent-context-sync/workspaces/<workspace_id>.yaml` (or under
`AGENT_CONTEXT_SYNC_HOME`) and are never written to the shared manifest.

v0.1 supports Claude Code and Codex. Their Adapters report known context sources,
load order, shareability, and coverage as `covered`, `partial`, `unknown`, or
`inaccessible`. An `unknown` result is a boundary, not evidence of complete
coverage.

## Commands

Every command emits one JSON envelope on stdout. `init`, `join`, and `add-repo`
require a preview followed by explicit approval and apply of the exact preview
JSON. Examples use `ACS` for the installed launcher and `PREVIEW_JSON` for the
exact compact object returned at `data.preview`.

```sh
ACS="$HOME/.codex/skills/agent-context-sync/scripts/acs.mjs"

node "$ACS" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$ACS" init apply --preview-json "$PREVIEW_JSON"

node "$ACS" join preview --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
node "$ACS" join apply --preview-json "$PREVIEW_JSON"

node "$ACS" add-repo preview --workspace "$WORKSPACE_ID" --repository /work/acme/api
node "$ACS" add-repo apply --preview-json "$PREVIEW_JSON"

node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent codex
node "$ACS" inspect --workspace "$WORKSPACE_ID" --agent claude-code
node "$ACS" doctor --workspace "$WORKSPACE_ID"
```

Repeat `--scan-root` for multiple join roots and `--repository` to restrict an
inspect request. Omit `--repository` to inspect every locally bound repository.
The default registry root is `~/.agent-context-sync`; override it with
`AGENT_CONTEXT_SYNC_HOME`. Agent-level discovery uses `HOME`, and Codex also
honors `CODEX_HOME`.

## Safety boundaries

- `inspect` and `doctor` are read-only. `doctor` reports fixed diagnostics and
  does not repair anything.
- Preview phases do not persist Workspace changes. Apply rejects altered or
  stale preview JSON.
- Context commits and pushes occur only in approved apply phases.
- No v0.1 command commits, pushes, resets, cleans, or force-updates a business
  repository. Inspect and doctor do not change business file contents.
- v0.1 does not capture knowledge, compile generated Agent files, or claim
  complete coverage for unknown mechanisms.
