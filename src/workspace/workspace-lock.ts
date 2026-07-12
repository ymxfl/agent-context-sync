import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { appError } from '../domain/errors.js';
import { parseWorkspaceId } from '../schema/workspace.js';

interface LockOptions {
  staleMs?: number;
  waitMs?: number;
  pollMs?: number;
  ownerWriter?: (file: string, contents: string) => Promise<void>;
}

interface LockOwner { pid: number; created_at: number; token: string }

export function workspaceLockPath(home: string, workspaceId: string): string {
  return path.resolve(home, 'locks', `${parseWorkspaceId(workspaceId)}.lock`);
}

function processIsLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ownerAt(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')) as LockOwner;
  } catch {
    return undefined;
  }
}

async function recoverIfStale(lock: string, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw appError('INVALID_WORKSPACE_LOCK', 'Workspace lock directory is invalid');
  }
  const owner = await ownerAt(lock);
  const createdAt = typeof owner?.created_at === 'number' ? owner.created_at : stat.mtimeMs;
  if (Date.now() - createdAt <= staleMs || processIsLive(owner?.pid ?? 0)) return false;
  const recovered = `${lock}.stale-${randomUUID()}`;
  try {
    await fs.rename(lock, recovered);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  await fs.rm(recovered, { recursive: true, force: true });
  return true;
}

export async function withWorkspaceLock<T>(
  home: string,
  workspaceId: string,
  action: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lock = workspaceLockPath(home, workspaceId);
  const waitMs = options.waitMs ?? 30_000;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + waitMs;
  const owner: LockOwner = { pid: process.pid, created_at: Date.now(), token: randomUUID() };
  const lockRoot = path.dirname(lock);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  let createdLockRoot = false;
  try {
    await fs.mkdir(lockRoot, { mode: 0o700 });
    createdLockRoot = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (createdLockRoot) await fs.chmod(lockRoot, 0o700);
  const lockRootInfo = await fs.lstat(lockRoot).catch(() => undefined);
  if (
    lockRootInfo === undefined
    || !lockRootInfo.isDirectory()
    || lockRootInfo.isSymbolicLink()
    || (lockRootInfo.mode & 0o777) !== 0o700
  ) {
    throw appError('INVALID_WORKSPACE_LOCK', 'Workspace lock directory is invalid');
  }
  const ownerWriter = options.ownerWriter ?? (async (file: string, contents: string) => {
    await fs.writeFile(file, contents, { mode: 0o600, flag: 'wx' });
  });

  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.chmod(lock, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await recoverIfStale(lock, staleMs);
      if (Date.now() >= deadline) {
        throw appError('WORKSPACE_BUSY', 'Another apply operation holds the Workspace lock', {
          workspace_id: workspaceId,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }

    const marker = path.join(lock, `.owner-${owner.token}.pending`);
    try {
      await fs.writeFile(marker, owner.token, { mode: 0o600, flag: 'wx' });
      await ownerWriter(path.join(lock, 'owner.json'), JSON.stringify(owner));
      await fs.unlink(marker);
      break;
    } catch (error) {
      try {
        if (await fs.readFile(marker, 'utf8') === owner.token) {
          await fs.rm(lock, { recursive: true, force: true });
        }
      } catch {
        // A missing ownership marker means this path no longer belongs to us.
      }
      throw error;
    }
  }

  try {
    return await action();
  } finally {
    const current = await ownerAt(lock);
    if (current?.token === owner.token) await fs.rm(lock, { recursive: true, force: true });
  }
}
