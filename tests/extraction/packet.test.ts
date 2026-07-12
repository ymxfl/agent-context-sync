import { describe, expect, it } from 'vitest';
import type { CoverageReport } from '../../src/adapters/adapter.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { createExtractionPacket, type PacketInput } from '../../src/extraction/packet.js';

const root = '/Users/alice/work/api';
const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
const contentHash = `sha256:${'a'.repeat(64)}`;

const coverageReports: CoverageReport[] = [{
  agent: 'codex',
  sources: [{
    agent: 'codex',
    sourceType: 'project-instructions',
    locator: `${root}/AGENTS.md`,
    shareability: 'team',
    status: 'available',
  }],
  coverage: [{
    id: 'codex-known-sources',
    status: 'partial',
    locator: `${root}/AGENTS.md`,
    detail: `Token ${secret} was excluded at ${root}/private.txt.`,
  }],
  loadPlan: [{
    order: 0,
    locator: `${root}/AGENTS.md`,
    sourceType: 'project-instructions',
    loading: 'eager',
  }],
}];

const existingKnowledge: KnowledgeEntry[] = [{
  schema_version: 1,
  id: 'kn_01J00000000000000000000000',
  kind: 'workflow',
  scope: 'workspace',
  status: 'active',
  applies_to: { paths: ['src/**'], agents: ['codex'] },
  source: {
    agent: 'codex',
    source_type: 'project-instructions',
    locator: 'AGENTS.md',
    content_hash: contentHash,
    observed_at: '2026-07-11T10:00:00Z',
  },
  confidence: 0.9,
  supersedes: [],
  conflicts_with: [],
  created_at: '2026-07-11T10:00:00Z',
  updated_at: '2026-07-11T10:00:00Z',
  last_verified_at: null,
  statement: `Never print ${secret}.`,
  reason: `It was stored at ${root}/private.txt.`,
}];

function input(): PacketInput {
  return {
    packetId: 'packet_01J00000000000000000000000',
    contextHead: 'abc123',
    localRoots: [root],
    coverageReports,
    selectedExcerpts: [{
      agent: 'codex',
      locator: `${root}/AGENTS.md`,
      contentHash,
      lineStart: 3,
      lineEnd: 5,
      excerpt: `Use pnpm. token=${secret}\nSee ${root}/package.json.`,
    }],
    existingKnowledge,
  };
}

describe('createExtractionPacket', () => {
  it('keeps only logical source metadata, hashes, line ranges, and redacted excerpts', () => {
    const packet = createExtractionPacket(input());

    expect(packet.sources).toEqual([expect.objectContaining({
      agent: 'codex',
      source_type: 'project-instructions',
      locator: '[REPOSITORY_ROOT]/AGENTS.md',
      shareability: 'team',
      content_hash: contentHash,
      line_start: 3,
      line_end: 5,
    })]);
    expect(packet.sources[0]).not.toHaveProperty('absolutePath');
    expect(packet.sources[0]?.excerpt).toContain('[REDACTED_SECRET]');
    expect(packet.sources[0]?.excerpt).toContain('[REPOSITORY_ROOT]/package.json');
    expect(JSON.stringify(packet)).not.toContain('/Users/alice');
    expect(JSON.stringify(packet)).not.toContain(secret);
  });

  it('includes redacted coverage, existing summaries, context identity, and a JSON output contract', () => {
    const packet = createExtractionPacket(input());

    expect(packet).toMatchObject({
      schema_version: 1,
      packet_id: 'packet_01J00000000000000000000000',
      context_head: 'abc123',
      coverage: [{ agent: 'codex' }],
      existing: [{ id: existingKnowledge[0]?.id, status: 'active' }],
      output_contract: {
        format: 'json',
        schema_version: 1,
        required: ['schema_version', 'packet_id', 'accepted', 'rejected'],
      },
    });
    expect(JSON.stringify(packet.existing)).not.toContain(secret);
    expect(JSON.stringify(packet.coverage)).not.toContain(secret);
    expect(packet.packet_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic, deeply frozen, and leaves every input unchanged', () => {
    const candidate = input();
    const snapshot = structuredClone(candidate);
    const first = createExtractionPacket(candidate);
    const second = createExtractionPacket(candidate);

    expect(first).toEqual(second);
    expect(candidate).toEqual(snapshot);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.sources[0])).toBe(true);
    expect(Object.isFrozen(first.output_contract.properties.accepted)).toBe(true);
  });

  it('rejects excerpts that are not backed by discovered sources and invalid ranges', () => {
    const missing = input();
    missing.selectedExcerpts[0] = { ...missing.selectedExcerpts[0]!, locator: `${root}/missing.md` };
    expect(() => createExtractionPacket(missing)).toThrow(/discovered source/i);

    const invalidRange = input();
    invalidRange.selectedExcerpts[0] = {
      ...invalidRange.selectedExcerpts[0]!,
      lineStart: 8,
      lineEnd: 7,
    };
    expect(() => createExtractionPacket(invalidRange)).toThrow(/line range/i);
  });

  it('rejects malformed packet and content hash identities', () => {
    expect(() => createExtractionPacket({ ...input(), packetId: 'packet_bad' })).toThrow(/packet/i);
    const malformed = input();
    malformed.selectedExcerpts[0] = { ...malformed.selectedExcerpts[0]!, contentHash: 'sha256:nope' };
    expect(() => createExtractionPacket(malformed)).toThrow(/content hash/i);
  });
});
