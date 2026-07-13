import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import type { KnowledgeEntry } from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import {
  inspectContextRemoteState,
  type PublishResult,
} from '../git/context-publisher.js';
import { runGit } from '../git/run-git.js';
import { parseKnowledgeMarkdown, serializeKnowledge } from '../knowledge/markdown.js';
import { KnowledgeStore } from '../knowledge/store.js';
import {
  type MergeConflict,
  threeWayKnowledgeMerge,
} from '../merge/knowledge-merge.js';
import {
  assertLocalContextCheckout,
  localHead,
  readWorkspaceManifest,
} from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';

export type { PublishResult } from '../git/context-publisher.js';

const PACKET_ID = /^packet_[0-9A-HJKMNP-TV-Z]{26}$/;
const PREVIEW_ID = /^preview_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[a-f0-9]{64}$/;
const PACKET_HASH = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ID = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/;
const KNOWLEDGE_ID = /^kn_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

/** Input for preparing a knowledge-level reconcile packet. */
export interface ReconcileInput {
  workspaceId: string;
  home: string;
}

/** Packet describing automatic merges and Agent-facing conflicts. */
export interface ReconcilePacket {
  schema_version: 1;
  packet_id: string;
  packet_hash: string;
  workspace_id: string;
  local_head: string;
  remote_head: string;
  merge_base: string;
  automatic: string[];
  merged: KnowledgeEntry[];
  conflicts: MergeConflict[];
}

export type ReconcileChoice = 'local' | 'remote' | 'combine' | 'disputed';

export interface ReconcileResolution {
  conflict_id: string;
  choice: ReconcileChoice;
  entry?: KnowledgeEntry;
  reason?: string;
}

export interface ReconcileProposal {
  schema_version: 1;
  packet_id: string;
  packet_hash: string;
  resolutions: ReconcileResolution[];
}

export interface ReconcilePreviewEntry {
  entry: KnowledgeEntry;
  path: string;
  bytes: string;
}

/** Reviewed reconcile preview bound to divergent heads. */
export interface ReconcilePreview {
  preview_id: string;
  packet_id: string;
  packet_hash: string;
  workspace_id: string;
  local_head: string;
  remote_head: string;
  merge_base: string;
  entries: ReconcilePreviewEntry[];
  warnings: string[];
}

export interface PreviewReconcileOptions {
  home: string;
}

interface PersistedReconcilePacketRecord {
  packet: ReconcilePacket;
  workspaceId: string;
}

interface StoredReconcilePreview {
  version: 1;
  expires_at: number;
  local_head: string;
  remote_head: string;
  files_hash: string;
  preview: ReconcilePreview;
  mac: string;
}

const sourceReferenceSchema = z.strictObject({
  agent: z.string().min(1),
  source_type: z.string().min(1),
  locator: z.string().min(1),
  content_hash: z.string().regex(PACKET_HASH),
  observed_at: z.string().min(1),
});

const knowledgeEntrySchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(KNOWLEDGE_ID),
  kind: z.string().min(1),
  scope: z.string().min(1),
  status: z.enum(['active', 'superseded', 'archived', 'disputed']),
  applies_to: z.strictObject({
    paths: z.array(z.string()),
    agents: z.array(z.string()),
  }),
  source: sourceReferenceSchema,
  confidence: z.number(),
  supersedes: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  last_verified_at: z.string().nullable(),
  statement: z.string(),
  reason: z.string(),
});

const reconcileProposalSchema = z.strictObject({
  schema_version: z.literal(1),
  packet_id: z.string().regex(PACKET_ID),
  packet_hash: z.string().regex(PACKET_HASH),
  resolutions: z.array(z.strictObject({
    conflict_id: z.string().min(1),
    choice: z.enum(['local', 'remote', 'combine', 'disputed']),
    entry: knowledgeEntrySchema.optional(),
    reason: z.string().min(1).optional(),
  })),
});

const reconcilePreviewSchema = z.strictObject({
  preview_id: z.string().regex(PREVIEW_ID),
  packet_id: z.string().regex(PACKET_ID),
  packet_hash: z.string().regex(PACKET_HASH),
  workspace_id: z.string().regex(WORKSPACE_ID),
  local_head: z.string().min(1),
  remote_head: z.string().min(1),
  merge_base: z.string().min(1),
  entries: z.array(z.strictObject({
    entry: knowledgeEntrySchema,
    path: z.string().min(1),
    bytes: z.string(),
  })),
  warnings: z.array(z.string()),
});

const storedReconcilePreviewSchema = z.strictObject({
  version: z.literal(1),
  expires_at: z.number().finite(),
  local_head: z.string().min(1),
  remote_head: z.string().min(1),
  files_hash: z.string().regex(HASH),
  preview: reconcilePreviewSchema,
  mac: z.string().regex(HASH),
});

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function packetsDirectory(home: string): string {
  return path.resolve(home, 'reconcile-packets');
}

function packetRecordPath(home: string, packetId: string): string {
  if (!PACKET_ID.test(packetId)) {
    throw appError('INVALID_PACKET', 'Reconcile packet ID is invalid');
  }
  return path.join(packetsDirectory(home), `${packetId}.json`);
}

function previewsDirectory(home: string): string {
  return path.resolve(home, 'reconcile-previews');
}

function previewRecordPath(home: string, previewId: string): string {
  if (!PREVIEW_ID.test(previewId)) {
    throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
  }
  return path.join(previewsDirectory(home), `${previewId}.json`);
}

function usedPreviewPath(home: string, previewId: string): string {
  if (!PREVIEW_ID.test(previewId)) {
    throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
  }
  return path.join(previewsDirectory(home), `${previewId}.used`);
}

function keyPath(home: string): string {
  return path.resolve(home, 'reconcile-preview-auth.key');
}

function knowledgeRelativePath(entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
  if (entry.scope === 'workspace') return `knowledge/workspace/${entry.id}.md`;
  return `knowledge/repositories/${entry.scope.slice('repository:'.length)}/${entry.id}.md`;
}

function canonicalPacketBytes(packet: Omit<ReconcilePacket, 'packet_hash'>): string {
  return JSON.stringify({
    schema_version: packet.schema_version,
    packet_id: packet.packet_id,
    workspace_id: packet.workspace_id,
    local_head: packet.local_head,
    remote_head: packet.remote_head,
    merge_base: packet.merge_base,
    automatic: packet.automatic,
    merged: packet.merged,
    conflicts: packet.conflicts,
  });
}

async function upstreamRef(contextPath: string): Promise<string> {
  try {
    const { stdout } = await runGit(contextPath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const ref = stdout.trim();
    if (ref.length > 0) return ref;
  } catch {
    // Fall through.
  }
  return 'refs/remotes/origin/main';
}

async function revParse(contextPath: string, rev: string): Promise<string> {
  const { stdout } = await runGit(contextPath, ['rev-parse', rev]);
  return stdout.trim();
}

async function loadKnowledgeAtRevision(
  contextPath: string,
  revision: string,
  registeredRepositoryIds: ReadonlySet<string>,
): Promise<KnowledgeEntry[]> {
  let listing: string;
  try {
    const { stdout } = await runGit(contextPath, [
      'ls-tree',
      '-r',
      '--name-only',
      revision,
      '--',
      'knowledge',
    ]);
    listing = stdout;
  } catch {
    return [];
  }
  const files = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md'));
  const entries: KnowledgeEntry[] = [];
  const context = { registeredRepositoryIds };
  for (const file of files) {
    const { stdout } = await runGit(contextPath, ['show', `${revision}:${file}`]);
    entries.push(parseKnowledgeMarkdown(stdout, context));
  }
  return entries;
}

async function persistPacket(
  home: string,
  packet: ReconcilePacket,
): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(packetsDirectory(home), { recursive: true, mode: 0o700 });
  const record: PersistedReconcilePacketRecord = {
    packet,
    workspaceId: packet.workspace_id,
  };
  await atomicWriteFile(packetRecordPath(home, packet.packet_id), JSON.stringify(record));
}

async function loadPacket(
  home: string,
  packetId: string,
): Promise<PersistedReconcilePacketRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(packetRecordPath(home, packetId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw appError('INVALID_PACKET', 'Reconcile packet does not exist');
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedReconcilePacketRecord;
    if (parsed.packet?.packet_id !== packetId) {
      throw appError('INVALID_PACKET', 'Reconcile packet is invalid');
    }
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PACKET') throw error;
    throw appError('INVALID_PACKET', 'Reconcile packet is invalid');
  }
}

function filesHash(preview: ReconcilePreview): string {
  return createHash('sha256')
    .update(preview.entries.map((item) => `${item.path}\n${item.bytes}`).join('\n'))
    .digest('hex');
}

function authenticatedBytes(
  expiresAt: number,
  localHeadValue: string,
  remoteHeadValue: string,
  filesDigest: string,
  preview: ReconcilePreview,
): string {
  return JSON.stringify({
    version: 1,
    expires_at: expiresAt,
    local_head: localHeadValue,
    remote_head: remoteHeadValue,
    files_hash: filesDigest,
    preview,
  });
}

function macFor(
  key: Buffer,
  expiresAt: number,
  localHeadValue: string,
  remoteHeadValue: string,
  filesDigest: string,
  preview: ReconcilePreview,
): string {
  return createHmac('sha256', key)
    .update(authenticatedBytes(expiresAt, localHeadValue, remoteHeadValue, filesDigest, preview))
    .digest('hex');
}

async function readValidatedKey(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw appError('INVALID_PREVIEW', 'Reconcile preview authentication key is invalid');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw appError('INVALID_PREVIEW', 'Reconcile preview authentication key is invalid');
    }
    const encoded = await handle.readFile('utf8');
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== 32 || key.toString('base64') !== encoded) {
      throw appError('INVALID_PREVIEW', 'Reconcile preview authentication key is invalid');
    }
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PREVIEW') throw error;
    throw appError('INVALID_PREVIEW', 'Reconcile preview authentication key is invalid');
  } finally {
    await handle.close();
  }
}

async function previewKey(home: string): Promise<Buffer> {
  const file = keyPath(home);
  try {
    return await readValidatedKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = randomBytes(32).toString('base64');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(candidate, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return readValidatedKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readValidatedKey(file);
  }
}

async function ensurePreviewDirectory(home: string): Promise<void> {
  const directory = previewsDirectory(home);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) await fs.chmod(directory, 0o700);
  const info = await fs.lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw appError('INVALID_PREVIEW', 'Reconcile preview directory is invalid');
  }
}

async function saveReconcilePreview(home: string, preview: ReconcilePreview): Promise<void> {
  await ensurePreviewDirectory(home);
  const expiresAt = Date.now() + DEFAULT_TTL_MS;
  const key = await previewKey(home);
  const digestValue = filesHash(preview);
  const stored: StoredReconcilePreview = {
    version: 1,
    expires_at: expiresAt,
    local_head: preview.local_head,
    remote_head: preview.remote_head,
    files_hash: digestValue,
    preview,
    mac: macFor(key, expiresAt, preview.local_head, preview.remote_head, digestValue, preview),
  };
  await atomicWriteFile(previewRecordPath(home, preview.preview_id), JSON.stringify(stored));
}

async function readAuthenticatedPreview(
  home: string,
  file: string,
  previewId: string,
  now = Date.now(),
): Promise<ReconcilePreview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw appError('INVALID_PREVIEW', 'Stored reconcile preview is invalid');
  }
  const validated = storedReconcilePreviewSchema.safeParse(parsed);
  if (!validated.success) throw appError('INVALID_PREVIEW', 'Stored reconcile preview is invalid');
  const stored = parsed as StoredReconcilePreview;
  const key = await previewKey(home);
  const expected = Buffer.from(
    macFor(key, stored.expires_at, stored.local_head, stored.remote_head, stored.files_hash, stored.preview),
    'hex',
  );
  const actual = typeof stored.mac === 'string' ? Buffer.from(stored.mac, 'hex') : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw appError('INVALID_PREVIEW', 'Stored reconcile preview authentication failed');
  }
  const digestValue = filesHash(stored.preview);
  if (
    stored.files_hash !== digestValue
    || stored.local_head !== stored.preview.local_head
    || stored.remote_head !== stored.preview.remote_head
    || stored.preview.preview_id !== previewId
  ) {
    throw appError('INVALID_PREVIEW', 'Stored reconcile preview state hashes do not match');
  }
  if (now > stored.expires_at) {
    throw appError('PREVIEW_EXPIRED', 'Reconcile preview approval has expired');
  }
  return stored.preview;
}

async function peekReconcilePreview(home: string, previewId: string): Promise<ReconcilePreview> {
  await ensurePreviewDirectory(home);
  const pending = previewRecordPath(home, previewId);
  try {
    return await readAuthenticatedPreview(home, pending, previewId);
  } catch (error) {
    if ((error as { code?: string }).code !== 'INVALID_PREVIEW') throw error;
    try {
      await fs.access(usedPreviewPath(home, previewId));
      throw appError('PREVIEW_ALREADY_USED', 'Reconcile preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw error;
    }
  }
}

async function claimReconcilePreview(home: string, previewId: string): Promise<ReconcilePreview> {
  await ensurePreviewDirectory(home);
  const pending = previewRecordPath(home, previewId);
  const used = usedPreviewPath(home, previewId);
  try {
    await fs.rename(pending, used);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.access(used);
      throw appError('PREVIEW_ALREADY_USED', 'Reconcile preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw appError('INVALID_PREVIEW', 'Reconcile preview does not exist');
    }
  }
  return readAuthenticatedPreview(home, used, previewId);
}

function resolveConflictEntry(
  conflict: MergeConflict,
  resolution: ReconcileResolution,
  nowIso: string,
): KnowledgeEntry[] {
  if (resolution.choice === 'local') {
    if (conflict.local === undefined) {
      throw appError('INVALID_PROPOSAL', 'Conflict has no local entry to choose', {
        conflict_id: conflict.conflict_id,
      });
    }
    return [conflict.local];
  }
  if (resolution.choice === 'remote') {
    if (conflict.remote === undefined) {
      throw appError('INVALID_PROPOSAL', 'Conflict has no remote entry to choose', {
        conflict_id: conflict.conflict_id,
      });
    }
    return [conflict.remote];
  }
  if (resolution.choice === 'combine') {
    if (resolution.entry === undefined) {
      throw appError('INVALID_PROPOSAL', 'combine requires an entry', {
        conflict_id: conflict.conflict_id,
      });
    }
    return [resolution.entry];
  }
  // disputed: mark available sides disputed, preferring a combined view of both IDs.
  const outputs: KnowledgeEntry[] = [];
  if (conflict.type === 'SEMANTIC_CONTRADICTION') {
    if (conflict.local !== undefined) {
      outputs.push({
        ...conflict.local,
        status: 'disputed',
        updated_at: nowIso,
        reason: resolution.reason ?? conflict.local.reason,
      });
    }
    if (conflict.remote !== undefined) {
      outputs.push({
        ...conflict.remote,
        status: 'disputed',
        updated_at: nowIso,
        reason: resolution.reason ?? conflict.remote.reason,
      });
    }
    return outputs;
  }
  const base = conflict.local ?? conflict.remote;
  if (base === undefined) {
    throw appError('INVALID_PROPOSAL', 'Conflict has no entry to mark disputed', {
      conflict_id: conflict.conflict_id,
    });
  }
  return [{
    ...base,
    status: 'disputed',
    updated_at: nowIso,
    reason: resolution.reason ?? base.reason,
  }];
}

/**
 * Fetch origin, require divergent Context history, and classify knowledge-level merge conflicts.
 */
export async function prepareReconcile(input: ReconcileInput): Promise<ReconcilePacket> {
  const home = path.resolve(input.home);
  const local = await readLocalWorkspace(home, input.workspaceId);
  const contextPath = await assertLocalContextCheckout(
    home,
    input.workspaceId,
    local.context_path,
  );
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== input.workspaceId) {
    throw new Error('Workspace manifest does not match the requested workspace');
  }

  const state = await inspectContextRemoteState(contextPath);
  if (!state.diverged) {
    throw appError(
      'CONTEXT_NOT_DIVERGED',
      'Context Git history is not diverged; reconcile is only for divergent histories',
      {
        head: state.head,
        upstream: state.upstream,
        ahead: state.ahead,
        behind: state.behind,
      },
    );
  }

  const upstream = await upstreamRef(contextPath);
  const localHeadValue = await revParse(contextPath, 'HEAD');
  const remoteHeadValue = await revParse(contextPath, upstream);
  const { stdout: mergeBaseStdout } = await runGit(contextPath, [
    'merge-base',
    localHeadValue,
    remoteHeadValue,
  ]);
  const mergeBase = mergeBaseStdout.trim();
  const registeredRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));

  const baseEntries = await loadKnowledgeAtRevision(contextPath, mergeBase, registeredRepositoryIds);
  const localEntries = await loadKnowledgeAtRevision(contextPath, localHeadValue, registeredRepositoryIds);
  const remoteEntries = await loadKnowledgeAtRevision(contextPath, remoteHeadValue, registeredRepositoryIds);
  const merge = threeWayKnowledgeMerge(baseEntries, localEntries, remoteEntries);

  const packetId = createId('packet');
  const withoutHash = {
    schema_version: 1 as const,
    packet_id: packetId,
    workspace_id: input.workspaceId,
    local_head: localHeadValue,
    remote_head: remoteHeadValue,
    merge_base: mergeBase,
    automatic: merge.automatic,
    merged: merge.merged,
    conflicts: merge.conflicts,
  };
  const packet: ReconcilePacket = {
    ...withoutHash,
    packet_hash: digest(canonicalPacketBytes(withoutHash)),
  };
  await persistPacket(home, packet);
  return packet;
}

/**
 * Validate Agent resolutions against a reconcile packet and store a reviewed preview.
 */
export async function previewReconcile(
  packetId: string,
  proposal: unknown,
  options: PreviewReconcileOptions,
): Promise<ReconcilePreview> {
  const home = path.resolve(options.home);
  const record = await loadPacket(home, packetId);
  const packet = record.packet;

  const parsed = reconcileProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    throw appError('INVALID_PROPOSAL', 'Reconcile proposal failed schema validation', {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  const validated = parsed.data;
  if (validated.packet_id !== packet.packet_id || validated.packet_hash !== packet.packet_hash) {
    throw appError('STALE_PREVIEW', 'Reconcile proposal does not match the prepared packet', {
      packet_id: packet.packet_id,
    });
  }

  const local = await readLocalWorkspace(home, packet.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    home,
    packet.workspace_id,
    local.context_path,
  );
  const state = await inspectContextRemoteState(contextPath);
  const head = await localHead(contextPath);
  const upstream = await upstreamRef(contextPath);
  const remoteHeadValue = await revParse(contextPath, upstream);
  if (head !== packet.local_head || remoteHeadValue !== packet.remote_head || !state.diverged) {
    throw appError('STALE_PREVIEW', 'Context divergence changed after packet preparation', {
      expected_local_head: packet.local_head,
      actual_local_head: head,
      expected_remote_head: packet.remote_head,
      actual_remote_head: remoteHeadValue,
    });
  }

  const byConflictId = new Map(packet.conflicts.map((item) => [item.conflict_id, item]));
  const resolvedIds = new Set<string>();
  const resolvedEntries = new Map<string, KnowledgeEntry>();
  const nowIso = new Date().toISOString();
  const warnings: string[] = [];

  for (const entry of packet.merged) {
    resolvedEntries.set(entry.id, entry);
  }

  const seenResolutions = new Set<string>();
  for (const resolution of validated.resolutions) {
    if (seenResolutions.has(resolution.conflict_id)) {
      throw appError('INVALID_PROPOSAL', 'Duplicate conflict resolution', {
        conflict_id: resolution.conflict_id,
      });
    }
    seenResolutions.add(resolution.conflict_id);
    const conflict = byConflictId.get(resolution.conflict_id);
    if (conflict === undefined) {
      throw appError('INVALID_PROPOSAL', 'Unknown conflict_id in reconcile proposal', {
        conflict_id: resolution.conflict_id,
      });
    }
    const typedResolution: ReconcileResolution = {
      conflict_id: resolution.conflict_id,
      choice: resolution.choice,
      ...(resolution.entry === undefined
        ? {}
        : { entry: resolution.entry as KnowledgeEntry }),
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
    };
    for (const entry of resolveConflictEntry(conflict, typedResolution, nowIso)) {
      resolvedEntries.set(entry.id, entry);
      resolvedIds.add(entry.id);
    }
  }

  for (const conflict of packet.conflicts) {
    if (!seenResolutions.has(conflict.conflict_id)) {
      throw appError('INVALID_PROPOSAL', 'Missing resolution for reconcile conflict', {
        conflict_id: conflict.conflict_id,
      });
    }
  }

  const entries: ReconcilePreviewEntry[] = [...resolvedEntries.values()]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((entry) => ({
      entry,
      path: knowledgeRelativePath(entry),
      bytes: serializeKnowledge(entry),
    }));

  if (resolvedIds.size > 0) {
    warnings.push(`Resolved ${seenResolutions.size} knowledge conflict(s)`);
  }

  const preview: ReconcilePreview = {
    preview_id: createId('preview'),
    packet_id: packet.packet_id,
    packet_hash: packet.packet_hash,
    workspace_id: packet.workspace_id,
    local_head: packet.local_head,
    remote_head: packet.remote_head,
    merge_base: packet.merge_base,
    entries,
    warnings,
  };
  await saveReconcilePreview(home, preview);
  return preview;
}

async function discardKnowledgeWorkingTree(contextPath: string): Promise<void> {
  try {
    await runGit(contextPath, ['reset', 'HEAD', '--', 'knowledge']);
  } catch {
    // Nothing may be staged under knowledge yet.
  }
  try {
    await runGit(contextPath, ['checkout', 'HEAD', '--', 'knowledge']);
  } catch {
    // knowledge/ may be absent from HEAD.
  }
  await runGit(contextPath, ['clean', '-fd', '--', 'knowledge']);
}

function mapKnowledgeWriteError(error: unknown): never {
  if (
    error !== null
    && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string'
  ) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid Knowledge graph/i.test(message)) {
    throw appError('INVALID_KNOWLEDGE_GRAPH', message);
  }
  throw appError('INVALID_KNOWLEDGE', message);
}

async function configureCommitter(contextPath: string): Promise<void> {
  await runGit(contextPath, ['config', 'user.name', 'Agent Context Sync']);
  await runGit(contextPath, [
    'config',
    'user.email',
    'agent-context-sync@localhost.invalid',
  ]);
}

async function abortMergeIfPresent(contextPath: string): Promise<void> {
  try {
    await fs.access(path.join(contextPath, '.git', 'MERGE_HEAD'));
    await runGit(contextPath, ['merge', '--abort']);
  } catch {
    // No merge in progress.
  }
}

async function applyApprovedReconcile(
  preview: ReconcilePreview,
  home: string,
): Promise<PublishResult> {
  const local = await readLocalWorkspace(home, preview.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    home,
    preview.workspace_id,
    local.context_path,
  );
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== preview.workspace_id) {
    throw appError('STALE_PREVIEW', 'Workspace identity changed after preview generation');
  }

  const state = await inspectContextRemoteState(contextPath);
  const head = await localHead(contextPath);
  const upstream = await upstreamRef(contextPath);
  const remoteHeadValue = await revParse(contextPath, upstream);
  if (
    head !== preview.local_head
    || remoteHeadValue !== preview.remote_head
    || !state.diverged
  ) {
    throw appError('STALE_PREVIEW', 'Context divergence changed after preview generation', {
      expected_local_head: preview.local_head,
      actual_local_head: head,
      expected_remote_head: preview.remote_head,
      actual_remote_head: remoteHeadValue,
    });
  }

  await configureCommitter(contextPath);
  await abortMergeIfPresent(contextPath);

  // Record both parents without taking remote file contents; knowledge is resolved above Git.
  await runGit(contextPath, ['merge', '-s', 'ours', '--no-commit', '--no-ff', upstream]);

  const registeredRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));
  const store = new KnowledgeStore(contextPath, { registeredRepositoryIds });

  try {
    // Replace knowledge tree with the reviewed union.
    await discardKnowledgeWorkingTree(contextPath);
    await fs.rm(path.join(contextPath, 'knowledge'), { recursive: true, force: true });
    for (const item of preview.entries) {
      await store.put(item.entry);
    }
    await store.list();
  } catch (error) {
    await abortMergeIfPresent(contextPath);
    await discardKnowledgeWorkingTree(contextPath);
    mapKnowledgeWriteError(error);
  }

  // Stage knowledge and finish the merge commit, then push without force.
  if (await pathExists(path.join(contextPath, 'knowledge'))) {
    await runGit(contextPath, ['add', '--', 'knowledge']);
  }
  for (const relative of ['workspace.yaml', 'repositories', 'sources', 'schema'] as const) {
    if (await pathExists(path.join(contextPath, relative))) {
      await runGit(contextPath, ['add', '--', relative]);
    }
  }

  await runGit(contextPath, [
    'commit',
    '-m',
    `Reconcile divergent Context knowledge (${preview.preview_id})`,
  ]);
  const commit = await revParse(contextPath, 'HEAD');
  try {
    await runGit(contextPath, ['push', 'origin', 'HEAD:refs/heads/main']);
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';
    const message = error instanceof Error ? error.message : String(error);
    const text = `${stderr}\n${message}`;
    if (
      /non-fast-forward/i.test(text)
      || /\[rejected\].*\(non-fast-forward\)/i.test(text)
      || /fetch first/i.test(text)
      || /updates were rejected because the (?:remote|tip of your current branch)/i.test(text)
    ) {
      throw appError(
        'REMOTE_CHANGED',
        'Context remote advanced during push; local merge commit was preserved',
        {
          commit,
          recovery: 'Fetch origin, re-prepare reconcile against the new HEAD, then retry without force push.',
        },
      );
    }
    throw error;
  }

  const remote_state = await inspectContextRemoteState(contextPath);
  return { commit, remote_state };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim an approved reconcile preview, write a merge commit with both parents, and push once.
 * Never force-pushes or rewrites published history.
 */
export async function applyReconcile(
  previewId: string,
  home: string,
): Promise<PublishResult> {
  const resolvedHome = path.resolve(home);
  const pending = await peekReconcilePreview(resolvedHome, previewId);
  return withWorkspaceLock(resolvedHome, pending.workspace_id, async () => {
    const preview = await claimReconcilePreview(resolvedHome, previewId);
    return applyApprovedReconcile(preview, resolvedHome);
  });
}
