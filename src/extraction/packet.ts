import { createHash } from 'node:crypto';
import type {
  AgentName,
  CoverageReport,
  Shareability,
} from '../adapters/adapter.js';
import type { CoverageStatus, KnowledgeEntry, KnowledgeStatus } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';
import { redactCandidate } from '../security/redact.js';

const PACKET_ID = /^packet_[0-9A-HJKMNP-TV-Z]{26}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const CONTEXT_HEAD = /^(?:UNBORN|[0-9a-f]{4,64})$/i;

export interface SelectedExcerpt {
  agent: AgentName;
  locator: string;
  contentHash: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
}

export interface PacketInput {
  packetId: string;
  contextHead: string;
  localRoots: string[];
  coverageReports: CoverageReport[];
  selectedExcerpts: SelectedExcerpt[];
  existingKnowledge: KnowledgeEntry[];
}

export interface ExtractionPacketSource {
  readonly agent: AgentName;
  readonly source_type: string;
  readonly locator: string;
  readonly shareability: Shareability;
  readonly content_hash: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly excerpt: string;
}

export interface ExtractionCoverageItem {
  readonly id: string;
  readonly status: CoverageStatus;
  readonly locator?: string;
  readonly detail: string;
}

export interface ExtractionCoverage {
  readonly agent: AgentName;
  readonly items: readonly ExtractionCoverageItem[];
  readonly limits?: Readonly<{ max_bytes?: number; truncated?: boolean }>;
}

export interface ExistingKnowledgeSummary {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly status: KnowledgeStatus;
  readonly source_hash: string;
  readonly statement: string;
  readonly reason: string;
}

export interface ExtractionOutputContract {
  readonly format: 'json';
  readonly schema_version: 1;
  readonly required: readonly ['schema_version', 'packet_id', 'accepted', 'rejected'];
  readonly properties: Readonly<{
    schema_version: Readonly<{ const: 1 }>;
    packet_id: Readonly<{ const: string }>;
    accepted: Readonly<{ type: 'array'; item: 'ProposedKnowledge' }>;
    rejected: Readonly<{ type: 'array'; item: 'RejectedCandidate' }>;
  }>;
}

export interface ExtractionPacket {
  readonly schema_version: 1;
  readonly packet_id: string;
  readonly packet_hash: string;
  readonly context_head: string;
  readonly sources: readonly ExtractionPacketSource[];
  readonly coverage: readonly ExtractionCoverage[];
  readonly existing: readonly ExistingKnowledgeSummary[];
  readonly output_contract: ExtractionOutputContract;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function redact(value: string, roots: string[]): string {
  return redactCandidate(value, roots).redacted;
}

function sourceOrder(left: ExtractionPacketSource, right: ExtractionPacketSource): number {
  return compareCodeUnits(left.agent, right.agent)
    || compareCodeUnits(left.locator, right.locator)
    || left.line_start - right.line_start
    || left.line_end - right.line_end
    || compareCodeUnits(left.content_hash, right.content_hash);
}

function coverageOrder(left: ExtractionCoverageItem, right: ExtractionCoverageItem): number {
  return compareCodeUnits(left.id, right.id)
    || compareCodeUnits(left.locator ?? '', right.locator ?? '');
}

function outputContract(packetId: string): ExtractionOutputContract {
  return {
    format: 'json',
    schema_version: 1,
    required: ['schema_version', 'packet_id', 'accepted', 'rejected'],
    properties: {
      schema_version: { const: 1 },
      packet_id: { const: packetId },
      accepted: { type: 'array', item: 'ProposedKnowledge' },
      rejected: { type: 'array', item: 'RejectedCandidate' },
    },
  };
}

export function createExtractionPacket(input: PacketInput): ExtractionPacket {
  if (!PACKET_ID.test(input.packetId)) throw new Error('Invalid extraction packet ID');
  if (!CONTEXT_HEAD.test(input.contextHead)) throw new Error('Invalid Context HEAD');

  const reports = new Map(input.coverageReports.map((report) => [report.agent, report]));
  const sources = input.selectedExcerpts.map((excerpt): ExtractionPacketSource => {
    if (!CONTENT_HASH.test(excerpt.contentHash)) throw new Error('Invalid source content hash');
    if (
      !Number.isSafeInteger(excerpt.lineStart)
      || !Number.isSafeInteger(excerpt.lineEnd)
      || excerpt.lineStart < 1
      || excerpt.lineEnd < excerpt.lineStart
    ) throw new Error('Invalid excerpt line range');

    const discovered = reports.get(excerpt.agent)?.sources.find((source) => (
      source.agent === excerpt.agent && source.locator === excerpt.locator
    ));
    if (discovered === undefined) throw new Error('Selected excerpt must reference a discovered source');

    return {
      agent: excerpt.agent,
      source_type: redact(discovered.sourceType, input.localRoots),
      locator: redact(excerpt.locator, input.localRoots),
      shareability: discovered.shareability,
      content_hash: excerpt.contentHash,
      line_start: excerpt.lineStart,
      line_end: excerpt.lineEnd,
      excerpt: redact(excerpt.excerpt, input.localRoots),
    };
  }).sort(sourceOrder);

  const coverage = input.coverageReports.map((report): ExtractionCoverage => ({
    agent: report.agent,
    items: report.coverage.map((item): ExtractionCoverageItem => ({
      id: redact(item.id, input.localRoots),
      status: item.status,
      ...(item.locator === undefined ? {} : { locator: redact(item.locator, input.localRoots) }),
      detail: redact(item.detail, input.localRoots),
    })).sort(coverageOrder),
    ...(report.limits === undefined ? {} : {
      limits: {
        ...(report.limits.maxBytes === undefined ? {} : { max_bytes: report.limits.maxBytes }),
        ...(report.limits.truncated === undefined ? {} : { truncated: report.limits.truncated }),
      },
    }),
  })).sort((left, right) => compareCodeUnits(left.agent, right.agent));

  const existing = input.existingKnowledge.map((entry): ExistingKnowledgeSummary => ({
    id: entry.id,
    kind: redact(entry.kind, input.localRoots),
    scope: redact(entry.scope, input.localRoots),
    status: entry.status,
    source_hash: entry.source.content_hash,
    statement: redact(entry.statement, input.localRoots),
    reason: redact(entry.reason, input.localRoots),
  })).sort((left, right) => compareCodeUnits(left.id, right.id));

  const body = {
    schema_version: 1 as const,
    packet_id: input.packetId,
    context_head: input.contextHead,
    sources,
    coverage,
    existing,
    output_contract: outputContract(input.packetId),
  };
  const packet: ExtractionPacket = {
    ...body,
    packet_hash: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`,
  };
  return deepFreeze(packet) as ExtractionPacket;
}
