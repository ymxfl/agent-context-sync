import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoverageReport } from '../../src/adapters/adapter.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { createExtractionPacket } from '../../src/extraction/packet.js';
import {
  persistExtractionPacket,
  previewCapture,
} from '../../src/commands/capture.js';

const root = '/Users/alice/work/api';
const teamHash = `sha256:${'a'.repeat(64)}`;
const personalHash = `sha256:${'b'.repeat(64)}`;
const otherHash = `sha256:${'c'.repeat(64)}`;
const now = '2026-07-11T10:00:00Z';

const existing: KnowledgeEntry = {
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
    content_hash: teamHash,
    observed_at: now,
  },
  confidence: 0.9,
  supersedes: [],
  conflicts_with: [],
  created_at: now,
  updated_at: now,
  last_verified_at: null,
  statement: 'Always use pnpm for installs.',
  reason: 'The repo pins pnpm in packageManager.',
};

const coverageReports: CoverageReport[] = [{
  agent: 'codex',
  sources: [
    {
      agent: 'codex',
      sourceType: 'project-instructions',
      locator: `${root}/AGENTS.md`,
      shareability: 'team',
      status: 'available',
    },
    {
      agent: 'codex',
      sourceType: 'project-instructions',
      locator: `${root}/TEAM.md`,
      shareability: 'team',
      status: 'available',
    },
    {
      agent: 'codex',
      sourceType: 'global-instructions',
      locator: `${root}/../home/AGENTS.md`,
      shareability: 'personal',
      status: 'available',
    },
  ],
  coverage: [{
    id: 'codex-known-sources',
    status: 'partial',
    detail: 'Partial coverage for tests.',
  }],
  loadPlan: [],
}];

function statementHash(statement: string): string {
  const normalized = statement.trim().replace(/\s+/g, ' ');
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function packetFor(existingKnowledge: KnowledgeEntry[] = [existing]) {
  return createExtractionPacket({
    packetId: 'packet_01J00000000000000000000000',
    contextHead: 'abc123def',
    localRoots: [root],
    coverageReports,
    selectedExcerpts: [
      {
        agent: 'codex',
        locator: `${root}/AGENTS.md`,
        contentHash: teamHash,
        lineStart: 1,
        lineEnd: 2,
        excerpt: 'Use pnpm.\nNever commit secrets.',
      },
      {
        agent: 'codex',
        locator: `${root}/TEAM.md`,
        contentHash: otherHash,
        lineStart: 1,
        lineEnd: 1,
        excerpt: 'Shared team note.',
      },
      {
        agent: 'codex',
        locator: `${root}/../home/AGENTS.md`,
        contentHash: personalHash,
        lineStart: 1,
        lineEnd: 1,
        excerpt: 'My personal shortcut.',
      },
    ],
    existingKnowledge,
  });
}

function proposed(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'workflow',
    scope: 'workspace',
    applies_to: { paths: ['src/**'], agents: ['codex'] },
    source: {
      agent: 'codex',
      source_type: 'project-instructions',
      locator: 'AGENTS.md',
      content_hash: otherHash,
      observed_at: now,
    },
    confidence: 0.8,
    supersedes: [],
    conflicts_with: [],
    statement: 'Prefer integration tests for Git workflows.',
    reason: 'Unit mocks hide daemon timing issues.',
    ...overrides,
  };
}

describe('previewCapture proposal validation', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'acs-proposal-'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('dedupes by exact source hash first, then normalized statement hash', async () => {
    const packet = packetFor();
    await persistExtractionPacket(home, packet, {
      includePersonal: false,
      registeredRepositoryIds: ['github.com/acme/api'],
      workspaceId: 'ws_01J00000000000000000000000',
    });

    const proposal = {
      schema_version: 1 as const,
      packet_id: packet.packet_id,
      accepted: [
        proposed({
          source: {
            agent: 'codex',
            source_type: 'project-instructions',
            locator: 'AGENTS.md',
            content_hash: teamHash,
            observed_at: now,
          },
          statement: 'Different wording for the same source.',
          reason: 'Should match existing by source hash.',
        }),
        proposed({
          source: {
            agent: 'codex',
            source_type: 'project-instructions',
            locator: 'AGENTS.md',
            content_hash: otherHash,
            observed_at: now,
          },
          statement: '  Always   use   pnpm for installs.  ',
          reason: 'Should match existing by normalized statement.',
        }),
        proposed({
          statement: 'Prefer integration tests for Git workflows.',
          reason: 'Unique candidate becomes a create.',
        }),
      ],
      rejected: [],
    };

    const preview = await previewCapture(packet.packet_id, proposal, { home });

    expect(preview.creates).toHaveLength(1);
    expect(preview.duplicates).toContainEqual(expect.objectContaining({
      existing_id: existing.id,
    }));
    expect(preview.duplicates).toHaveLength(2);
    expect(preview.duplicates.map((item) => item.match)).toEqual(
      expect.arrayContaining(['source_hash', 'statement_hash']),
    );
    expect(preview.context_head).toBe(packet.context_head);
    expect(preview.packet_hash).toBe(packet.packet_hash);
    expect(preview.creates[0]?.entry.status).toBe('active');
    expect(preview.creates[0]?.entry.id).toMatch(/^kn_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(preview.creates[0]?.path).toMatch(/^knowledge\/workspace\/kn_.*\.md$/);
    expect(preview.creates[0]?.bytes).toContain('Prefer integration tests');
    expect(preview.creates[0]?.diff).toContain('+++');
    expect(statementHash('Always use pnpm for installs.')).toMatch(/^sha256:/);
  });

  it('rejects accepted candidates whose source hash is absent from the packet', async () => {
    const packet = packetFor();
    await persistExtractionPacket(home, packet, {
      includePersonal: false,
      registeredRepositoryIds: [],
      workspaceId: 'ws_01J00000000000000000000000',
    });

    const missingHash = `sha256:${'d'.repeat(64)}`;
    const preview = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [proposed({
        source: {
          agent: 'codex',
          source_type: 'project-instructions',
          locator: 'AGENTS.md',
          content_hash: missingHash,
          observed_at: now,
        },
      })],
      rejected: [],
    }, { home });

    expect(preview.creates).toHaveLength(0);
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.rejections).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/source hash|packet/i),
    }));
  });

  it('rejects personal sources without include_personal approval', async () => {
    const packet = packetFor([]);
    await persistExtractionPacket(home, packet, {
      includePersonal: false,
      registeredRepositoryIds: [],
      workspaceId: 'ws_01J00000000000000000000000',
    });

    const preview = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [proposed({
        source: {
          agent: 'codex',
          source_type: 'global-instructions',
          locator: 'home/AGENTS.md',
          content_hash: personalHash,
          observed_at: now,
        },
        statement: 'Keep my private alias.',
        reason: 'Personal preference.',
      })],
      rejected: [],
    }, { home });

    expect(preview.creates).toHaveLength(0);
    expect(preview.rejections).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/personal|include_personal|approval/i),
    }));
  });

  it('binds preview identity to packet hash and Context HEAD without writing Context files', async () => {
    const packet = packetFor([]);
    await persistExtractionPacket(home, packet, {
      includePersonal: true,
      registeredRepositoryIds: [],
      workspaceId: 'ws_01J00000000000000000000000',
    });

    const preview = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [proposed({
        source: {
          agent: 'codex',
          source_type: 'global-instructions',
          locator: 'home/AGENTS.md',
          content_hash: personalHash,
          observed_at: now,
        },
        statement: 'Document the personal alias only when approved.',
        reason: 'Explicit include_personal was granted at prepare.',
      })],
      rejected: [],
    }, { home });

    expect(preview.preview_id).toMatch(/^preview_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(preview.packet_hash).toBe(packet.packet_hash);
    expect(preview.context_head).toBe(packet.context_head);
    expect(preview.creates).toHaveLength(1);
    expect(preview.updates).toEqual([]);
    expect(preview.archives).toEqual([]);
    expect(preview.warnings).toEqual(expect.any(Array));

    const contexts = path.join(home, 'contexts');
    await expect(fs.access(contexts)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
