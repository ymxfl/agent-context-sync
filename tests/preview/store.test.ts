import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CapturePreview } from '../../src/extraction/proposal.js';
import {
  capturePreviewRecordPath,
  peekCapturePreview,
  saveCapturePreview,
} from '../../src/preview/store.js';

const now = '2026-07-11T10:00:00.000Z';
const hash = `sha256:${'a'.repeat(64)}`;

function capturePreview(overrides: Partial<CapturePreview> = {}): CapturePreview {
  // Intentionally use a key order that differs from the zod schema so HMAC
  // must authenticate the raw JSON object, not a schema-rebuilt clone.
  const entry = {
    reason: 'Round-trip authentication must use raw JSON field order.',
    statement: 'Prefer focused capture previews.',
    last_verified_at: null,
    updated_at: now,
    created_at: now,
    conflicts_with: [] as string[],
    supersedes: [] as string[],
    confidence: 0.9,
    source: {
      observed_at: now,
      content_hash: hash,
      locator: 'AGENTS.md',
      source_type: 'project-instructions',
      agent: 'codex',
    },
    applies_to: { agents: ['codex'], paths: ['src/**'] },
    status: 'active' as const,
    scope: 'workspace' as const,
    kind: 'workflow',
    id: 'kn_01J00000000000000000000000',
    schema_version: 1 as const,
  };
  const relativePath = `knowledge/workspace/${entry.id}.md`;
  const bytes = [
    '---',
    'schema_version: 1',
    `id: ${entry.id}`,
    '---',
    '',
    entry.statement,
    '',
  ].join('\n');
  const preview = {
    warnings: ['deterministic auth regression fixture'],
    duplicates: [] as CapturePreview['duplicates'],
    rejections: [] as CapturePreview['rejections'],
    archives: [] as CapturePreview['archives'],
    updates: [] as CapturePreview['updates'],
    creates: [{
      diff: `--- ${relativePath}\n+++ ${relativePath}\n@@ -0,0 +1,2 @@\n+${entry.statement}\n+`,
      bytes,
      path: relativePath,
      entry,
    }],
    context_head: 'abc123def',
    packet_hash: `sha256:${'b'.repeat(64)}`,
    preview_id: 'preview_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ...overrides,
  };
  return preview as CapturePreview;
}

describe('capture preview store', () => {
  let home: string;
  let preview: CapturePreview;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'acs-capture-preview-store-'));
    preview = capturePreview();
  });

  afterEach(async () => fs.rm(home, { recursive: true, force: true }));

  it('round-trips an authenticated preview that includes creates', async () => {
    await saveCapturePreview(home, preview, { now: 1_000, ttlMs: 10_000 });

    await expect(peekCapturePreview(home, preview.preview_id, { now: 2_000 }))
      .resolves.toEqual(preview);
  });

  it('stores private authenticated preview state with mode 0600', async () => {
    await saveCapturePreview(home, preview, { now: 1_000, ttlMs: 10_000 });
    const file = capturePreviewRecordPath(home, preview.preview_id);

    expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect((await fs.stat(path.join(home, 'capture-preview-auth.key'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(home, 'capture-previews'))).mode & 0o777).toBe(0o700);
  });

  it('rejects alteration of persisted preview state', async () => {
    await saveCapturePreview(home, preview, { now: 1_000, ttlMs: 10_000 });
    const file = capturePreviewRecordPath(home, preview.preview_id);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as {
      preview: { warnings: string[] };
    };
    record.preview.warnings = ['tampered'];
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });

    await expect(peekCapturePreview(home, preview.preview_id, { now: 2_000 }))
      .rejects.toMatchObject({ code: 'INVALID_PREVIEW' });
  });

  it('rejects expired capture previews', async () => {
    await saveCapturePreview(home, preview, { now: 1_000, ttlMs: 100 });

    await expect(peekCapturePreview(home, preview.preview_id, { now: 1_101 }))
      .rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
  });
});
