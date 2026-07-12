import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimPreview,
  peekPreview,
  previewRecordPath,
  savePreview,
} from '../../src/workspace/preview-store.js';
import type { WorkspacePreview } from '../../src/workspace/context-repository.js';

describe('preview store', () => {
  let home: string;
  let preview: WorkspacePreview;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(tmpdir(), 'acs-preview-store-'));
    preview = {
      operation: 'init',
      preview_id: 'preview_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      input_hash: '0'.repeat(64),
      context_head: 'UNBORN',
      workspace_id: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      normalized_input: {
        name: 'platform', context_remote: 'git@github.com:acme/context.git',
        scan_root: home, max_depth: 1, home,
      },
      files_to_write: [], repositories: [], warnings: [],
    };
  });

  afterEach(async () => fs.rm(home, { recursive: true, force: true }));

  it('stores private authenticated preview state with mode 0600', async () => {
    await savePreview(home, preview, { now: 1_000, ttlMs: 10_000 });
    const file = previewRecordPath(home, preview.preview_id);
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      context_state_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      business_state_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await claimPreview(home, preview.preview_id, 'init', { now: 2_000 }))
      .toEqual(preview);
  });

  it('rejects alteration of persisted preview state', async () => {
    await savePreview(home, preview, { now: 1_000, ttlMs: 10_000 });
    const file = previewRecordPath(home, preview.preview_id);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    (record.preview as WorkspacePreview).workspace_id = 'ws_01J00000000000000000000000';
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    await expect(claimPreview(home, preview.preview_id, 'init', { now: 2_000 }))
      .rejects.toMatchObject({ code: 'INVALID_PREVIEW' });
  });

  it('rejects expired and reused previews', async () => {
    await savePreview(home, preview, { now: 1_000, ttlMs: 100 });
    await expect(claimPreview(home, preview.preview_id, 'init', { now: 1_101 }))
      .rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });

    preview.preview_id = 'preview_01J00000000000000000000000';
    await savePreview(home, preview, { now: 2_000, ttlMs: 100 });
    await claimPreview(home, preview.preview_id, 'init', { now: 2_001 });
    await expect(claimPreview(home, preview.preview_id, 'init', { now: 2_002 }))
      .rejects.toMatchObject({ code: 'PREVIEW_ALREADY_USED' });
    await expect(peekPreview(home, preview.preview_id, 'init', { now: 2_002 }))
      .rejects.toMatchObject({ code: 'PREVIEW_ALREADY_USED' });
  });

  it('allows exactly one concurrent claimant', async () => {
    await savePreview(home, preview, { now: 1_000, ttlMs: 10_000 });
    const results = await Promise.allSettled([
      claimPreview(home, preview.preview_id, 'init', { now: 2_000 }),
      claimPreview(home, preview.preview_id, 'init', { now: 2_000 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
