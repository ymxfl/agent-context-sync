import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { appError } from '../domain/errors.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import type { WorkspaceOperation, WorkspacePreview } from './context-repository.js';

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const PREVIEW_ID = /^preview_[0-9A-HJKMNP-TV-Z]{26}$/;

interface StoredPreview {
  version: 1;
  expires_at: number;
  context_state_hash: string;
  business_state_hash: string;
  preview: WorkspacePreview;
  mac: string;
}

interface ClockOptions { now?: number; ttlMs?: number }

function assertPreviewId(previewId: string): void {
  if (!PREVIEW_ID.test(previewId)) throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
}

function previewsDirectory(home: string): string {
  return path.resolve(home, 'previews');
}

export function previewRecordPath(home: string, previewId: string): string {
  assertPreviewId(previewId);
  return path.join(previewsDirectory(home), `${previewId}.json`);
}

function usedPreviewPath(home: string, previewId: string): string {
  return path.join(previewsDirectory(home), `${previewId}.used`);
}

function keyPath(home: string): string {
  return path.resolve(home, 'preview-auth.key');
}

async function previewKey(home: string): Promise<Buffer> {
  const file = keyPath(home);
  try {
    return Buffer.from(await fs.readFile(file, 'utf8'), 'base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = randomBytes(32).toString('base64');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(candidate, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Buffer.from(candidate, 'base64');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return Buffer.from(await fs.readFile(file, 'utf8'), 'base64');
  }
}

function stateHashes(preview: WorkspacePreview): { context: string; business: string } {
  return {
    context: createHash('sha256').update(preview.context_head).digest('hex'),
    business: createHash('sha256').update(JSON.stringify(preview.repositories)).digest('hex'),
  };
}

function authenticatedBytes(expiresAt: number, preview: WorkspacePreview): string {
  const hashes = stateHashes(preview);
  return JSON.stringify({
    version: 1,
    expires_at: expiresAt,
    context_state_hash: hashes.context,
    business_state_hash: hashes.business,
    preview,
  });
}

function macFor(key: Buffer, expiresAt: number, preview: WorkspacePreview): string {
  return createHmac('sha256', key).update(authenticatedBytes(expiresAt, preview)).digest('hex');
}

export async function savePreview(
  home: string,
  preview: WorkspacePreview,
  options: ClockOptions = {},
): Promise<void> {
  assertPreviewId(preview.preview_id);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const key = await previewKey(home);
  const hashes = stateHashes(preview);
  const stored: StoredPreview = {
    version: 1,
    expires_at: expiresAt,
    context_state_hash: hashes.context,
    business_state_hash: hashes.business,
    preview,
    mac: macFor(key, expiresAt, preview),
  };
  await atomicWriteFile(previewRecordPath(home, preview.preview_id), JSON.stringify(stored));
}

export async function claimPreview(
  home: string,
  previewId: string,
  operation: WorkspaceOperation,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<WorkspacePreview> {
  const pending = previewRecordPath(home, previewId);
  const used = usedPreviewPath(home, previewId);
  try {
    await fs.rename(pending, used);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.access(used);
      throw appError('PREVIEW_ALREADY_USED', 'Preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw appError('INVALID_PREVIEW', 'Preview does not exist');
    }
  }

  return readAuthenticatedPreview(home, used, previewId, operation, options.now);
}

async function readAuthenticatedPreview(
  home: string,
  file: string,
  previewId: string,
  operation: WorkspaceOperation,
  now = Date.now(),
): Promise<WorkspacePreview> {
  let stored: StoredPreview;
  try {
    stored = JSON.parse(await fs.readFile(file, 'utf8')) as StoredPreview;
  } catch {
    throw appError('INVALID_PREVIEW', 'Stored preview is invalid');
  }
  const key = await previewKey(home);
  const expected = Buffer.from(macFor(key, stored.expires_at, stored.preview), 'hex');
  const actual = typeof stored.mac === 'string' ? Buffer.from(stored.mac, 'hex') : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw appError('INVALID_PREVIEW', 'Stored preview authentication failed');
  }
  const hashes = stateHashes(stored.preview);
  if (stored.context_state_hash !== hashes.context || stored.business_state_hash !== hashes.business) {
    throw appError('INVALID_PREVIEW', 'Stored preview state hashes do not match');
  }
  if (stored.preview.preview_id !== previewId || stored.preview.operation !== operation) {
    throw appError('INVALID_PREVIEW', 'Stored preview does not match the requested operation');
  }
  if (now > stored.expires_at) {
    throw appError('PREVIEW_EXPIRED', 'Preview approval has expired');
  }
  return stored.preview;
}

export async function peekPreview(
  home: string,
  previewId: string,
  operation: WorkspaceOperation,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<WorkspacePreview> {
  const pending = previewRecordPath(home, previewId);
  try {
    return await readAuthenticatedPreview(home, pending, previewId, operation, options.now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'INVALID_PREVIEW') throw error;
    try {
      await fs.access(usedPreviewPath(home, previewId));
      throw appError('PREVIEW_ALREADY_USED', 'Preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw error;
    }
  }
}
