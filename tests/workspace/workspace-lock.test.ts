import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withWorkspaceLock, workspaceLockPath } from '../../src/workspace/workspace-lock.js';

const workspaceId = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('workspace apply lock', () => {
  let home: string;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'acs-lock-')); });
  afterEach(async () => fs.rm(home, { recursive: true, force: true }));

  it('serializes concurrent operations for one Workspace', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withWorkspaceLock(home, workspaceId, async () => {
      events.push('first-start');
      await gate;
      events.push('first-end');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withWorkspaceLock(home, workspaceId, async () => { events.push('second'); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('recovers a stale dead-owner lock but never removes a live lock', async () => {
    const lock = workspaceLockPath(home, workspaceId);
    await fs.mkdir(lock, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, created_at: 0 }));
    await expect(withWorkspaceLock(home, workspaceId, async () => 'recovered', {
      staleMs: 1, waitMs: 100, pollMs: 5,
    })).resolves.toBe('recovered');

    await fs.mkdir(lock, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: 0 }));
    await expect(withWorkspaceLock(home, workspaceId, async () => undefined, {
      staleMs: 1, waitMs: 20, pollMs: 5,
    })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(await fs.stat(lock)).toBeDefined();
  });

  it('removes a newly owned lock when owner creation fails and permits immediate reacquire', async () => {
    const injected = new Error('injected owner write failure');
    await expect(withWorkspaceLock(home, workspaceId, async () => undefined, {
      ownerWriter: async () => { throw injected; },
    })).rejects.toBe(injected);
    await expect(fs.access(workspaceLockPath(home, workspaceId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(withWorkspaceLock(home, workspaceId, async () => 'reacquired', {
      waitMs: 20,
    })).resolves.toBe('reacquired');
  });

  it('rejects permissive or symlinked lock directories', async () => {
    const locks = path.join(home, 'locks');
    await fs.mkdir(locks, { mode: 0o755 });
    await expect(withWorkspaceLock(home, workspaceId, async () => undefined))
      .rejects.toMatchObject({ code: 'INVALID_WORKSPACE_LOCK' });

    await fs.rm(locks, { recursive: true });
    const external = path.join(home, 'external-locks');
    await fs.mkdir(external, { mode: 0o700 });
    await fs.symlink(external, locks);
    await expect(withWorkspaceLock(home, workspaceId, async () => undefined))
      .rejects.toMatchObject({ code: 'INVALID_WORKSPACE_LOCK' });
    expect(await fs.readdir(external)).toEqual([]);
  });
});
