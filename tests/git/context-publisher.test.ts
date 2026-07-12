import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commitAndPushKnowledge,
  inspectContextRemoteState,
  preflightContextRemote,
} from '../../src/git/context-publisher.js';
import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a Git daemon port'));
        return;
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

async function startGitDaemon(root: string, repository: string): Promise<{
  process: ChildProcess;
  remote: string;
}> {
  const port = await availablePort();
  const raceMarker = path.join(root, 'advance-main-on-next-push');
  const accessHook = path.join(root, 'git-daemon-access-hook.mjs');
  await fs.writeFile(accessHook, `#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const marker = ${JSON.stringify(raceMarker)};
const repository = ${JSON.stringify(repository)};
if (process.argv[2] === 'receive-pack' && existsSync(marker)) {
  const commit = readFileSync(marker, 'utf8').trim();
  execFileSync('git', ['--git-dir', repository, 'update-ref', 'refs/heads/main', commit]);
  rmSync(marker);
}
`);
  await fs.chmod(accessHook, 0o700);
  const child = spawn('git', [
    'daemon',
    '--reuseaddr',
    '--export-all',
    '--enable=receive-pack',
    '--listen=127.0.0.1',
    `--port=${port}`,
    `--base-path=${root}`,
    `--access-hook=${accessHook}`,
    root,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const remote = `git://127.0.0.1:${port}/${path.basename(repository)}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fixtureGit(root, ['ls-remote', remote]);
      return { process: child, remote };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  child.kill();
  throw new Error('Git daemon did not become reachable');
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function configureIdentity(repo: string): Promise<void> {
  await fixtureGit(repo, ['config', 'user.name', 'Agent Context Sync Tests']);
  await fixtureGit(repo, ['config', 'user.email', 'tests@agent-context-sync.invalid']);
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await fixtureGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

describe('context publisher', () => {
  let root: string;
  let daemon: ChildProcess;
  let bare: string;
  let remote: string;
  let contextPath: string;

  async function remoteContains(commit: string): Promise<boolean> {
    const listing = await fixtureGit(root, ['ls-remote', remote]);
    return listing.split('\n').some((line) => line.startsWith(commit));
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-context-publisher-'));
    bare = await createBareRemote(path.join(root, 'platform-context.git'));
    const started = await startGitDaemon(root, bare);
    daemon = started.process;
    remote = started.remote;

    contextPath = path.join(root, 'context');
    await initFixtureRepository(contextPath, remote);
    await fs.writeFile(path.join(contextPath, 'workspace.yaml'), 'schema_version: 1\n');
    await fs.mkdir(path.join(contextPath, 'knowledge', 'workspace'), { recursive: true });
    await fs.writeFile(
      path.join(contextPath, 'knowledge', 'workspace', 'seed.md'),
      '# seed\n',
    );
    await fixtureGit(contextPath, ['add', 'workspace.yaml', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'Seed context']);
    await fixtureGit(contextPath, ['push', '-u', 'origin', 'main']);
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports ahead when local has unpushed commits', async () => {
    await fs.writeFile(path.join(contextPath, 'knowledge', 'workspace', 'local.md'), 'local\n');
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'Local-only knowledge']);

    const state = await inspectContextRemoteState(contextPath);
    expect(state.ahead).toBe(1);
    expect(state.behind).toBe(0);
    expect(state.diverged).toBe(false);
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
    expect(state.upstream).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fast-forwards when behind-only', async () => {
    const rival = path.join(root, 'rival');
    await fixtureGit(root, ['clone', remote, rival]);
    await configureIdentity(rival);
    await fs.writeFile(path.join(rival, 'knowledge', 'workspace', 'remote.md'), 'remote\n');
    await fixtureGit(rival, ['add', 'knowledge']);
    await fixtureGit(rival, ['commit', '-m', 'Remote knowledge']);
    await fixtureGit(rival, ['push', 'origin', 'main']);
    const remoteHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);

    const before = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    expect(before).not.toBe(remoteHead);

    const state = await preflightContextRemote(contextPath);
    expect(state.behind).toBe(0);
    expect(state.ahead).toBe(0);
    expect(state.diverged).toBe(false);
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(remoteHead);
    expect(await fs.readFile(path.join(contextPath, 'knowledge', 'workspace', 'remote.md'), 'utf8'))
      .toBe('remote\n');
  });

  it('rejects divergence without rewriting history', async () => {
    const rival = path.join(root, 'rival');
    await fixtureGit(root, ['clone', remote, rival]);
    await configureIdentity(rival);
    await fs.writeFile(path.join(rival, 'knowledge', 'workspace', 'remote.md'), 'remote\n');
    await fixtureGit(rival, ['add', 'knowledge']);
    await fixtureGit(rival, ['commit', '-m', 'Remote divergence']);
    await fixtureGit(rival, ['push', 'origin', 'main']);
    const remoteHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);

    await fs.writeFile(path.join(contextPath, 'knowledge', 'workspace', 'local.md'), 'local\n');
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'Local divergence']);
    const localHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);

    await expect(preflightContextRemote(contextPath)).rejects.toMatchObject({
      code: 'CONTEXT_DIVERGED',
    });
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(await fixtureGit(bare, ['rev-parse', 'main'])).toBe(remoteHead);
    expect(await isAncestor(contextPath, remoteHead, localHead)).toBe(false);
  });

  it('commits knowledge paths and pushes without force', async () => {
    await fs.writeFile(
      path.join(contextPath, 'knowledge', 'workspace', 'kn_01J00000000000000000000000.md'),
      '---\nschema_version: 1\nid: kn_01J00000000000000000000000\n---\n\nShip tests.\n',
    );
    await fs.mkdir(path.join(contextPath, 'sources'), { recursive: true });
    await fs.writeFile(path.join(contextPath, 'sources', 'note.txt'), 'source\n');
    await fs.mkdir(path.join(contextPath, 'schema'), { recursive: true });
    await fs.writeFile(path.join(contextPath, 'schema', 'knowledge.json'), '{}\n');

    const result = await commitAndPushKnowledge(
      contextPath,
      'Publish approved capture knowledge',
    );
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await remoteContains(result.commit)).toBe(true);
    expect(result.remote_state.ahead).toBe(0);
    expect(result.remote_state.behind).toBe(0);
    expect(result.remote_state.diverged).toBe(false);

    const tree = await fixtureGit(contextPath, ['ls-tree', '-r', '--name-only', result.commit]);
    expect(tree).toContain('knowledge/workspace/kn_01J00000000000000000000000.md');
    expect(tree).toContain('sources/note.txt');
    expect(tree).toContain('schema/knowledge.json');
  });

  it('preserves the local commit and returns REMOTE_CHANGED on push race', async () => {
    const rival = path.join(root, 'rival');
    await fixtureGit(root, ['clone', remote, rival]);
    await configureIdentity(rival);
    await fs.writeFile(path.join(rival, 'README.md'), 'race\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Rival race commit']);
    const rivalHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);
    await fixtureGit(rival, ['push', 'origin', 'HEAD:refs/race/next']);
    await fs.writeFile(path.join(root, 'advance-main-on-next-push'), rivalHead);

    await fs.writeFile(
      path.join(contextPath, 'knowledge', 'workspace', 'raced.md'),
      'raced knowledge\n',
    );
    const beforeRemote = await fixtureGit(bare, ['rev-parse', 'main']);

    await expect(commitAndPushKnowledge(
      contextPath,
      'Publish during remote race',
    )).rejects.toMatchObject({
      code: 'REMOTE_CHANGED',
      details: expect.objectContaining({
        recovery: expect.stringMatching(/fetch|re-preview|retry/i),
      }),
    });

    const localHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    expect(localHead).toMatch(/^[0-9a-f]{40}$/);
    expect(localHead).not.toBe(beforeRemote);
    expect(await isAncestor(bare, beforeRemote, rivalHead)).toBe(true);
    expect(await fixtureGit(bare, ['rev-parse', 'main'])).toBe(rivalHead);
    expect(await isAncestor(bare, localHead, rivalHead)).toBe(false);
  });
});
