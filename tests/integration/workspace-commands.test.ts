import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addRepository,
  applyAddRepository,
} from '../../src/commands/add-repo.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import { applyJoin, joinWorkspace } from '../../src/commands/join.js';
import { parseWorkspaceManifest } from '../../src/schema/workspace.js';
import { readLocalWorkspace } from '../../src/workspace/local-registry.js';
import { pathExists } from '../helpers/fs.js';
import {
  createBareRemote,
  fixtureGit,
  initFixtureRepository,
} from '../helpers/git.js';

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
  const child = spawn('git', [
    'daemon',
    '--reuseaddr',
    '--export-all',
    '--enable=receive-pack',
    '--listen=127.0.0.1',
    `--port=${port}`,
    `--base-path=${root}`,
    root,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const remote = `git://127.0.0.1:${port}/${path.basename(repository)}`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `git daemon exited during setup: ${Buffer.concat(stderr).toString('utf8').trim()}`,
      );
    }
    try {
      await fixtureGit(root, ['ls-remote', remote]);
      return { process: child, remote };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  child.kill();
  throw new Error(
    `git daemon did not become reachable: ${Buffer.concat(stderr).toString('utf8').trim()}`,
  );
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

describe('workspace commands', () => {
  let root: string;
  let daemon: ChildProcess | undefined;
  let contextRemote: string;
  let bareRemote: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-workspace-commands-'));
    bareRemote = await createBareRemote(path.join(root, 'platform-context.git'));
    const started = await startGitDaemon(root, bareRemote);
    daemon = started.process;
    contextRemote = started.remote;
  });

  afterEach(async () => {
    if (daemon !== undefined) await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('previews init without writes, then creates and pushes one Context commit', async () => {
    const scanRoot = path.join(root, 'business');
    const api = path.join(scanRoot, 'api');
    const web = path.join(scanRoot, 'web');
    const home = path.join(root, 'member-a');
    await initFixtureRepository(api, 'https://github.com/acme/api.git');
    await initFixtureRepository(web, 'git@github.com:acme/web.git');
    const businessLogs = await Promise.all([
      fixtureGit(api, ['log', '--format=%H']),
      fixtureGit(web, ['log', '--format=%H']),
    ]);

    const preview = await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 2,
      home,
    });

    expect(preview.preview_id).toMatch(/^preview_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(preview.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.context_head).toBe('UNBORN');
    expect(preview.repositories).toHaveLength(2);
    expect(preview.files_to_write).toContain('workspace.yaml');
    expect(await pathExists(path.join(home, 'contexts'))).toBe(false);
    expect(await fixtureGit(root, ['ls-remote', contextRemote, 'refs/heads/main'])).toBe('');

    const result = await applyInit(preview);

    expect(result.workspace.workspace_id).toMatch(/^ws_/);
    expect(await fixtureGit(result.local.context_path, ['remote', 'get-url', 'origin']))
      .toBe(contextRemote);
    const manifest = parseWorkspaceManifest(parse(
      await fs.readFile(path.join(result.local.context_path, 'workspace.yaml'), 'utf8'),
    ));
    expect(manifest.repositories.map((repository) => repository.repo_id)).toEqual([
      'github.com/acme/api',
      'github.com/acme/web',
    ]);
    expect(await fixtureGit(bareRemote, ['rev-list', '--count', 'main'])).toBe('1');
    expect(await Promise.all([
      fixtureGit(api, ['log', '--format=%H']),
      fixtureGit(web, ['log', '--format=%H']),
    ])).toEqual(businessLogs);
  });

  it('rejects an init preview when the Context HEAD changes', async () => {
    const scanRoot = path.join(root, 'business');
    const home = path.join(root, 'member-a');
    await fs.mkdir(scanRoot, { recursive: true });
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home,
    });
    const rival = path.join(root, 'rival');
    await fixtureGit(root, ['clone', contextRemote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'rival\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Rival initialization']);
    await fixtureGit(rival, ['push', 'origin', 'main']);

    await expect(applyInit(preview)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await pathExists(path.join(home, 'contexts'))).toBe(false);
  });

  it('rejects an init preview with an invalid preview ID', async () => {
    const scanRoot = path.join(root, 'business');
    const home = path.join(root, 'member-a');
    await fs.mkdir(scanRoot, { recursive: true });
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home,
    });
    preview.preview_id = 'preview_invalid';

    await expect(applyInit(preview)).rejects.toMatchObject({
      code: 'INVALID_PREVIEW',
    });
    expect(await pathExists(path.join(home, 'contexts'))).toBe(false);
  });

  it('refuses to initialize a non-empty Context repository', async () => {
    const seed = path.join(root, 'seed');
    await fixtureGit(root, ['clone', contextRemote, seed]);
    await fixtureGit(seed, ['config', 'user.name', 'Seed']);
    await fixtureGit(seed, ['config', 'user.email', 'seed@example.invalid']);
    await fs.writeFile(path.join(seed, 'README.md'), 'already initialized\n');
    await fixtureGit(seed, ['add', 'README.md']);
    await fixtureGit(seed, ['commit', '-m', 'Seed Context']);
    await fixtureGit(seed, ['push', 'origin', 'main']);
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });

    await expect(initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home: path.join(root, 'member-a'),
    })).rejects.toMatchObject({ code: 'CONTEXT_NOT_EMPTY' });
  });

  it('joins when only one shared repository is local without changing Context Git', async () => {
    const memberAHome = path.join(root, 'member-a');
    const memberAScan = path.join(root, 'member-a-business');
    await initFixtureRepository(
      path.join(memberAScan, 'api'),
      'https://github.com/acme/api.git',
    );
    await initFixtureRepository(
      path.join(memberAScan, 'web'),
      'https://github.com/acme/web.git',
    );
    await applyInit(await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot: memberAScan,
      maxDepth: 1,
      home: memberAHome,
    }));
    const contextHead = await fixtureGit(bareRemote, ['rev-parse', 'main']);

    const memberBHome = path.join(root, 'member-b');
    const memberBScan = path.join(root, 'member-b-business');
    const localApi = path.join(memberBScan, 'api');
    await initFixtureRepository(localApi, 'git@github.com:acme/api.git');
    const preview = await joinWorkspace({
      contextRemote,
      scanRoots: [memberBScan],
      maxDepth: 1,
      home: memberBHome,
    });

    expect(preview.repositories).toHaveLength(2);
    expect(preview.repositories.find((repo) => repo.repo_id.endsWith('/api'))?.local_path)
      .toBe(await fs.realpath(localApi));
    expect(preview.repositories.find((repo) => repo.repo_id.endsWith('/web'))?.local_path)
      .toBeUndefined();
    expect(preview.warnings).toContain('Repository github.com/acme/web is not available locally');
    expect(await pathExists(path.join(memberBHome, 'contexts'))).toBe(false);

    const result = await applyJoin(preview);

    expect(result.local.repository_paths).toEqual({
      'github.com/acme/api': await fs.realpath(localApi),
    });
    expect(await readLocalWorkspace(memberBHome, result.workspace.workspace_id))
      .toEqual(result.local);
    expect(await fixtureGit(bareRemote, ['rev-parse', 'main'])).toBe(contextHead);
  });

  it('rejects a raw local path as a join Context remote', async () => {
    const home = path.join(root, 'member-b');

    await expect(joinWorkspace({
      contextRemote: bareRemote,
      scanRoots: [],
      maxDepth: 1,
      home,
    })).rejects.toThrow(/shared remote/i);
    expect(await pathExists(path.join(home, 'contexts'))).toBe(false);
  });

  it('adds an outside repository only on apply and never changes its history', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const initialized = await applyInit(await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home,
    }));
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');
    const businessLog = await fixtureGit(external, ['log', '--format=%H']);
    const manifestPath = path.join(initialized.local.context_path, 'workspace.yaml');
    const before = await fs.readFile(manifestPath);

    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });

    expect(preview.repositories.map((repository) => repository.repo_id))
      .toContain('github.com/acme/worker');
    expect(await fs.readFile(manifestPath)).toEqual(before);

    const result = await applyAddRepository(preview);

    expect(result.workspace.repositories.map((repository) => repository.repo_id))
      .toContain('github.com/acme/worker');
    expect(result.local.repository_paths['github.com/acme/worker'])
      .toBe(await fs.realpath(external));
    expect(await fixtureGit(external, ['log', '--format=%H'])).toBe(businessLog);
    expect(await fixtureGit(bareRemote, ['rev-list', '--count', 'main'])).toBe('2');
  });
});
