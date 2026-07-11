# Agent Context Sync v0.3 Verification and Experimental Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Verify shared knowledge against code evidence, resolve knowledge-level concurrency safely, and optionally trace Agent file access to discover context sources missing from stable Adapters.

**Architecture:** Deterministic collectors prepare bounded evidence packets; the active Agent returns schema-constrained verification or merge proposals; preview/apply gates remain the only write path. Experimental tracing is provider-based, disabled by default, records path metadata only, and can never mutate stable Adapter coverage automatically.

**Tech Stack:** The v0.2 TypeScript/Vitest stack, ripgrep subprocess integration, Git history evidence, platform-specific trace parsers for macOS fs_usage and Linux strace, and fixture-driven parsers.

## Global Constraints

- Complete v0.2 and preserve all prior acceptance suites.
- check never changes knowledge without a reviewed, non-stale preview.
- Every verification conclusion cites an existing repository-relative path, line range, dependency record, or Git commit.
- unverifiable is a valid outcome and must not be converted to stale.
- Experimental tracing is opt-in per run, stores no file content, and failure never blocks stable discovery.
- No automatic force push, business commit, business push, or destructive Git operation.
- Bound evidence size and command duration so a large Workspace cannot exhaust Agent context.

---

## File Map

- src/schema/verification.ts: verification proposal and evidence schemas.
- src/verification/collect.ts: bounded code/config/dependency/Git evidence.
- src/verification/proposal.ts: validate Agent conclusions and preview changes.
- src/commands/check.ts: prepare, preview, and apply check workflow.
- src/merge/knowledge-merge.ts: three-way entry merge and semantic conflict packets.
- src/commands/reconcile.ts: resolve divergent Context branches without force.
- src/tracing/provider.ts: experimental provider contract.
- src/tracing/macos-fs-usage.ts: macOS parser and runner.
- src/tracing/linux-strace.ts: Linux parser and runner.
- src/tracing/classify.ts: context-path candidate filter.
- src/commands/trace.ts: explicit opt-in trace workflow.
- src/performance/cache.ts: hash-keyed discovery and evidence cache.

### Task 1: Define Verification Evidence and Proposal Schemas

**Files:**
- Create: src/schema/verification.ts
- Create: tests/schema/verification.test.ts
- Modify: src/domain/model.ts

**Interfaces:**
- Produces: VerificationStatus = valid | stale | contradicted | unverifiable
- Produces: EvidenceRef, VerificationFinding, VerificationProposal
- Produces: parseVerificationProposal(value: unknown): VerificationProposal

- [ ] **Step 1: Write failing evidence validation tests**

~~~ts
expect(parseVerificationProposal({
  schema_version: 1,
  packet_id: 'packet_01J00000000000000000000000',
  packet_hash: hash,
  findings: [{
    knowledge_id: knowledge.id,
    status: 'contradicted',
    explanation: 'The package now uses Prisma.',
    evidence: [{ type: 'file', repo_id: repoId, path: 'package.json', start_line: 12, end_line: 12, content_hash: hash }],
    proposed_action: { type: 'supersede', statement: 'Use Prisma for persistence.', reason: 'The active dependency and code imports use Prisma.' },
  }],
})).toBeTruthy();

expect(() => parseVerificationProposal({
  ...proposal,
  findings: [{ ...finding, status: 'stale', evidence: [] }],
})).toThrow(/evidence/i);
~~~

unverifiable findings may have no evidence but must include attempted_checks.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/schema/verification.test.ts

Expected: FAIL because the schema is absent.

- [ ] **Step 3: Implement strict verification schemas**

Evidence types are file, dependency, config, and git-commit. File paths are repository-relative POSIX paths; line numbers are positive and ordered; commits are 40 lowercase hex characters. Proposed actions are none, update, supersede, or archive. valid cannot propose mutation; stale and contradicted must propose a reasoned mutation or explicit none.

- [ ] **Step 4: Run schema and full regression tests**

Run: npm test -- --run tests/schema && npm run verify

Expected: all pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/schema/verification.ts src/domain/model.ts tests/schema/verification.test.ts
git commit -m "feat: define rule verification contracts"
~~~

### Task 2: Collect Bounded Code and Git Evidence

**Files:**
- Create: src/verification/collect.ts
- Create: src/verification/dependencies.ts
- Create: src/verification/git-evidence.ts
- Create: tests/verification/collect.test.ts
- Create: tests/fixtures/verification-repo/

**Interfaces:**
- Produces: collectEvidence(input: EvidenceInput): Promise<VerificationPacket>
- VerificationPacket includes knowledge, searches, files, dependencies, configs, commits, limits, packet_hash

- [ ] **Step 1: Write failing bounded-collection tests**

~~~ts
const packet = await collectEvidence({
  entry,
  repositoryPath: fixture,
  limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 5_000 },
});
expect(packet.files.some((file) => file.path === 'package.json')).toBe(true);
expect(packet.dependencies).toContainEqual(expect.objectContaining({ name: 'prisma' }));
expect(packet.total_bytes).toBeLessThanOrEqual(200_000);
expect(packet.files.every((file) => !path.isAbsolute(file.path))).toBe(true);
~~~

Add a fixture with ignored secrets and a command timeout; assert truncation and timeout are reported, not thrown as a generic error.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/verification/collect.test.ts

Expected: FAIL because collectors do not exist.

- [ ] **Step 3: Implement evidence collection**

Derive conservative fixed-string search terms from the knowledge statement, reason, and applies_to paths, then run rg with argument arrays. Read only text files inside the real repository root, honor .gitignore, redact secrets, parse supported dependency manifests, and include bounded git log/blame data. Canonicalize and hash the packet.

- [ ] **Step 4: Run focused and full tests**

Run: npm test -- --run tests/verification && npm run verify

Expected: all pass; timeout fixture completes within 10 seconds.

- [ ] **Step 5: Commit**

~~~bash
git add src/verification tests/verification tests/fixtures/verification-repo
git commit -m "feat: collect bounded rule evidence"
~~~

### Task 3: Implement Reviewed check Workflow

**Files:**
- Create: src/verification/proposal.ts
- Create: src/commands/check.ts
- Modify: src/main.ts
- Modify: skill/agent-context-sync/SKILL.md
- Test: tests/integration/check.test.ts

**Interfaces:**
- Produces: prepareCheck(input: CheckInput): Promise<VerificationPacket[]>
- Produces: previewCheck(packetIds: string[], proposal: unknown): Promise<CheckPreview>
- Produces: applyCheck(previewId: string): Promise<PublishResult>

- [ ] **Step 1: Write failing evidence-resolution and approval tests**

~~~ts
const preview = await previewCheck([packet.packet_id], proposal);
expect(preview.changes.supersede).toHaveLength(1);
expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });

await applyCheck(preview.preview_id);
expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'superseded' });
expect((await knowledgeStore.list()).some((item) => item.statement === 'Use Prisma for persistence.')).toBe(true);
~~~

Also assert nonexistent evidence paths, changed evidence hashes, and changed Context HEAD return INVALID_EVIDENCE or STALE_PREVIEW without writes.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/integration/check.test.ts

Expected: FAIL because check is absent.

- [ ] **Step 3: Implement prepare/preview/apply and Skill guidance**

prepareCheck selects active knowledge by scope and creates packets. previewCheck resolves every evidence reference against the current repository and verifies hashes/commits. applyCheck converts approved update, supersede, and archive actions into KnowledgeEntry changes and uses the existing Context publisher; it then returns a required_apply flag without touching business files.

SKILL.md must instruct the Agent not to infer stale from age alone and to use unverifiable when evidence is insufficient.

- [ ] **Step 4: Run check and regression suites**

Run: npm test -- --run tests/integration/check.test.ts && npm run verify

Expected: all pass and business repositories remain unchanged until a separate apply preview is approved.

- [ ] **Step 5: Commit**

~~~bash
git add src/verification/proposal.ts src/commands/check.ts src/main.ts skill tests/integration/check.test.ts
git commit -m "feat: verify and review stale context rules"
~~~

### Task 4: Reconcile Divergent Context Git Histories at Knowledge Level

**Files:**
- Create: src/merge/knowledge-merge.ts
- Create: src/commands/reconcile.ts
- Modify: src/main.ts
- Test: tests/merge/knowledge-merge.test.ts
- Test: tests/integration/reconcile.test.ts

**Interfaces:**
- Produces: threeWayKnowledgeMerge(base, local, remote): MergeResult
- Produces: prepareReconcile(input: ReconcileInput): Promise<ReconcilePacket>
- Produces: previewReconcile(packetId: string, proposal: unknown): Promise<ReconcilePreview>
- Produces: applyReconcile(previewId: string): Promise<PublishResult>

- [ ] **Step 1: Write failing merge classification tests**

~~~ts
expect(threeWayKnowledgeMerge(base, localAddsA, remoteAddsB)).toMatchObject({
  automatic: expect.arrayContaining([a.id, b.id]),
  conflicts: [],
});

expect(threeWayKnowledgeMerge(base, localEditsA, remoteEditsA).conflicts)
  .toContainEqual(expect.objectContaining({ knowledge_id: a.id, type: 'SAME_ENTRY_EDIT' }));
~~~

Add deterministic conflicts for competing supersedes relations, explicit conflicts_with relations, and simultaneous status changes on the same entry. Potential semantic contradictions between different IDs are included in the Agent reconciliation packet and are never silently auto-merged.

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/merge tests/integration/reconcile.test.ts

Expected: FAIL because merge support is absent.

- [ ] **Step 3: Implement safe three-way reconciliation**

Use the merge base and parse all three Knowledge stores. Auto-merge different IDs and byte-identical edits. Emit a schema packet for semantic conflicts; the Agent may choose local, remote, combine into a new entry, or mark disputed. Apply creates a normal merge or reconciliation commit and pushes only after refetching. Never force push or rewrite published history.

- [ ] **Step 4: Run merge and full tests**

Run: npm test -- --run tests/merge tests/integration/reconcile.test.ts && npm run verify

Expected: all pass; remote history retains both parent commits.

- [ ] **Step 5: Commit**

~~~bash
git add src/merge src/commands/reconcile.ts src/main.ts tests/merge tests/integration/reconcile.test.ts
git commit -m "feat: reconcile context knowledge conflicts"
~~~

### Task 5: Add Opt-in Runtime Context Tracing

**Files:**
- Create: src/tracing/provider.ts
- Create: src/tracing/macos-fs-usage.ts
- Create: src/tracing/linux-strace.ts
- Create: src/tracing/classify.ts
- Create: src/commands/trace.ts
- Modify: src/main.ts
- Test: tests/tracing/macos-fs-usage.test.ts
- Test: tests/tracing/linux-strace.test.ts
- Test: tests/tracing/classify.test.ts
- Create: tests/fixtures/tracing/

**Interfaces:**
- Produces: TraceProvider.isAvailable(), start(command, args), stop()
- Produces: TraceEvent { timestamp, pid, operation, path }
- Produces: classifyTrace(events, stableReport): TraceCandidate[]

- [ ] **Step 1: Write failing parser and privacy tests**

~~~ts
expect(parseFsUsage(fixture)).toContainEqual(expect.objectContaining({
  operation: 'open',
  path: '/tmp/repo/CLAUDE.md',
}));
expect(parseStrace(fixture)).toContainEqual(expect.objectContaining({
  operation: 'openat',
  path: '/tmp/repo/AGENTS.md',
}));

const candidates = classifyTrace(events, stableReport);
expect(candidates.map((item) => item.path)).toContain('/tmp/repo/custom.rules');
expect(JSON.stringify(candidates)).not.toContain('file contents');
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/tracing

Expected: FAIL because tracing modules do not exist.

- [ ] **Step 3: Implement provider-gated tracing**

macOS uses fs_usage only when installed and authorized; Linux uses strace only when installed and ptrace is allowed; Windows returns unavailable in v0.3. Require --experimental and --consent-path-metadata flags. Capture only open/stat/readlink-style path events for the launched Agent process tree, cap runtime and events, discard code paths already explained by normal repository reads, and return unknown context candidates. Do not read candidate content until the user later runs stable inspect/capture.

- [ ] **Step 4: Run parser, availability, and full tests**

Run: npm test -- --run tests/tracing && npm run verify

Expected: fixture tests pass on all platforms; live-provider smoke test is skipped with an explicit reason when unavailable.

- [ ] **Step 5: Commit**

~~~bash
git add src/tracing src/commands/trace.ts src/main.ts tests/tracing tests/fixtures/tracing
git commit -m "feat: trace unknown context sources experimentally"
~~~

### Task 6: Add Caching, Full MVP Acceptance, and Operations Documentation

**Files:**
- Create: src/performance/cache.ts
- Modify: src/verification/collect.ts
- Modify: src/commands/inspect.ts
- Modify: src/commands/doctor.ts
- Modify: README.md
- Create: docs/operations.md
- Create: tests/performance/large-workspace.test.ts
- Create: tests/e2e/mvp-acceptance.test.ts

**Interfaces:**
- Produces: ContentCache.get(key), put(key, value), invalidateByHead(repositoryId, head)
- Consumes all public command interfaces from v0.1-v0.3

- [ ] **Step 1: Write failing large-Workspace and final acceptance tests**

~~~ts
const first = await inspectLargeWorkspace(fixture);
const second = await inspectLargeWorkspace(fixture);
expect(second.stats.files_read).toBeLessThan(first.stats.files_read);
expect(second.reports).toEqual(first.reports);

const result = await runMvpScenario();
expect(result).toMatchObject({
  workspaceRepositories: 10,
  memberBRepositories: 5,
  claudeToCodex: 'pass',
  codexToClaude: 'pass',
  staleRuleCheck: 'pass',
  divergentContextReconcile: 'pass',
  businessCommitsCreatedByTool: 0,
});
~~~

- [ ] **Step 2: Run tests and verify failure**

Run: npm test -- --run tests/performance/large-workspace.test.ts tests/e2e/mvp-acceptance.test.ts

Expected: FAIL because caching and the full scenario are absent.

- [ ] **Step 3: Implement hash-keyed cache and complete docs**

Cache discovery by Adapter version, config hash, repository HEAD, target path, and relevant file mtimes; cache verification evidence by knowledge hash and repository HEAD. Store cache locally with bounded size and atomic writes. doctor reports cache corruption and can recommend removal but does not remove it without approval.

README documents install and daily workflows. docs/operations.md documents backup, Context remote migration, schema compatibility, resolving divergence, generated-file drift, privacy boundaries, and experimental trace consent.

- [ ] **Step 4: Run final verification**

Run: npm ci && npm run verify && npm test -- --run tests/e2e/mvp-acceptance.test.ts

Expected: every test passes; the large Workspace test completes within 30 seconds on the test fixture; the full scenario creates Context commits but no business commits.

- [ ] **Step 5: Commit**

~~~bash
git add src/performance src/verification src/commands README.md docs/operations.md tests/performance tests/e2e
git commit -m "feat: complete agent context sync mvp"
~~~

## v0.3 Completion Gate

Run:

~~~bash
npm ci
npm run verify
npm test -- --run tests/e2e/mvp-acceptance.test.ts
git status --short
~~~

Expected:

- All v0.1, v0.2, and v0.3 tests pass.
- Ten-repository and partial-clone acceptance scenarios pass.
- check produces evidence-backed results and requires approval for every mutation.
- divergent Context history is reconciled without force push.
- tracing remains opt-in, path-only, and safely unavailable where unsupported.
- Git status is clean and no temporary preview, backup, trace, or cache artifact is tracked.
