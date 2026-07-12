import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

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

const HASH = /^[a-f0-9]{64}$/;
const previewRepositorySchema = z.strictObject({
  schema_version: z.literal(1),
  repo_id: z.string().min(1),
  name: z.string().min(1),
  local_path: z.string().optional(),
  candidate_paths: z.array(z.string()).optional(),
  binding_hash: z.string().regex(HASH).optional(),
});
const normalizedInputSchema = z.union([
  z.strictObject({
    name: z.string(), context_remote: z.string(), scan_root: z.string(),
    max_depth: z.number().int().nonnegative(), home: z.string(),
  }),
  z.strictObject({
    context_remote: z.string(), scan_roots: z.array(z.string()),
    max_depth: z.number().int().nonnegative(), home: z.string(),
  }),
  z.strictObject({
    workspace_id: z.string(), repository_path: z.string(), home: z.string(),
    context_remote: z.string(), workspace_manifest_hash: z.string().regex(HASH),
    mode: z.enum(['add-shared', 'bind-existing']), repository_id: z.string(),
    previous_repository_path: z.string().nullable(),
  }),
]);
const workspacePreviewSchema = z.strictObject({
  operation: z.enum(['init', 'join', 'add-repository']),
  preview_id: z.string().regex(PREVIEW_ID),
  input_hash: z.string().regex(HASH),
  context_head: z.string(),
  workspace_id: z.string(),
  normalized_input: normalizedInputSchema,
  files_to_write: z.array(z.string()),
  repositories: z.array(previewRepositorySchema),
  warnings: z.array(z.string()),
}).superRefine((preview, context) => {
  const input = preview.normalized_input;
  const matchesOperation = preview.operation === 'init'
    ? 'name' in input && 'scan_root' in input
    : preview.operation === 'join'
      ? 'scan_roots' in input
      : 'repository_path' in input && 'workspace_manifest_hash' in input;
  if (!matchesOperation) {
    context.addIssue({ code: 'custom', path: ['normalized_input'], message: 'Input does not match operation' });
  }
});
const storedPreviewSchema = z.strictObject({
  version: z.literal(1),
  expires_at: z.number().finite(),
  context_state_hash: z.string().regex(HASH),
  business_state_hash: z.string().regex(HASH),
  preview: workspacePreviewSchema,
  mac: z.string().regex(HASH),
});

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

async function readValidatedKey(file: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    throw appError('INVALID_PREVIEW', 'Preview authentication key is invalid');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
      throw appError('INVALID_PREVIEW', 'Preview authentication key is invalid');
    }
    const encoded = await handle.readFile('utf8');
    const key = Buffer.from(encoded, 'base64');
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded) || key.length !== 32 || key.toString('base64') !== encoded) {
      throw appError('INVALID_PREVIEW', 'Preview authentication key is invalid');
    }
    return key;
  } catch (error) {
    if ((error as { code?: string }).code === 'INVALID_PREVIEW') throw error;
    throw appError('INVALID_PREVIEW', 'Preview authentication key is invalid');
  } finally {
    await handle.close();
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
    throw appError('INVALID_PREVIEW', 'Preview directory is invalid');
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
  await ensurePreviewDirectory(home);
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
  await ensurePreviewDirectory(home);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch {
    throw appError('INVALID_PREVIEW', 'Stored preview is invalid');
  }
  const validated = storedPreviewSchema.safeParse(parsed);
  if (!validated.success) throw appError('INVALID_PREVIEW', 'Stored preview is invalid');
  const stored = parsed as StoredPreview;
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
  await ensurePreviewDirectory(home);
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
