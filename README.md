# Agent Context Sync

Agent Context Sync is a portable Agent Skill for discovering, capturing, and
syncing the context that Claude Code and Codex are expected to load across a
virtual multi-repository Workspace. Shared knowledge lives in a dedicated
Context Git repository; generated `AGENTS.md` and `CLAUDE.md` files are derived
tracked files in business repositories.

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

Supported agents are Claude Code and Codex. Their Adapters report known context
sources, load order, shareability, and coverage as `covered`, `partial`,
`unknown`, or `inaccessible`. An `unknown` result is a boundary, not evidence of
complete coverage.

## Commands

Every command emits one JSON envelope on stdout. Write operations require a
preview (or prepare) phase followed by explicit approval and apply by the opaque
`preview_id`. Preview authorization is stored privately under the ACS home with
mode `0600`, expires, and can be applied only once. Examples use `ACS` for the
installed launcher and `PREVIEW_ID` for `data.preview.preview_id`.
Failed envelopes may include sanitized, stable `error.details` fields for
automation; raw OS and parser errors are not exposed there.

```sh
ACS="$HOME/.codex/skills/agent-context-sync/scripts/acs.mjs"

node "$ACS" init preview --name platform --context-remote git@github.com:acme/platform-context.git --scan-root /work/acme --max-depth 2
# If preview reports duplicate clone candidates, rerun it with an explicit binding:
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

Repeat `--scan-root` for multiple join roots and `--repository` to restrict an
inspect or apply request. Repeat `--binding repo_id=path` when explicit clone
selection is needed; an ambiguous preview cannot be applied until every duplicate
identity is bound. Omit `--repository` to inspect or apply every locally bound
repository. Omit `--agent` on `apply preview` to render both agents; repeat
`--agent` to choose explicitly.

The default registry root is `~/.agent-context-sync`; override it with
`AGENT_CONTEXT_SYNC_HOME`. Agent-level discovery uses `HOME`, and Codex also
honors `CODEX_HOME`.

`add-repo` previews authenticate a `mode` of `add-shared` or `bind-existing`.
Binding an identity already present in the shared Workspace updates only the
private local registry; an already-identical binding is a deterministic no-op.

`sync prepare` is equivalent to `capture prepare`. Full sync orchestration is
Skill-driven: prepare capture → agent proposal → capture preview/apply → apply
preview/apply.

Daily workflow summary:

1. **init** or **join** a Workspace against the Context remote.
2. **inspect** / **doctor** to understand Adapter coverage and local health.
3. **capture** (or **sync prepare**) to extract and publish shared knowledge.
4. **apply** to render native Agent guidance into business repositories.
5. **check** when knowledge may be stale against code evidence.
6. **reconcile** when Context Git histories diverge.
7. **trace** only with explicit experimental consent when hunting unknown sources.

## Safety boundaries

- `inspect` and `doctor` are read-only. `doctor` reports fixed diagnostics and
  does not repair anything, including corrupt cache entries (see
  [docs/operations.md](docs/operations.md)).
- Preview phases do not persist Workspace or business-repository changes; they
  persist only private, expiring authorization records. Apply rejects altered,
  expired, reused, stale, or concurrently claimed preview IDs.
- Context commits and pushes occur only in approved capture, check, and
  reconcile apply phases.
- Generated Agent files are written only in approved apply apply phases, with
  drift detection; drifted targets are never silently overwritten.
- No command commits, pushes, resets, cleans, or force-updates a business
  repository.
- Discovery and verification evidence may be cached under the ACS home; cache
  hits reduce repeated file reads. `inspect` JSON may include `data.stats.files_read`.
