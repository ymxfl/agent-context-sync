import * as fs from 'node:fs/promises';
import path from 'node:path';

import { appError } from '../domain/errors.js';
import type { KnowledgeEntry, KnowledgeScope } from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import {
  commitAndPushKnowledge,
  preflightContextRemote,
  type PublishResult,
} from '../git/context-publisher.js';
import { runGit } from '../git/run-git.js';
import { KnowledgeStore } from '../knowledge/store.js';
import { claimCheckPreview, peekCheckPreview, saveCheckPreview } from '../preview/check-store.js';
import {
  collectEvidence,
  type EvidenceLimits,
  type VerificationPacket,
} from '../verification/collect.js';
import {
  buildCheckPreview,
  type CheckPreview,
} from '../verification/proposal.js';
import {
  assertLocalContextCheckout,
  localHead,
  readWorkspaceManifest,
} from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';

export type { PublishResult } from '../git/context-publisher.js';
export type { CheckPreview } from '../verification/proposal.js';

const PACKET_ID = /^packet_[0-9A-HJKMNP-TV-Z]{26}$/;

const DEFAULT_LIMITS: EvidenceLimits = {
  maxFiles: 20,
  maxBytes: 200_000,
  maxCommits: 20,
  timeoutMs: 5_000,
};

/** Input for preparing verification packets from active knowledge. */
export interface CheckInput {
  workspaceId: string;
  home: string;
  repositories?: readonly string[];
  knowledgeIds?: readonly string[];
  scope?: KnowledgeScope;
  limits?: EvidenceLimits;
}

interface PersistedVerificationPacketRecord {
  packet: VerificationPacket;
  workspaceId: string;
  contextHead: string;
  repositoryPaths: Record<string, string>;
}

export interface PreviewCheckOptions {
  home: string;
}

/** Publish result for check apply; always requires a separate business-file apply. */
export interface CheckPublishResult extends PublishResult {
  required_apply: true;
}

function packetsDirectory(home: string): string {
  return path.resolve(home, 'verification-packets');
}

function packetRecordPath(home: string, packetId: string): string {
  if (!PACKET_ID.test(packetId)) {
    throw appError('INVALID_PACKET', 'Verification packet ID is invalid');
  }
  return path.join(packetsDirectory(home), `${packetId}.json`);
}

async function persistVerificationPacket(
  home: string,
  packet: VerificationPacket,
  meta: Omit<PersistedVerificationPacketRecord, 'packet'>,
): Promise<void> {
  const directory = packetsDirectory(home);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const record: PersistedVerificationPacketRecord = { packet, ...meta };
  await atomicWriteFile(packetRecordPath(home, packet.packet_id), JSON.stringify(record));
}

async function loadPersistedPacket(
  home: string,
  packetId: string,
): Promise<PersistedVerificationPacketRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(packetRecordPath(home, packetId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw appError('INVALID_PACKET', 'Verification packet does not exist');
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw appError('INVALID_PACKET', 'Stored verification packet is invalid');
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || !('packet' in parsed)
    || typeof (parsed as { workspaceId?: unknown }).workspaceId !== 'string'
    || typeof (parsed as { contextHead?: unknown }).contextHead !== 'string'
    || typeof (parsed as { repositoryPaths?: unknown }).repositoryPaths !== 'object'
    || (parsed as { repositoryPaths?: unknown }).repositoryPaths === null
  ) {
    throw appError('INVALID_PACKET', 'Stored verification packet is invalid');
  }
  const record = parsed as PersistedVerificationPacketRecord;
  if (record.packet.packet_id !== packetId) {
    throw appError('INVALID_PACKET', 'Stored verification packet identity does not match');
  }
  return record;
}

function selectActiveKnowledge(
  entries: readonly KnowledgeEntry[],
  input: CheckInput,
  registeredRepositoryIds: ReadonlySet<string>,
): KnowledgeEntry[] {
  const knowledgeFilter = input.knowledgeIds === undefined
    ? undefined
    : new Set(input.knowledgeIds);
  const repositoryFilter = input.repositories === undefined
    ? undefined
    : new Set(input.repositories);

  return entries.filter((entry) => {
    if (entry.status !== 'active') return false;
    if (knowledgeFilter !== undefined && !knowledgeFilter.has(entry.id)) return false;
    if (input.scope !== undefined && entry.scope !== input.scope) return false;
    if (entry.scope === 'workspace') {
      if (repositoryFilter === undefined) return true;
      return [...repositoryFilter].some((repoId) => registeredRepositoryIds.has(repoId));
    }
    const repoId = entry.scope.slice('repository:'.length);
    if (!registeredRepositoryIds.has(repoId)) return false;
    if (repositoryFilter !== undefined && !repositoryFilter.has(repoId)) return false;
    return true;
  });
}

function repositoryTargetsForEntry(
  entry: KnowledgeEntry,
  localPaths: Readonly<Record<string, string>>,
  repositoryFilter: ReadonlySet<string> | undefined,
): Array<{ repoId: string; repositoryPath: string }> {
  if (entry.scope === 'workspace') {
    const targets: Array<{ repoId: string; repositoryPath: string }> = [];
    for (const [repoId, repositoryPath] of Object.entries(localPaths)) {
      if (repositoryFilter !== undefined && !repositoryFilter.has(repoId)) continue;
      targets.push({ repoId, repositoryPath });
    }
    return targets;
  }
  const repoId = entry.scope.slice('repository:'.length);
  if (repositoryFilter !== undefined && !repositoryFilter.has(repoId)) return [];
  const repositoryPath = localPaths[repoId];
  if (repositoryPath === undefined) return [];
  return [{ repoId, repositoryPath }];
}

/**
 * Select active knowledge by scope, collect bounded evidence packets, and persist them locally.
 * Does not write Context knowledge files.
 */
export async function prepareCheck(input: CheckInput): Promise<VerificationPacket[]> {
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

  await preflightContextRemote(contextPath);
  const contextHead = await localHead(contextPath);
  const registeredRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));
  const store = new KnowledgeStore(contextPath, { registeredRepositoryIds });
  const active = selectActiveKnowledge(await store.list(), input, registeredRepositoryIds);
  const repositoryFilter = input.repositories === undefined
    ? undefined
    : new Set(input.repositories);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const packets: VerificationPacket[] = [];

  for (const entry of active) {
    const targets = repositoryTargetsForEntry(entry, local.repository_paths, repositoryFilter);
    for (const target of targets) {
      const packet = await collectEvidence({
        entry,
        repositoryPath: target.repositoryPath,
        repoId: target.repoId,
        limits,
      });
      await persistVerificationPacket(home, packet, {
        workspaceId: input.workspaceId,
        contextHead,
        repositoryPaths: { ...local.repository_paths },
      });
      packets.push(packet);
    }
  }

  return packets;
}

/**
 * Validate a verification proposal against persisted packets and live evidence, then store a
 * 24h authenticated check preview. Never writes Context Git knowledge files.
 */
export async function previewCheck(
  packetIds: string[],
  proposal: unknown,
  options: PreviewCheckOptions,
): Promise<CheckPreview> {
  const home = path.resolve(options.home);
  if (packetIds.length === 0) {
    throw appError('INVALID_PACKET', 'At least one verification packet ID is required');
  }

  const records: PersistedVerificationPacketRecord[] = [];
  for (const packetId of packetIds) {
    records.push(await loadPersistedPacket(home, packetId));
  }

  const workspaceId = records[0]!.workspaceId;
  const contextHead = records[0]!.contextHead;
  for (const record of records) {
    if (record.workspaceId !== workspaceId) {
      throw appError('INVALID_PACKET', 'Verification packets span multiple workspaces');
    }
    if (record.contextHead !== contextHead) {
      throw appError('STALE_PREVIEW', 'Verification packets were collected against different Context HEADs');
    }
  }

  const local = await readLocalWorkspace(home, workspaceId);
  const contextPath = await assertLocalContextCheckout(home, workspaceId, local.context_path);
  await preflightContextRemote(contextPath);
  const head = await localHead(contextPath);
  if (head !== contextHead) {
    throw appError('STALE_PREVIEW', 'Context HEAD changed after verification packet collection', {
      expected_head: contextHead,
      actual_head: head,
    });
  }

  const preview = await buildCheckPreview(
    records.map((record) => record.packet),
    proposal,
    {
      workspaceId,
      contextHead,
      repositoryPaths: local.repository_paths,
    },
  );
  await saveCheckPreview(home, preview);
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
    // knowledge/ may be absent from HEAD; untracked files are cleaned below.
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

async function applyApprovedCheck(
  preview: CheckPreview,
  home: string,
): Promise<CheckPublishResult> {
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

  await preflightContextRemote(contextPath);
  const head = await localHead(contextPath);
  if (head !== preview.context_head) {
    throw appError('STALE_PREVIEW', 'Context HEAD changed after preview generation', {
      expected_head: preview.context_head,
      actual_head: head,
    });
  }

  const registeredRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));
  const store = new KnowledgeStore(contextPath, { registeredRepositoryIds });
  const nowIso = new Date().toISOString();

  try {
    for (const create of preview.changes.creates) {
      await store.put(create.entry);
    }
    for (const update of preview.changes.updates) {
      await store.put(update.entry);
    }
    for (const item of preview.changes.supersede) {
      await store.put(item.entry);
      const existing = await store.get(item.old_id);
      if (existing === undefined) {
        throw appError('INVALID_KNOWLEDGE', 'Supersede target is missing from Context knowledge', {
          id: item.old_id,
        });
      }
      const superseded: KnowledgeEntry = {
        ...existing,
        status: 'superseded',
        updated_at: nowIso,
      };
      await store.put(superseded);
    }
    for (const archive of preview.changes.archive) {
      const existing = await store.get(archive.id);
      if (existing === undefined) {
        throw appError('INVALID_KNOWLEDGE', 'Archive target is missing from Context knowledge', {
          id: archive.id,
        });
      }
      const archived: KnowledgeEntry = {
        ...existing,
        status: 'archived',
        updated_at: nowIso,
      };
      await store.put(archived);
    }

    await store.list();
  } catch (error) {
    await discardKnowledgeWorkingTree(contextPath);
    mapKnowledgeWriteError(error);
  }

  const published = await commitAndPushKnowledge(
    contextPath,
    `Publish check preview ${preview.preview_id}`,
  );
  return {
    ...published,
    required_apply: true,
  };
}

/**
 * Claim an approved check preview, write knowledge mutations into Context Git, and push once.
 * Never touches business repository files; returns required_apply so callers re-run apply.
 */
export async function applyCheck(
  previewId: string,
  home: string,
): Promise<CheckPublishResult> {
  const resolvedHome = path.resolve(home);
  const pending = await peekCheckPreview(resolvedHome, previewId);
  return withWorkspaceLock(resolvedHome, pending.workspace_id, async () => {
    const preview = await claimCheckPreview(resolvedHome, previewId);
    return applyApprovedCheck(preview, resolvedHome);
  });
}
