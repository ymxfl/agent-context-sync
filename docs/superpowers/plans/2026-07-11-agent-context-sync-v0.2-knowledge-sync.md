# Agent Context Sync v0.2 Knowledge Sync and Compilation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Convert reviewed Agent proposals into structured Git-backed knowledge and deterministically compile applicable knowledge into tracked AGENTS.md and CLAUDE.md files.

**Architecture:** Discovery output becomes an immutable extraction packet. The active Agent writes a schema-constrained proposal; deterministic code validates, previews, stores, publishes, compiles, and atomically applies it. Preview IDs bind every approval to exact Context and business repository states so stale approval cannot write.

**Tech Stack:** The v0.1 Node.js 20+/TypeScript/Vitest stack plus JSON Schema exports from Zod, SHA-256 source hashing, the diff package for unified diffs, and the existing safe Git wrapper.

## Global Constraints

- Complete v0.1 and keep all v0.1 acceptance tests passing.
- Context Git is the only source of truth; generated Agent files are derived, tracked business-repository files.
- Knowledge kind is open kebab-case; behavior must not depend on a closed kind enum.
- Shared sources contain no absolute local paths or unselected private-memory copies.
- Every Context or business-repository write requires a non-stale preview and explicit user approval.
- Context Git may commit and push after approval; business repositories must never be committed or pushed by the tool.
- Known active conflicts fail compilation instead of being resolved by timestamp.
- Same inputs and Context commit must produce byte-identical output.

---

## File Map

- src/schema/knowledge.ts: canonical KnowledgeEntry and relation validation.
- src/schema/extraction.ts: Agent proposal and rejection schemas.
- src/knowledge/store.ts: one-entry-per-Markdown persistence.
- src/knowledge/graph.ts: supersedes/conflicts graph and active-set validation.
- src/security/redact.ts: secrets and local-path detection.
- src/extraction/packet.ts: immutable discovery packet creation.
- src/extraction/proposal.ts: proposal validation, dedupe, and preview.
- src/git/context-publisher.ts: fast-forward preflight, commit, and push.
- src/compiler/select.ts: scope/path/agent selection.
- src/compiler/compile.ts: deterministic section model.
- src/adapters/claude/render.ts and src/adapters/codex/render.ts: native renderers.
- src/apply/preview.ts and src/apply/atomic-apply.ts: diff, drift checks, and atomic replacement.
- src/commands/capture.ts, apply.ts, sync.ts: workflows exposed to the Skill.

### Task 1: Define Canonical Knowledge and Extraction Schemas

**Files:**
- Create: src/schema/knowledge.ts
- Create: src/schema/extraction.ts
- Create: tests/schema/knowledge.test.ts
- Create: tests/schema/extraction.test.ts
- Modify: src/domain/model.ts

**Interfaces:**
- Produces: KnowledgeEntry, KnowledgeStatus, KnowledgeScope, SourceReference
- Produces: ExtractionProposal, ProposedKnowledge, RejectedCandidate
- Produces: parseKnowledgeEntry(value: unknown): KnowledgeEntry
- Produces: parseExtractionProposal(value: unknown): ExtractionProposal

- [ ] **Step 1: Write failing open-kind and relation tests**

~~~ts
expect(parseKnowledgeEntry({
  schema_version: 1,
  id: 'kn_01J00000000000000000000000',
  kind: 'database-failure-mode',
  scope: 'repository:github.com/acme/api',
  status: 'active',
  applies_to: { paths: ['src/db/**'], agents: ['claude-code', 'codex'] },
  source: { agent: 'claude-code', source_type: 'auto-memory', locator: 'memory/MEMORY.md', content_hash: hash, observed_at: now },
  confidence: 0.9,
  supersedes: [],
  conflicts_with: [],
  created_at: now,
  updated_at: now,
  last_verified_at: null,
  statement: 'Use WAL only in a single writer process.',
  reason: 'Multiple writers produced SQLITE_BUSY.',
}).kind).toBe('database-failure-mode');

expect(() => parseKnowledgeEntry({ ...valid, kind: 'Bad Kind' })).toThrow();
expect(() => parseExtractionProposal({ ...proposal, accepted: [], rejected: [] })).not.toThrow();
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/schema/knowledge.test.ts tests/schema/extraction.test.ts

Expected: FAIL because the schemas do not exist.

- [ ] **Step 3: Implement strict schemas**

Use literal schema_version 1. Knowledge status is active, superseded, archived, or disputed. Scope is workspace or repository:<repo-id>. kind matches /^[a-z0-9]+(?:-[a-z0-9]+)*$/. Agent names are open strings but MVP renderers recognize claude-code and codex. Store statement and reason as schema fields so validation does not parse Markdown headings.

- [ ] **Step 4: Run focused and regression tests**

Run: npm test -- --run tests/schema && npm run verify

Expected: all v0.1 and new schema tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/schema src/domain/model.ts tests/schema
git commit -m "feat: define structured knowledge proposals"
~~~

### Task 2: Store Knowledge as Canonical Markdown

**Files:**
- Create: src/knowledge/markdown.ts
- Create: src/knowledge/store.ts
- Create: src/knowledge/graph.ts
- Test: tests/knowledge/store.test.ts
- Test: tests/knowledge/graph.test.ts

**Interfaces:**
- Consumes: KnowledgeEntry
- Produces: serializeKnowledge(entry: KnowledgeEntry): string
- Produces: parseKnowledgeMarkdown(text: string): KnowledgeEntry
- Produces: KnowledgeStore.list(), get(id), put(entry)
- Produces: validateKnowledgeGraph(entries: KnowledgeEntry[]): GraphIssue[]

- [ ] **Step 1: Write failing round-trip and graph tests**

~~~ts
const text = serializeKnowledge(entry);
expect(parseKnowledgeMarkdown(text)).toEqual(entry);
expect(text).not.toContain('/Users/alice');

expect(validateKnowledgeGraph([
  { ...a, supersedes: [b.id] },
  { ...b, supersedes: [a.id] },
])).toContainEqual(expect.objectContaining({ code: 'SUPERSEDES_CYCLE' }));
~~~

Also assert IDs determine paths, archived entries are not moved, and a conflicts_with relation is symmetric after normalization.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/knowledge

Expected: FAIL because storage modules do not exist.

- [ ] **Step 3: Implement deterministic serialization and graph checks**

Sort frontmatter keys and arrays, use LF endings and one final newline. Map workspace entries to knowledge/workspace/<id>.md and repository entries to knowledge/repositories/<repo-id>/<id>.md. Reject duplicate IDs, missing relation targets, self-relations, supersedes cycles, and active entries superseded by missing knowledge.

- [ ] **Step 4: Verify focused and full tests**

Run: npm test -- --run tests/knowledge && npm run verify

Expected: all pass and repeated serialization is byte-identical.

- [ ] **Step 5: Commit**

~~~bash
git add src/knowledge tests/knowledge
git commit -m "feat: persist canonical knowledge markdown"
~~~

### Task 3: Build Safe Extraction Packets and Redaction

**Files:**
- Create: src/security/redact.ts
- Create: src/extraction/packet.ts
- Create: tests/security/redact.test.ts
- Create: tests/extraction/packet.test.ts

**Interfaces:**
- Consumes: CoverageReport[] and existing KnowledgeEntry[]
- Produces: redactCandidate(value: string, localRoots: string[]): RedactionResult
- Produces: createExtractionPacket(input: PacketInput): ExtractionPacket
- ExtractionPacket includes packet_id, context_head, source hashes, selected excerpts, existing summaries, and JSON output contract

- [ ] **Step 1: Write failing secret and immutability tests**

~~~ts
expect(redactCandidate('token=ghp_abcdefghijklmnopqrstuvwxyz123456', roots).redacted)
  .toContain('[REDACTED_SECRET]');
expect(redactCandidate('/Users/alice/work/api/src/a.ts', roots).redacted)
  .toContain('[REPOSITORY_ROOT]/src/a.ts');

const packet = createExtractionPacket(input);
expect(packet.sources[0]).not.toHaveProperty('absolutePath');
expect(Object.isFrozen(packet)).toBe(true);
expect(packet.packet_hash).toMatch(/^sha256:/);
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/security tests/extraction/packet.test.ts

Expected: FAIL because packet and redaction modules are absent.

- [ ] **Step 3: Implement conservative redaction and packet hashing**

Detect private key headers, common token prefixes, credential URLs, assignment-style secrets, and registered absolute roots. Preserve source locator, line range, content hash, and selected excerpt only. Canonicalize packet JSON before hashing and deep-freeze the returned packet.

- [ ] **Step 4: Run focused and full tests**

Run: npm test -- --run tests/security tests/extraction && npm run verify

Expected: all pass and snapshots contain no fixture secrets or absolute paths.

- [ ] **Step 5: Commit**

~~~bash
git add src/security src/extraction tests/security tests/extraction
git commit -m "feat: prepare redacted extraction packets"
~~~

### Task 4: Validate Agent Proposals and Preview Knowledge Changes

**Files:**
- Create: src/extraction/proposal.ts
- Create: src/preview/store.ts
- Create: src/commands/capture.ts
- Modify: src/main.ts
- Test: tests/extraction/proposal.test.ts
- Test: tests/integration/capture-preview.test.ts

**Interfaces:**
- Produces: prepareCapture(input: CaptureInput): Promise<ExtractionPacket>
- Produces: previewCapture(packetId: string, proposal: unknown): Promise<CapturePreview>
- Produces: CapturePreview with preview_id, packet_hash, context_head, creates, updates, archives, rejections, warnings

- [ ] **Step 1: Write failing dedupe and stale-proposal tests**

~~~ts
const preview = await previewCapture(packet.packet_id, proposal);
expect(preview.creates).toHaveLength(1);
expect(preview.duplicates).toContainEqual(expect.objectContaining({ existing_id: existing.id }));

expect(preview.context_head).toBe(packet.context_head);
expect(preview.packet_hash).toBe(packet.packet_hash);
~~~

Also reject a proposal that references a source hash absent from its packet or attempts to share a candidate marked personal without explicit include_personal approval.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/extraction/proposal.test.ts tests/integration/capture-preview.test.ts

Expected: FAIL because proposal previewing does not exist.

- [ ] **Step 3: Implement proposal normalization and preview storage**

Use exact source hashes first, then normalized statement hashes for deterministic duplicate candidates. Never use model embeddings in MVP. Store previews under the local home with mode 0o600; bind packet hash, Context HEAD, proposed file bytes, and expiry of 24 hours. previewCapture writes no Context files. Add diff as a runtime dependency in this task and lock it in package-lock.json.

- [ ] **Step 4: Run focused and regression tests**

Run: npm test -- --run tests/extraction tests/integration/capture-preview.test.ts && npm run verify

Expected: all pass and Context Git remains clean after preview.

- [ ] **Step 5: Commit**

~~~bash
git add src/extraction src/preview src/commands/capture.ts src/main.ts tests
git commit -m "feat: preview agent knowledge proposals"
~~~

### Task 5: Publish Approved Knowledge Safely

**Files:**
- Create: src/git/context-publisher.ts
- Modify: src/commands/capture.ts
- Test: tests/git/context-publisher.test.ts
- Test: tests/integration/capture-apply.test.ts

**Interfaces:**
- Consumes: CapturePreview from Task 4 and KnowledgeStore from Task 2
- Produces: applyCapture(previewId: string): Promise<PublishResult>
- Produces: ContextRemoteState { head, upstream, ahead, behind, diverged }

- [ ] **Step 1: Write failing fast-forward and race tests**

~~~ts
const result = await applyCapture(preview.preview_id);
expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
expect(await remoteContains(result.commit)).toBe(true);

await createRemoteCommitFromOtherClone();
await expect(applyCapture(otherPreview.preview_id)).rejects.toMatchObject({
  code: 'STALE_PREVIEW',
});
expect(await currentBranchWasForcePushed()).toBe(false);
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/git/context-publisher.test.ts tests/integration/capture-apply.test.ts

Expected: FAIL because publication is absent.

- [ ] **Step 3: Implement fetch/preflight/write/commit/push**

Fetch before writing. Fast-forward when behind-only, reject divergence, then recompute HEAD against preview. Write all knowledge files atomically, validate the whole graph, stage only workspace.yaml, repositories, knowledge, sources, and schema paths, create one semantic commit, and push without force. On push race, preserve the local commit and return REMOTE_CHANGED with recovery guidance.

- [ ] **Step 4: Run Git and full verification**

Run: npm test -- --run tests/git tests/integration/capture-apply.test.ts && npm run verify

Expected: all pass across ahead, behind, diverged, auth-error fixture, and push-race cases.

- [ ] **Step 5: Commit**

~~~bash
git add src/git src/commands/capture.ts tests/git tests/integration/capture-apply.test.ts
git commit -m "feat: publish approved context knowledge"
~~~

### Task 6: Select and Compile Applicable Knowledge

**Files:**
- Create: src/compiler/select.ts
- Create: src/compiler/compile.ts
- Create: src/compiler/conflicts.ts
- Test: tests/compiler/select.test.ts
- Test: tests/compiler/compile.test.ts

**Interfaces:**
- Produces: selectKnowledge(input: SelectionInput): KnowledgeEntry[]
- Produces: detectActiveConflicts(entries: KnowledgeEntry[]): CompileConflict[]
- Produces: compileSections(input: CompileInput): CompiledContext

- [ ] **Step 1: Write failing scope and conflict tests**

~~~ts
const selected = selectKnowledge({
  entries,
  repoId: 'github.com/acme/api',
  agent: 'codex',
  relativePath: 'src/auth/session.ts',
});
expect(selected.map((item) => item.id)).toEqual([workspaceRule.id, repoRule.id, pathRule.id]);

expect(() => compileSections({ entries: conflicting, target })).toThrowError(
  expect.objectContaining({ code: 'ACTIVE_KNOWLEDGE_CONFLICT' }),
);
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/compiler

Expected: FAIL because compiler modules do not exist.

- [ ] **Step 3: Implement deterministic selection and section ordering**

Exclude non-active entries and target-agent mismatches. Match paths with repository-relative POSIX globs. Order Workspace, Repository, path-specific, Agent-specific, then active-work; within a section order by stable ID. Fail when active conflicts lack a supersedes resolution or point to disputed knowledge.

- [ ] **Step 4: Run compiler and full tests**

Run: npm test -- --run tests/compiler && npm run verify

Expected: all pass and a 100-run determinism assertion produces one unique SHA-256.

- [ ] **Step 5: Commit**

~~~bash
git add src/compiler tests/compiler
git commit -m "feat: compile scoped agent context"
~~~

### Task 7: Render Native Claude and Codex Files

**Files:**
- Create: src/adapters/claude/render.ts
- Create: src/adapters/codex/render.ts
- Modify: src/adapters/adapter.ts
- Test: tests/adapters/claude-render.test.ts
- Test: tests/adapters/codex-render.test.ts
- Create: tests/fixtures/render-golden/
- Create: tests/helpers/golden.ts

**Interfaces:**
- Produces: render(input: RenderInput): RenderedFile[]
- RenderedFile includes relativePath, bytes, sha256, sourceKnowledgeIds
- Produces: goldenFiles(agent: 'claude' | 'codex'): Promise<RenderedFile[]>

- [ ] **Step 1: Write failing golden tests**

~~~ts
expect(renderClaude(input)).toEqual(await goldenFiles('claude'));
expect(renderCodex(input)).toEqual(await goldenFiles('codex'));
expect(renderCodex(input)[0].bytes.byteLength).toBeLessThanOrEqual(32768);
expect(decode(renderClaude(input)[0].bytes)).not.toContain('@AGENTS.md');
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/adapters/*-render.test.ts

Expected: FAIL because renderers do not exist.

- [ ] **Step 3: Implement full native rendering**

Both root files include a generated warning, Workspace ID, Context commit, content hash, and concise sections. Never include source absolute paths. Codex splits path-scoped content into nested AGENTS.md when the root would exceed configured max bytes. Claude emits .claude/rules/<stable-scope-id>.md for path-scoped knowledge and keeps CLAUDE.md under 200 lines where possible. Do not make CLAUDE.md import AGENTS.md because both are complete projections.

- [ ] **Step 4: Run golden and full tests**

Run: npm test -- --run tests/adapters tests/compiler && npm run verify

Expected: all pass and golden files have LF endings and one final newline.

- [ ] **Step 5: Commit**

~~~bash
git add src/adapters tests/adapters tests/fixtures/render-golden
git commit -m "feat: render native agent guidance"
~~~

### Task 8: Preview and Atomically Apply Generated Files

**Files:**
- Create: src/apply/preview.ts
- Create: src/apply/atomic-apply.ts
- Create: src/apply/drift.ts
- Create: src/commands/apply.ts
- Create: src/commands/sync.ts
- Modify: src/main.ts
- Modify: skill/agent-context-sync/SKILL.md
- Test: tests/integration/apply.test.ts
- Test: tests/e2e/v02-sync.test.ts

**Interfaces:**
- Produces: previewApply(input: ApplyInput): Promise<ApplyPreview>
- Produces: applyRendered(previewId: string): Promise<ApplyResult>
- Produces: syncPrepare(input: SyncInput): Promise<ExtractionPacket>
- ApplyPreview includes Context HEAD, business HEADs, complete unified diffs, generated hashes, and drift candidates

- [ ] **Step 1: Write failing drift and end-to-end tests**

~~~ts
const preview = await previewApply({ workspaceId, agents: ['claude-code', 'codex'] });
expect(preview.files.map((file) => file.relativePath)).toContain('AGENTS.md');
expect(preview.files.map((file) => file.relativePath)).toContain('CLAUDE.md');
expect(await fs.readFile(existingAgents, 'utf8')).toBe(original);

await fs.appendFile(existingAgents, '\nmanual edit\n');
await expect(applyRendered(preview.preview_id)).rejects.toMatchObject({ code: 'TARGET_DRIFT' });
expect(await businessGitLog()).toEqual(beforeLog);
~~~

The e2e test must capture Claude knowledge, publish Context Git, join from a second home with one repository, render Codex, add Codex knowledge, publish, and render Claude back on the first home.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/integration/apply.test.ts tests/e2e/v02-sync.test.ts

Expected: FAIL because apply and sync are absent.

- [ ] **Step 3: Implement preview, atomic replacement, and Skill workflow**

Compile all repositories into temporary directories before showing diff. Bind previews to Context HEAD, business HEAD, and current target hashes. If a target differs from its prior generated hash, return its diff as a capture candidate and refuse overwrite. On approval, write backups under local home, fsync temporary files, rename per repository, and stop after the first repository failure with completed/pending lists. Never run git add or commit in a business repository.

Update SKILL.md so sync executes prepare-capture, asks the Agent for schema JSON, previews capture, obtains approval, applies/pushes Context Git, previews render, obtains approval, then applies business files.

- [ ] **Step 4: Run the v0.2 acceptance suite**

Run: npm run verify && npm test -- --run tests/e2e/v02-sync.test.ts

Expected: all tests pass; Context remote contains knowledge commits; both business repositories contain uncommitted tracked AGENTS.md and CLAUDE.md changes; neither business log changes.

- [ ] **Step 5: Commit**

~~~bash
git add src/apply src/commands src/main.ts skill tests/integration tests/e2e
git commit -m "feat: deliver reviewed cross-agent context sync"
~~~

## v0.2 Completion Gate

Run:

~~~bash
npm ci
npm run verify
npm test -- --run tests/e2e/v02-sync.test.ts
git status --short
~~~

Expected:

- All v0.1 and v0.2 tests pass.
- Claude-to-Codex and Codex-to-Claude flows are proven with two homes and a bare Context remote.
- Context writes and business file writes fail when their preview becomes stale.
- Active conflicts and manually edited generated files are never silently overwritten.
- Business repositories contain no tool-created commits.
