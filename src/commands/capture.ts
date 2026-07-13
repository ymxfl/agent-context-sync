import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentName, CoverageReport, Shareability } from '../adapters/adapter.js';
import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import type { KnowledgeEntry } from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import {
  commitAndPushKnowledge,
  preflightContextRemote,
  type PublishResult,
} from '../git/context-publisher.js';
import { runGit } from '../git/run-git.js';
import { KnowledgeStore } from '../knowledge/store.js';
import {
  assertLocalContextCheckout,
  localHead,
  readWorkspaceManifest,
} from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';
import { inspect } from './inspect.js';
import {
  createExtractionPacket,
  type ExtractionPacket,
  type SelectedExcerpt,
} from '../extraction/packet.js';
import {
  previewKnowledgeProposal,
  type CapturePreview,
} from '../extraction/proposal.js';
import { claimCapturePreview, peekCapturePreview, saveCapturePreview } from '../preview/store.js';

export type { PublishResult } from '../git/context-publisher.js';

const PACKET_ID = /^packet_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_EXCERPT_BYTES = 64 * 1024;

/** Input for preparing a redacted extraction packet from local discovery. */
export interface CaptureInput {
  workspaceId: string;
  agent: AgentName;
  home: string;
  homeDir: string;
  repositories?: readonly string[];
  includePersonal?: boolean;
  cwd?: string;
}

/** Metadata persisted with an extraction packet for later previewCapture. */
export interface PersistedPacketMeta {
  includePersonal: boolean;
  registeredRepositoryIds: readonly string[];
  workspaceId: string;
}

interface PersistedPacketRecord extends PersistedPacketMeta {
  packet: ExtractionPacket;
}

export interface PreviewCaptureOptions {
  home: string;
}

function packetsDirectory(home: string): string {
  return path.resolve(home, 'packets');
}

function packetRecordPath(home: string, packetId: string): string {
  if (!PACKET_ID.test(packetId)) {
    throw appError('INVALID_PACKET', 'Extraction packet ID is invalid');
  }
  return path.join(packetsDirectory(home), `${packetId}.json`);
}

function contentHash(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mergeCoverageReports(reports: readonly CoverageReport[]): CoverageReport[] {
  const byAgent = new Map<AgentName, CoverageReport>();
  for (const report of reports) {
    const existing = byAgent.get(report.agent);
    if (existing === undefined) {
      byAgent.set(report.agent, {
        agent: report.agent,
        sources: [...report.sources],
        coverage: [...report.coverage],
        loadPlan: [...report.loadPlan],
        ...(report.limits === undefined ? {} : { limits: { ...report.limits } }),
      });
      continue;
    }
    existing.sources.push(...report.sources);
    existing.coverage.push(...report.coverage);
    existing.loadPlan.push(...report.loadPlan);
    if (report.limits !== undefined) {
      existing.limits = {
        ...existing.limits,
        ...report.limits,
        truncated: Boolean(existing.limits?.truncated || report.limits.truncated),
        maxBytes: Math.max(existing.limits?.maxBytes ?? 0, report.limits.maxBytes ?? 0) || undefined,
      };
    }
  }
  return [...byAgent.values()];
}

function allowShareability(shareability: Shareability, includePersonal: boolean): boolean {
  if (shareability === 'managed') return false;
  if (shareability === 'personal') return includePersonal;
  return true;
}

async function selectExcerpts(
  reports: readonly CoverageReport[],
  includePersonal: boolean,
): Promise<SelectedExcerpt[]> {
  const selected: SelectedExcerpt[] = [];
  for (const report of reports) {
    for (const source of report.sources) {
      if (source.status !== 'available') continue;
      if (!allowShareability(source.shareability, includePersonal)) continue;
      let contents: string;
      try {
        contents = await fs.readFile(source.locator, 'utf8');
      } catch {
        continue;
      }
      if (contents.length === 0) continue;
      const hash = contentHash(contents);
      const excerpt = contents.length > MAX_EXCERPT_BYTES
        ? contents.slice(0, MAX_EXCERPT_BYTES)
        : contents;
      const lines = excerpt.split('\n');
      const lineEnd = excerpt.endsWith('\n') && lines[lines.length - 1] === ''
        ? Math.max(1, lines.length - 1)
        : Math.max(1, lines.length);
      selected.push({
        agent: source.agent,
        locator: source.locator,
        contentHash: hash,
        lineStart: 1,
        lineEnd,
        excerpt,
      });
    }
  }
  return selected;
}

/** Persist an extraction packet under the local home with mode 0o600. */
export async function persistExtractionPacket(
  home: string,
  packet: ExtractionPacket,
  meta: PersistedPacketMeta,
): Promise<void> {
  const directory = packetsDirectory(home);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const record: PersistedPacketRecord = {
    packet,
    includePersonal: meta.includePersonal,
    registeredRepositoryIds: [...meta.registeredRepositoryIds],
    workspaceId: meta.workspaceId,
  };
  await atomicWriteFile(packetRecordPath(home, packet.packet_id), JSON.stringify(record));
}

async function loadPersistedPacket(
  home: string,
  packetId: string,
): Promise<PersistedPacketRecord> {
  let raw: string;
  try {
    raw = await fs.readFile(packetRecordPath(home, packetId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw appError('INVALID_PACKET', 'Extraction packet does not exist');
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw appError('INVALID_PACKET', 'Stored extraction packet is invalid');
  }
  if (
    parsed === null
    || typeof parsed !== 'object'
    || !('packet' in parsed)
    || typeof (parsed as { includePersonal?: unknown }).includePersonal !== 'boolean'
    || !Array.isArray((parsed as { registeredRepositoryIds?: unknown }).registeredRepositoryIds)
    || typeof (parsed as { workspaceId?: unknown }).workspaceId !== 'string'
  ) {
    throw appError('INVALID_PACKET', 'Stored extraction packet is invalid');
  }
  const record = parsed as PersistedPacketRecord;
  if (record.packet.packet_id !== packetId) {
    throw appError('INVALID_PACKET', 'Stored extraction packet identity does not match');
  }
  return record;
}

/**
 * Discover shareable sources, build a redacted extraction packet, and persist it locally.
 * Does not write Context knowledge files.
 */
export async function prepareCapture(input: CaptureInput): Promise<ExtractionPacket> {
  const home = path.resolve(input.home);
  const includePersonal = input.includePersonal === true;
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
  const inspected = await inspect({
    workspaceId: input.workspaceId,
    agent: input.agent,
    home,
    homeDir: input.homeDir,
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  const coverageReports = mergeCoverageReports(inspected.reports.map((item) => item.report));
  const registeredRepositoryIds = workspace.repositories.map((item) => item.repo_id);
  const store = new KnowledgeStore(contextPath, {
    registeredRepositoryIds: new Set(registeredRepositoryIds),
  });
  const existingKnowledge = await store.list();
  const selectedExcerpts = await selectExcerpts(coverageReports, includePersonal);
  const localRoots = [
    ...new Set([
      path.resolve(input.homeDir),
      ...Object.values(local.repository_paths).map((item) => path.resolve(item)),
    ]),
  ];

  const packet = createExtractionPacket({
    packetId: createId('packet'),
    contextHead,
    localRoots,
    coverageReports,
    selectedExcerpts,
    existingKnowledge,
  });

  await persistExtractionPacket(home, packet, {
    includePersonal,
    registeredRepositoryIds,
    workspaceId: input.workspaceId,
  });
  return packet;
}

/**
 * Validate a proposal against a persisted packet, store a 24h capture preview, and return it.
 * Never writes Context Git knowledge files.
 */
export async function previewCapture(
  packetId: string,
  proposal: unknown,
  options: PreviewCaptureOptions,
): Promise<CapturePreview> {
  const home = path.resolve(options.home);
  const record = await loadPersistedPacket(home, packetId);
  const preview = previewKnowledgeProposal(record.packet, proposal, {
    includePersonal: record.includePersonal,
    registeredRepositoryIds: new Set(record.registeredRepositoryIds),
    workspaceId: record.workspaceId,
  });
  await saveCapturePreview(home, preview);
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

async function applyApprovedCapture(
  preview: CapturePreview,
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
    for (const create of preview.creates) {
      await store.put(create.entry);
    }
    for (const archive of preview.archives) {
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

    // Final graph validation via list() after all mutations.
    await store.list();
  } catch (error) {
    await discardKnowledgeWorkingTree(contextPath);
    mapKnowledgeWriteError(error);
  }

  return commitAndPushKnowledge(
    contextPath,
    `Publish capture preview ${preview.preview_id}`,
  );
}

/**
 * Claim an approved capture preview, write knowledge into Context Git, and push once.
 * Never force-pushes; push races preserve the local commit and return REMOTE_CHANGED.
 */
export async function applyCapture(
  previewId: string,
  home: string,
): Promise<PublishResult> {
  const resolvedHome = path.resolve(home);
  const pending = await peekCapturePreview(resolvedHome, previewId);
  return withWorkspaceLock(resolvedHome, pending.workspace_id, async () => {
    const preview = await claimCapturePreview(resolvedHome, previewId);
    return applyApprovedCapture(preview, resolvedHome);
  });
}
