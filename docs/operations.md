# Operations

Operational runbook for Agent Context Sync (ACS) after Workspace init/join.

## Backup

Back up both the private ACS home and the shared Context Git remote.

- **Private home** (`~/.agent-context-sync` or `AGENT_CONTEXT_SYNC_HOME`): local Workspace registry YAML, preview authorization records, verification packets, reconcile packets, and the content cache under `cache/`. Treat this tree as machine-local; it may contain absolute paths.
- **Context remote**: the dedicated Context Git repository is the source of truth for shared Workspace manifests and knowledge. Use ordinary Git hosting backups or mirrors. Do not force-push; ACS never force-updates Context history.

Restore by reinstalling the Skill, restoring the ACS home directory if needed, and re-joining or re-binding repositories against the Context remote.

## Context remote migration

To move the Context remote URL:

1. Ensure every member has pushed or reconciled outstanding Context work.
2. Update the remote on a clean Context checkout (`git remote set-url origin <new-url>`), push all refs that members need, and verify `ls-remote`.
3. Update `context_remote` in the shared Workspace manifest through a reviewed Context commit (or re-init only when creating a new Workspace identity).
4. Ask each member to refresh their local Context checkout (re-join or re-clone into the expected ACS contexts path) so registry paths still resolve.

Do not rewrite published Context commit SHAs. Members with divergent history must run `reconcile` instead of resetting.

## Schema compatibility

Shared Context documents and local preview packets use explicit `schema_version` fields. ACS validates on read.

- Newer clients may reject older unsupported schema versions; upgrade the Skill before migrating data formats.
- Older clients must not write unknown fields into shared knowledge or Workspace manifests.
- When introducing a breaking schema, publish a Context commit that only newer clients can apply, and document the minimum Skill version for the Workspace.

## Resolving divergence

When local and remote Context histories diverge:

1. `reconcile prepare --workspace <id>` classifies knowledge-level automatic merges and conflicts.
2. Review conflicts; return a proposal with an explicit resolution for every conflict.
3. `reconcile preview` then `reconcile apply` publishes a merge commit without force-push.

Additive changes on both sides usually auto-merge. Same-entry edits require an Agent choice (`local`, `remote`, `combine`, or `disputed`).

## Generated-file drift

`apply preview` / `apply apply` write generated `AGENTS.md` / `CLAUDE.md` (and related native files) only after approval. If a target file drifted from the last ACS-managed content, apply refuses to overwrite it silently. Resolve by restoring the managed file, accepting a fresh preview after intentional edits are reconciled, or removing the drifted file when regeneration is desired. ACS never commits or pushes business repositories.

## Privacy boundaries

- Absolute local paths stay in the private ACS home registry and must not be committed to the Context remote.
- Capture and check redaction strips secrets and absolute local roots from shared packets before Context publish.
- Personal / managed Agent sources remain Adapter-reported; team shareability is required before shared knowledge publish.
- Preview authorization MACs, cache contents, and verification packets are local-only artifacts.

## Experimental trace consent

`trace run` is opt-in and experimental:

- Requires explicit flags for experimental use and path-metadata consent.
- Records path metadata only; it does not store file contents.
- Failure or unavailable platform providers must not block stable `inspect` coverage.
- Do not treat trace candidates as automatic Adapter coverage upgrades; review before changing discovery contracts.

## Cache maintenance

ACS stores a bounded hash-keyed cache under `<ACS_HOME>/cache/` for discovery reports and verification evidence. Writes are atomic.

`doctor` reports `cache-integrity` warnings when entries are corrupt and recommends manual removal. Doctor never deletes cache files. To clear the cache after review:

```sh
rm -rf "${AGENT_CONTEXT_SYNC_HOME:-$HOME/.agent-context-sync}/cache"
```
