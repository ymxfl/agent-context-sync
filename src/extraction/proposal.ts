import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';

import type { ExtractionPacket, ExtractionPacketSource } from './packet.js';
import type {
  ExtractionProposal,
  KnowledgeEntry,
  KnowledgeParseContext,
  ProposedKnowledge,
  RejectedCandidate,
  SourceReference,
} from '../domain/model.js';
import { createId } from '../domain/ids.js';
import { serializeKnowledge } from '../knowledge/markdown.js';
import { parseExtractionProposal } from '../schema/extraction.js';

/** Match reason recorded when an accepted candidate is treated as a duplicate. */
export type DuplicateMatch = 'source_hash' | 'statement_hash';

/** One proposed create in a capture preview, including serialized markdown and unified diff. */
export interface CapturePreviewCreate {
  readonly entry: KnowledgeEntry;
  readonly path: string;
  readonly bytes: string;
  readonly diff: string;
}

/** Deterministic duplicate of an existing knowledge entry. */
export interface CapturePreviewDuplicate {
  readonly existing_id: string;
  readonly match: DuplicateMatch;
  readonly source: SourceReference;
  readonly statement: string;
}

/** Proposed archive of an existing entry referenced by supersedes. */
export interface CapturePreviewArchive {
  readonly id: string;
  readonly reason: string;
}

/** Capture preview bound to a packet hash and Context HEAD; never writes Context files. */
export interface CapturePreview {
  readonly preview_id: string;
  readonly packet_hash: string;
  readonly context_head: string;
  readonly workspace_id: string;
  readonly creates: readonly CapturePreviewCreate[];
  readonly updates: readonly [];
  readonly archives: readonly CapturePreviewArchive[];
  readonly rejections: readonly RejectedCandidate[];
  readonly duplicates: readonly CapturePreviewDuplicate[];
  readonly warnings: readonly string[];
}

export interface PreviewProposalOptions {
  readonly includePersonal: boolean;
  readonly registeredRepositoryIds: ReadonlySet<string>;
  readonly workspaceId: string;
  readonly now?: Date;
}

/** Collapse whitespace so statement-hash dedupe stays deterministic without embeddings. */
export function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ');
}

/** SHA-256 of a normalized statement used only for deterministic duplicate candidates. */
export function statementContentHash(statement: string): string {
  return `sha256:${createHash('sha256').update(normalizeStatement(statement)).digest('hex')}`;
}

function knowledgeRelativePath(entry: Pick<KnowledgeEntry, 'id' | 'scope'>): string {
  if (entry.scope === 'workspace') return `knowledge/workspace/${entry.id}.md`;
  return `knowledge/repositories/${entry.scope.slice('repository:'.length)}/${entry.id}.md`;
}

function findPacketSource(
  packet: ExtractionPacket,
  contentHash: string,
): ExtractionPacketSource | undefined {
  return packet.sources.find((source) => source.content_hash === contentHash);
}

function toKnowledgeEntry(proposed: ProposedKnowledge, nowIso: string): KnowledgeEntry {
  return {
    schema_version: 1,
    id: createId('kn'),
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
    last_verified_at: null,
    ...proposed,
  };
}

/**
 * Validate an agent extraction proposal against its packet and produce a capture preview.
 * Duplicate detection uses exact source hashes first, then normalized statement hashes.
 */
export function previewKnowledgeProposal(
  packet: ExtractionPacket,
  proposalInput: unknown,
  options: PreviewProposalOptions,
): CapturePreview {
  const context: KnowledgeParseContext = {
    registeredRepositoryIds: options.registeredRepositoryIds,
  };
  const proposal: ExtractionProposal = parseExtractionProposal(proposalInput, context);
  if (proposal.packet_id !== packet.packet_id) {
    throw new Error('Proposal packet_id does not match the extraction packet');
  }

  const nowIso = (options.now ?? new Date()).toISOString();
  const activeExisting = packet.existing.filter((item) => item.status === 'active');
  const bySourceHash = new Map(
    activeExisting.map((item) => [item.source_hash, item] as const),
  );
  const byStatementHash = new Map(
    activeExisting.map((item) => [statementContentHash(item.statement), item] as const),
  );

  const creates: CapturePreviewCreate[] = [];
  const duplicates: CapturePreviewDuplicate[] = [];
  const rejections: RejectedCandidate[] = [...proposal.rejected];
  const archives: CapturePreviewArchive[] = [];
  const warnings: string[] = [];
  const archivedIds = new Set<string>();

  for (const accepted of proposal.accepted) {
    const packetSource = findPacketSource(packet, accepted.source.content_hash);
    if (packetSource === undefined) {
      rejections.push({
        source: accepted.source,
        reason: 'Accepted candidate source hash is absent from the extraction packet',
      });
      continue;
    }

    if (packetSource.shareability === 'personal' && !options.includePersonal) {
      rejections.push({
        source: accepted.source,
        reason: 'Personal source requires explicit include_personal approval',
      });
      continue;
    }

    if (packetSource.shareability === 'managed') {
      rejections.push({
        source: accepted.source,
        reason: 'Managed sources cannot enter team knowledge candidates',
      });
      continue;
    }

    const sourceHit = bySourceHash.get(accepted.source.content_hash);
    if (sourceHit !== undefined) {
      duplicates.push({
        existing_id: sourceHit.id,
        match: 'source_hash',
        source: accepted.source,
        statement: accepted.statement,
      });
      continue;
    }

    const statementHit = byStatementHash.get(statementContentHash(accepted.statement));
    if (statementHit !== undefined) {
      duplicates.push({
        existing_id: statementHit.id,
        match: 'statement_hash',
        source: accepted.source,
        statement: accepted.statement,
      });
      continue;
    }

    const entry = toKnowledgeEntry(accepted, nowIso);
    const relativePath = knowledgeRelativePath(entry);
    const bytes = serializeKnowledge(entry);
    creates.push({
      entry,
      path: relativePath,
      bytes,
      diff: createTwoFilesPatch(relativePath, relativePath, '', bytes),
    });

    for (const target of accepted.supersedes) {
      if (archivedIds.has(target)) continue;
      const known = packet.existing.find((item) => item.id === target);
      if (known === undefined) {
        warnings.push(`Supersedes target ${target} is not present in the packet existing set`);
        continue;
      }
      archivedIds.add(target);
      archives.push({
        id: target,
        reason: `Superseded by proposed ${entry.id}`,
      });
    }

    if (accepted.conflicts_with.length > 0) {
      warnings.push(
        `Proposed ${entry.id} declares conflicts_with: ${accepted.conflicts_with.join(', ')}`,
      );
    }
  }

  return {
    preview_id: createId('preview'),
    packet_hash: packet.packet_hash,
    context_head: packet.context_head,
    workspace_id: options.workspaceId,
    creates,
    updates: [],
    archives,
    rejections,
    duplicates,
    warnings,
  };
}
