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
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999_999_999, created_at: 0 }));
    await expect(withWorkspaceLock(home, workspaceId, async () => 'recovered', {
      staleMs: 1, waitMs: 100, pollMs: 5,
    })).resolves.toBe('recovered');

    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, created_at: 0 }));
    await expect(withWorkspaceLock(home, workspaceId, async () => undefined, {
      staleMs: 1, waitMs: 20, pollMs: 5,
    })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(await fs.stat(lock)).toBeDefined();
  });
});
