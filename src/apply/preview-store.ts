import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { appError } from '../domain/errors.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import type { ApplyPreview } from './preview.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const PREVIEW_ID = /^preview_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKSPACE_ID = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/;

interface ClockOptions {
  now?: number;
  ttlMs?: number;
}

interface StoredApplyPreview {
  version: 1;
  expires_at: number;
  context_head: string;
  business_heads_hash: string;
  target_hashes_hash: string;
  preview: ApplyPreview;
  mac: string;
}

const applyPreviewFileSchema = z.strictObject({
  repo_id: z.string().min(1),
  agent: z.enum(['claude-code', 'codex']),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  action: z.enum(['create', 'replace', 'unchanged']),
  current_hash: z.string().regex(HASH).nullable(),
  generated_hash: z.string().regex(DIGEST),
  generated_bytes: z.string(),
  diff: z.string(),
});

const driftCandidateSchema = z.strictObject({
  repo_id: z.string().min(1),
  agent: z.enum(['claude-code', 'codex']),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  reason: z.enum(['missing_acs_header', 'body_mismatch']),
  current_hash: z.string().regex(HASH).nullable(),
  generated_hash: z.string().regex(DIGEST),
  diff: z.string(),
});

const applyPreviewSchema = z.strictObject({
  preview_id: z.string().regex(PREVIEW_ID),
  workspace_id: z.string().regex(WORKSPACE_ID),
  context_head: z.string().min(1),
  business_heads: z.record(z.string(), z.string().min(1)),
  target_hashes: z.record(z.string(), z.string().regex(HASH).nullable()),
  agents: z.array(z.enum(['claude-code', 'codex'])).min(1),
  files: z.array(applyPreviewFileSchema),
  drift_candidates: z.array(driftCandidateSchema),
  warnings: z.array(z.string()),
});

const storedApplyPreviewSchema = z.strictObject({
  version: z.literal(1),
  expires_at: z.number().finite(),
  context_head: z.string().min(1),
  business_heads_hash: z.string().regex(HASH),
  target_hashes_hash: z.string().regex(HASH),
  preview: applyPreviewSchema,
  mac: z.string().regex(HASH),
});

function assertPreviewId(previewId: string): void {
  if (!PREVIEW_ID.test(previewId)) throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
}

function previewsDirectory(home: string): string {
  return path.resolve(home, 'apply-previews');
}

/** Absolute path for a pending apply preview record. */
export function applyPreviewRecordPath(home: string, previewId: string): string {
  assertPreviewId(previewId);
  return path.join(previewsDirectory(home), `${previewId}.json`);
}

function usedApplyPreviewPath(home: string, previewId: string): string {
  assertPreviewId(previewId);
  return path.join(previewsDirectory(home), `${previewId}.used`);
}

function keyPath(home: string): string {
  return path.resolve(home, 'apply-preview-auth.key');
}

function businessHeadsHash(heads: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(heads)).digest('hex');
}

function targetHashesHash(hashes: Record<string, string | null>): string {
  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}

function authenticatedBytes(
  expiresAt: number,
  contextHead: string,
  businessDigest: string,
  targetDigest: string,
  preview: ApplyPreview,
): string {
  return JSON.stringify({
    version: 1,
    expires_at: expiresAt,
    context_head: contextHead,
    business_heads_hash: businessDigest,
    target_hashes_hash: targetDigest,
    preview,
  });
}

function macFor(
  key: Buffer,
  expiresAt: number,
  contextHead: string,
  businessDigest: string,
  targetDigest: string,
  preview: ApplyPreview,
): string {
  return createHmac('sha256', key)
    .update(authenticatedBytes(expiresAt, contextHead, businessDigest, targetDigest, preview))
    .digest('hex');
}

async function readValidatedKey(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw appError('INVALID_PREVIEW', 'Apply preview authentication key is invalid');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw appError('INVALID_PREVIEW', 'Apply preview authentication key is invalid');
    }
    const encoded = await handle.readFile('utf8');
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== 32 || key.toString('base64') !== encoded) {
      throw appError('INVALID_PREVIEW', 'Apply preview authentication key is invalid');
    }
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PREVIEW') throw error;
    throw appError('INVALID_PREVIEW', 'Apply preview authentication key is invalid');
  } finally {
    await handle.close();
  }
}

async function previewKey(home: string): Promise<Buffer> {
  const file = keyPath(home);
  try {
    return await readValidatedKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const candidate = randomBytes(32).toString('base64');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(candidate, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return readValidatedKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return readValidatedKey(file);
  }
}

async function ensurePreviewDirectory(home: string): Promise<void> {
  const directory = previewsDirectory(home);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) await fs.chmod(directory, 0o700);
  const info = await fs.lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw appError('INVALID_PREVIEW', 'Apply preview directory is invalid');
  }
}

/** Persist an apply preview under the local home with mode 0o600 and a 24h TTL. */
export async function saveApplyPreview(
  home: string,
  preview: ApplyPreview,
  options: ClockOptions = {},
): Promise<void> {
  assertPreviewId(preview.preview_id);
  await ensurePreviewDirectory(home);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const key = await previewKey(home);
  const businessDigest = businessHeadsHash(preview.business_heads);
  const targetsDigest = targetHashesHash(preview.target_hashes);
  const stored: StoredApplyPreview = {
    version: 1,
    expires_at: expiresAt,
    context_head: preview.context_head,
    business_heads_hash: businessDigest,
    target_hashes_hash: targetsDigest,
    preview,
    mac: macFor(
      key,
      expiresAt,
      preview.context_head,
      businessDigest,
      targetsDigest,
      preview,
    ),
  };
  await atomicWriteFile(applyPreviewRecordPath(home, preview.preview_id), JSON.stringify(stored));
}

async function readAuthenticatedPreview(
  home: string,
  file: string,
  previewId: string,
  now = Date.now(),
): Promise<ApplyPreview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw appError('INVALID_PREVIEW', 'Stored apply preview is invalid');
  }
  const validated = storedApplyPreviewSchema.safeParse(parsed);
  if (!validated.success) throw appError('INVALID_PREVIEW', 'Stored apply preview is invalid');
  // Authenticate the raw JSON object so MAC matches save-time field order.
  const stored = parsed as StoredApplyPreview;
  const key = await previewKey(home);
  const expected = Buffer.from(
    macFor(
      key,
      stored.expires_at,
      stored.context_head,
      stored.business_heads_hash,
      stored.target_hashes_hash,
      stored.preview,
    ),
    'hex',
  );
  const actual = typeof stored.mac === 'string' ? Buffer.from(stored.mac, 'hex') : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw appError('INVALID_PREVIEW', 'Stored apply preview authentication failed');
  }
  const businessDigest = businessHeadsHash(stored.preview.business_heads);
  const targetsDigest = targetHashesHash(stored.preview.target_hashes);
  if (
    stored.business_heads_hash !== businessDigest
    || stored.target_hashes_hash !== targetsDigest
    || stored.context_head !== stored.preview.context_head
    || stored.preview.preview_id !== previewId
  ) {
    throw appError('INVALID_PREVIEW', 'Stored apply preview state hashes do not match');
  }
  if (now > stored.expires_at) {
    throw appError('PREVIEW_EXPIRED', 'Apply preview approval has expired');
  }
  return stored.preview;
}

/** Read a pending apply preview without consuming it. */
export async function peekApplyPreview(
  home: string,
  previewId: string,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<ApplyPreview> {
  await ensurePreviewDirectory(home);
  const pending = applyPreviewRecordPath(home, previewId);
  try {
    return await readAuthenticatedPreview(home, pending, previewId, options.now);
  } catch (error) {
    if ((error as { code?: string }).code !== 'INVALID_PREVIEW') throw error;
    try {
      await fs.access(usedApplyPreviewPath(home, previewId));
      throw appError('PREVIEW_ALREADY_USED', 'Apply preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw error;
    }
  }
}

/** Atomically claim a pending apply preview for one-time apply. */
export async function claimApplyPreview(
  home: string,
  previewId: string,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<ApplyPreview> {
  await ensurePreviewDirectory(home);
  const pending = applyPreviewRecordPath(home, previewId);
  const used = usedApplyPreviewPath(home, previewId);
  try {
    await fs.rename(pending, used);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.access(used);
      throw appError('PREVIEW_ALREADY_USED', 'Apply preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw appError('INVALID_PREVIEW', 'Apply preview does not exist');
    }
  }

  return readAuthenticatedPreview(home, used, previewId, options.now);
}
