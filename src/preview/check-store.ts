import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { appError } from '../domain/errors.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import type { CheckPreview } from '../verification/proposal.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const PREVIEW_ID = /^preview_[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[a-f0-9]{64}$/;
const PACKET_HASH = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ID = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKET_ID = /^packet_[0-9A-HJKMNP-TV-Z]{26}$/;
const KNOWLEDGE_ID = /^kn_[0-9A-HJKMNP-TV-Z]{26}$/;

interface ClockOptions {
  now?: number;
  ttlMs?: number;
}

interface StoredCheckPreview {
  version: 1;
  expires_at: number;
  context_head: string;
  files_hash: string;
  preview: CheckPreview;
  mac: string;
}

const sourceReferenceSchema = z.strictObject({
  agent: z.string().min(1),
  source_type: z.string().min(1),
  locator: z.string().min(1),
  content_hash: z.string().regex(PACKET_HASH),
  observed_at: z.string().min(1),
});

const knowledgeEntrySchema = z.object({
  schema_version: z.literal(1),
  id: z.string().regex(KNOWLEDGE_ID),
  kind: z.string().min(1),
  scope: z.string().min(1),
  status: z.enum(['active', 'superseded', 'archived', 'disputed']),
  applies_to: z.strictObject({
    paths: z.array(z.string()),
    agents: z.array(z.string()),
  }),
  source: sourceReferenceSchema,
  confidence: z.number(),
  supersedes: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  last_verified_at: z.string().nullable(),
  statement: z.string(),
  reason: z.string(),
});

const checkPreviewSchema = z.strictObject({
  preview_id: z.string().regex(PREVIEW_ID),
  context_head: z.string().min(1),
  workspace_id: z.string().regex(WORKSPACE_ID),
  packet_ids: z.array(z.string().regex(PACKET_ID)),
  packet_hashes: z.array(z.string().regex(PACKET_HASH)),
  changes: z.strictObject({
    creates: z.array(z.strictObject({
      entry: knowledgeEntrySchema,
      path: z.string().min(1),
      bytes: z.string(),
    })),
    updates: z.array(z.strictObject({
      entry: knowledgeEntrySchema,
      path: z.string().min(1),
      bytes: z.string(),
    })),
    supersede: z.array(z.strictObject({
      old_id: z.string().regex(KNOWLEDGE_ID),
      entry: knowledgeEntrySchema,
      path: z.string().min(1),
      bytes: z.string(),
    })),
    archive: z.array(z.strictObject({
      id: z.string().regex(KNOWLEDGE_ID),
      reason: z.string().min(1),
    })),
  }),
  warnings: z.array(z.string()),
});

const storedCheckPreviewSchema = z.strictObject({
  version: z.literal(1),
  expires_at: z.number().finite(),
  context_head: z.string().min(1),
  files_hash: z.string().regex(HASH),
  preview: checkPreviewSchema,
  mac: z.string().regex(HASH),
});

function assertPreviewId(previewId: string): void {
  if (!PREVIEW_ID.test(previewId)) throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
}

function previewsDirectory(home: string): string {
  return path.resolve(home, 'check-previews');
}

/** Absolute path for a pending check preview record. */
export function checkPreviewRecordPath(home: string, previewId: string): string {
  assertPreviewId(previewId);
  return path.join(previewsDirectory(home), `${previewId}.json`);
}

function usedCheckPreviewPath(home: string, previewId: string): string {
  assertPreviewId(previewId);
  return path.join(previewsDirectory(home), `${previewId}.used`);
}

function keyPath(home: string): string {
  return path.resolve(home, 'check-preview-auth.key');
}

function filesHash(preview: CheckPreview): string {
  const payload = [
    ...preview.changes.creates.map((item) => `create:${item.path}\n${item.bytes}`),
    ...preview.changes.updates.map((item) => `update:${item.path}\n${item.bytes}`),
    ...preview.changes.supersede.map((item) => `supersede:${item.old_id}:${item.path}\n${item.bytes}`),
    ...preview.changes.archive.map((item) => `archive:${item.id}:${item.reason}`),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function authenticatedBytes(
  expiresAt: number,
  contextHead: string,
  filesDigest: string,
  preview: CheckPreview,
): string {
  return JSON.stringify({
    version: 1,
    expires_at: expiresAt,
    context_head: contextHead,
    files_hash: filesDigest,
    preview,
  });
}

function macFor(
  key: Buffer,
  expiresAt: number,
  contextHead: string,
  filesDigest: string,
  preview: CheckPreview,
): string {
  return createHmac('sha256', key)
    .update(authenticatedBytes(expiresAt, contextHead, filesDigest, preview))
    .digest('hex');
}

async function readValidatedKey(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw appError('INVALID_PREVIEW', 'Check preview authentication key is invalid');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw appError('INVALID_PREVIEW', 'Check preview authentication key is invalid');
    }
    const encoded = await handle.readFile('utf8');
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== 32 || key.toString('base64') !== encoded) {
      throw appError('INVALID_PREVIEW', 'Check preview authentication key is invalid');
    }
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PREVIEW') throw error;
    throw appError('INVALID_PREVIEW', 'Check preview authentication key is invalid');
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
    throw appError('INVALID_PREVIEW', 'Check preview directory is invalid');
  }
}

/** Persist a check preview under the local home with mode 0o600 and a 24h TTL. */
export async function saveCheckPreview(
  home: string,
  preview: CheckPreview,
  options: ClockOptions = {},
): Promise<void> {
  assertPreviewId(preview.preview_id);
  await ensurePreviewDirectory(home);
  const now = options.now ?? Date.now();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_TTL_MS);
  const key = await previewKey(home);
  const digest = filesHash(preview);
  const stored: StoredCheckPreview = {
    version: 1,
    expires_at: expiresAt,
    context_head: preview.context_head,
    files_hash: digest,
    preview,
    mac: macFor(key, expiresAt, preview.context_head, digest, preview),
  };
  await atomicWriteFile(checkPreviewRecordPath(home, preview.preview_id), JSON.stringify(stored));
}

async function readAuthenticatedPreview(
  home: string,
  file: string,
  previewId: string,
  now = Date.now(),
): Promise<CheckPreview> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw appError('INVALID_PREVIEW', 'Stored check preview is invalid');
  }
  const validated = storedCheckPreviewSchema.safeParse(parsed);
  if (!validated.success) throw appError('INVALID_PREVIEW', 'Stored check preview is invalid');
  // Authenticate the raw JSON object so MAC matches save-time field order.
  const stored = parsed as StoredCheckPreview;
  const key = await previewKey(home);
  const expected = Buffer.from(
    macFor(key, stored.expires_at, stored.context_head, stored.files_hash, stored.preview),
    'hex',
  );
  const actual = typeof stored.mac === 'string' ? Buffer.from(stored.mac, 'hex') : Buffer.alloc(0);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw appError('INVALID_PREVIEW', 'Stored check preview authentication failed');
  }
  const digest = filesHash(stored.preview);
  if (
    stored.files_hash !== digest
    || stored.context_head !== stored.preview.context_head
    || stored.preview.preview_id !== previewId
  ) {
    throw appError('INVALID_PREVIEW', 'Stored check preview state hashes do not match');
  }
  if (now > stored.expires_at) {
    throw appError('PREVIEW_EXPIRED', 'Check preview approval has expired');
  }
  return stored.preview;
}

/** Read a pending check preview without consuming it. */
export async function peekCheckPreview(
  home: string,
  previewId: string,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<CheckPreview> {
  await ensurePreviewDirectory(home);
  const pending = checkPreviewRecordPath(home, previewId);
  try {
    return await readAuthenticatedPreview(home, pending, previewId, options.now);
  } catch (error) {
    if ((error as { code?: string }).code !== 'INVALID_PREVIEW') throw error;
    try {
      await fs.access(usedCheckPreviewPath(home, previewId));
      throw appError('PREVIEW_ALREADY_USED', 'Check preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw error;
    }
  }
}

/** Atomically claim a pending check preview for one-time apply. */
export async function claimCheckPreview(
  home: string,
  previewId: string,
  options: Pick<ClockOptions, 'now'> = {},
): Promise<CheckPreview> {
  await ensurePreviewDirectory(home);
  const pending = checkPreviewRecordPath(home, previewId);
  const used = usedCheckPreviewPath(home, previewId);
  try {
    await fs.rename(pending, used);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await fs.access(used);
      throw appError('PREVIEW_ALREADY_USED', 'Check preview has already been applied');
    } catch (usedError) {
      if ((usedError as { code?: string }).code === 'PREVIEW_ALREADY_USED') throw usedError;
      throw appError('INVALID_PREVIEW', 'Check preview does not exist');
    }
  }

  return readAuthenticatedPreview(home, used, previewId, options.now);
}
