import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import type {
  EvidenceRef,
  KnowledgeEntry,
  ProposedVerificationAction,
  VerificationFinding,
  VerificationProposal,
} from '../domain/model.js';
import { serializeKnowledge } from '../knowledge/markdown.js';
import { parseVerificationProposal } from '../schema/verification.js';
import { redactCandidate } from '../security/redact.js';
import { parsePackageDependencies } from './dependencies.js';
import type { VerificationPacket } from './collect.js';
import { runGit } from '../git/run-git.js';

export interface CheckPreviewCreate {
  readonly entry: KnowledgeEntry;
  readonly path: string;
  readonly bytes: string;
}

export interface CheckPreviewUpdate {
  readonly entry: KnowledgeEntry;
  readonly path: string;
  readonly bytes: string;
}

export interface CheckPreviewSupersede {
  readonly old_id: string;
  readonly entry: KnowledgeEntry;
  readonly path: string;
  readonly bytes: string;
}

export interface CheckPreviewArchive {
  readonly id: string;
  readonly reason: string;
}

export interface CheckPreviewChanges {
  readonly creates: readonly CheckPreviewCreate[];
  readonly updates: readonly CheckPreviewUpdate[];
  readonly supersede: readonly CheckPreviewSupersede[];
  readonly archive: readonly CheckPreviewArchive[];
}

/** Reviewed check preview bound to Context HEAD; never writes Context files. */
export interface CheckPreview {
  readonly preview_id: string;
  readonly context_head: string;
  readonly workspace_id: string;
  readonly packet_ids: readonly string[];
  readonly packet_hashes: readonly string[];
  readonly changes: CheckPreviewChanges;
  readonly warnings: readonly string[];
}

export interface BuildCheckPreviewOptions {
  readonly workspaceId: string;
  readonly contextHead: string;
  readonly repositoryPaths: Readonly<Record<string, string>>;
  readonly now?: Date;
}

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function knowledgeRelativePath(entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
  if (entry.scope === 'workspace') return `knowledge/workspace/${entry.id}.md`;
  return `knowledge/repositories/${entry.scope.slice('repository:'.length)}/${entry.id}.md`;
}

function assertSafeRelative(relative: string): void {
  if (
    relative.startsWith('/')
    || relative.includes('\\')
    || relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw appError('INVALID_EVIDENCE', 'Evidence path is unsafe', { path: relative });
  }
}

async function ensureInsideRoot(rootReal: string, relativePosix: string): Promise<string> {
  assertSafeRelative(relativePosix);
  const candidate = path.resolve(rootReal, ...relativePosix.split('/'));
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw appError('INVALID_EVIDENCE', 'Evidence path escapes the repository root', {
      path: relativePosix,
    });
  }
  return candidate;
}

async function hashLineRange(
  repositoryPath: string,
  relativePosix: string,
  startLine: number,
  endLine: number,
): Promise<string> {
  const rootReal = await fs.realpath(repositoryPath);
  const absolute = await ensureInsideRoot(rootReal, relativePosix);
  let raw: string;
  try {
    raw = await fs.readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw appError('INVALID_EVIDENCE', 'Evidence file does not exist', {
        path: relativePosix,
        repo_id: undefined,
      });
    }
    throw error;
  }
  const redacted = redactCandidate(raw, [rootReal, repositoryPath]).redacted;
  const lines = redacted.split('\n');
  if (startLine > lines.length || endLine > lines.length) {
    throw appError('INVALID_EVIDENCE', 'Evidence line range is outside the current file', {
      path: relativePosix,
      start_line: startLine,
      end_line: endLine,
    });
  }
  const excerpt = lines.slice(startLine - 1, endLine).join('\n');
  return digest(excerpt);
}

async function resolveRepositoryPath(
  repoId: string,
  repositoryPaths: Readonly<Record<string, string>>,
): Promise<string> {
  const repositoryPath = repositoryPaths[repoId];
  if (repositoryPath === undefined) {
    throw appError('INVALID_EVIDENCE', 'Evidence references an unbound repository', {
      repo_id: repoId,
    });
  }
  return path.resolve(repositoryPath);
}

async function validateEvidenceRef(
  evidence: EvidenceRef,
  repositoryPaths: Readonly<Record<string, string>>,
): Promise<void> {
  const repositoryPath = await resolveRepositoryPath(evidence.repo_id, repositoryPaths);

  if (evidence.type === 'git-commit') {
    try {
      await runGit(repositoryPath, ['cat-file', '-e', `${evidence.commit}^{commit}`]);
    } catch {
      throw appError('INVALID_EVIDENCE', 'Evidence git commit is not present in the repository', {
        repo_id: evidence.repo_id,
        commit: evidence.commit,
      });
    }
    return;
  }

  if (evidence.type === 'dependency') {
    const dependencies = await parsePackageDependencies(repositoryPath, evidence.manifest_path);
    const match = dependencies.find(
      (item) => item.name === evidence.name && item.version === evidence.version,
    );
    if (match === undefined) {
      throw appError('INVALID_EVIDENCE', 'Evidence dependency is not present in the manifest', {
        repo_id: evidence.repo_id,
        name: evidence.name,
        version: evidence.version,
        manifest_path: evidence.manifest_path,
      });
    }
    if (match.content_hash !== evidence.content_hash) {
      throw appError('INVALID_EVIDENCE', 'Evidence dependency content hash does not match', {
        repo_id: evidence.repo_id,
        manifest_path: evidence.manifest_path,
      });
    }
    return;
  }

  // file or config
  let currentHash: string;
  try {
    currentHash = await hashLineRange(
      repositoryPath,
      evidence.path,
      evidence.start_line,
      evidence.end_line,
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_EVIDENCE') throw error;
    throw appError('INVALID_EVIDENCE', 'Evidence file could not be resolved', {
      repo_id: evidence.repo_id,
      path: evidence.path,
    });
  }
  if (currentHash !== evidence.content_hash) {
    throw appError('INVALID_EVIDENCE', 'Evidence content hash does not match the repository', {
      repo_id: evidence.repo_id,
      path: evidence.path,
    });
  }
}

function findingPacket(
  finding: VerificationFinding,
  packetsById: ReadonlyMap<string, VerificationPacket>,
  proposalPacketId: string,
): VerificationPacket {
  const packet = packetsById.get(proposalPacketId);
  if (packet === undefined) {
    throw appError('INVALID_PACKET', 'Verification proposal packet is not loaded');
  }
  if (packet.knowledge.id !== finding.knowledge_id) {
    throw appError('INVALID_EVIDENCE', 'Finding knowledge_id does not match the verification packet', {
      knowledge_id: finding.knowledge_id,
      packet_id: packet.packet_id,
    });
  }
  return packet;
}

function toUpdatedEntry(
  existing: KnowledgeEntry,
  action: Extract<ProposedVerificationAction, { type: 'update' }>,
  nowIso: string,
): KnowledgeEntry {
  return {
    ...existing,
    statement: action.statement,
    reason: action.reason,
    updated_at: nowIso,
    last_verified_at: nowIso,
  };
}

function toSupersedingEntry(
  existing: KnowledgeEntry,
  action: Extract<ProposedVerificationAction, { type: 'supersede' }>,
  nowIso: string,
): KnowledgeEntry {
  return {
    ...existing,
    id: createId('kn'),
    status: 'active',
    statement: action.statement,
    reason: action.reason,
    supersedes: [...new Set([...existing.supersedes, existing.id])],
    conflicts_with: [],
    created_at: nowIso,
    updated_at: nowIso,
    last_verified_at: nowIso,
  };
}

/**
 * Validate a verification proposal against persisted packets and live repository evidence.
 * Builds a CheckPreview without writing Context knowledge.
 */
export async function buildCheckPreview(
  packets: readonly VerificationPacket[],
  proposalInput: unknown,
  options: BuildCheckPreviewOptions,
): Promise<CheckPreview> {
  const proposal: VerificationProposal = parseVerificationProposal(proposalInput);
  const packetsById = new Map(packets.map((packet) => [packet.packet_id, packet] as const));
  if (!packetsById.has(proposal.packet_id)) {
    throw appError('INVALID_PACKET', 'Verification proposal packet_id is not in the provided set');
  }
  const primary = packetsById.get(proposal.packet_id)!;
  if (proposal.packet_hash !== primary.packet_hash) {
    throw appError('INVALID_PACKET', 'Verification proposal packet_hash does not match the packet');
  }

  for (const finding of proposal.findings) {
    findingPacket(finding, packetsById, proposal.packet_id);
    for (const evidence of finding.evidence) {
      await validateEvidenceRef(evidence, options.repositoryPaths);
    }
  }

  const nowIso = (options.now ?? new Date()).toISOString();
  const creates: CheckPreviewCreate[] = [];
  const updates: CheckPreviewUpdate[] = [];
  const supersede: CheckPreviewSupersede[] = [];
  const archive: CheckPreviewArchive[] = [];
  const warnings: string[] = [];
  const touched = new Set<string>();

  for (const finding of proposal.findings) {
    const packet = findingPacket(finding, packetsById, proposal.packet_id);
    const existing = packet.knowledge;
    if (existing.status !== 'active') {
      warnings.push(`Knowledge ${existing.id} is not active; skipping proposed action`);
      continue;
    }
    if (touched.has(existing.id)) {
      throw appError('INVALID_EVIDENCE', 'Multiple findings target the same knowledge entry', {
        knowledge_id: existing.id,
      });
    }

    const action = finding.proposed_action;
    if (action.type === 'none') {
      if (finding.status === 'valid') {
        touched.add(existing.id);
        const entry: KnowledgeEntry = {
          ...existing,
          updated_at: nowIso,
          last_verified_at: nowIso,
        };
        const relativePath = knowledgeRelativePath(entry);
        updates.push({
          entry,
          path: relativePath,
          bytes: serializeKnowledge(entry),
        });
      }
      continue;
    }

    touched.add(existing.id);
    if (action.type === 'update') {
      const entry = toUpdatedEntry(existing, action, nowIso);
      const relativePath = knowledgeRelativePath(entry);
      updates.push({
        entry,
        path: relativePath,
        bytes: serializeKnowledge(entry),
      });
      continue;
    }

    if (action.type === 'archive') {
      archive.push({ id: existing.id, reason: action.reason });
      continue;
    }

    // supersede
    const entry = toSupersedingEntry(existing, action, nowIso);
    const relativePath = knowledgeRelativePath(entry);
    supersede.push({
      old_id: existing.id,
      entry,
      path: relativePath,
      bytes: serializeKnowledge(entry),
    });
  }

  return {
    preview_id: createId('preview'),
    context_head: options.contextHead,
    workspace_id: options.workspaceId,
    packet_ids: packets.map((packet) => packet.packet_id),
    packet_hashes: packets.map((packet) => packet.packet_hash),
    changes: {
      creates,
      updates,
      supersede,
      archive,
    },
    warnings,
  };
}
