import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cloneContext,
  readWorkspaceManifest,
  repositoryManifestFile,
  UNBORN_HEAD,
  type WorkspacePreview,
} from '../../src/workspace/context-repository.js';
import {
  addRepository,
  applyAddRepository as applyAddRepositoryById,
} from '../../src/commands/add-repo.js';
import { applyInit as applyInitById, initWorkspace } from '../../src/commands/init.js';
import { applyJoin as applyJoinById, joinWorkspace } from '../../src/commands/join.js';
import { parseWorkspaceManifest } from '../../src/schema/workspace.js';
import {
  readLocalWorkspace,
  registryPath,
  writeLocalWorkspace,
} from '../../src/workspace/local-registry.js';
import { pathExists } from '../helpers/fs.js';
import {
  createBareRemote,
  fixtureGit,
  initFixtureRepository,
} from '../helpers/git.js';

function previewHome(preview: WorkspacePreview): string {
  return preview.normalized_input.home;
}

function applyInit(preview: WorkspacePreview) {
  return applyInitById(preview.preview_id, previewHome(preview));
}

function applyJoin(preview: WorkspacePreview) {
  return applyJoinById(preview.preview_id, previewHome(preview));
}

function applyAddRepository(preview: WorkspacePreview) {
  return applyAddRepositoryById(preview.preview_id, previewHome(preview));
}

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

  it('allows only one concurrent init application of an approved preview', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const preview = await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    });

    const results = await Promise.allSettled([applyInit(preview), applyInit(preview)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'PREVIEW_ALREADY_USED' },
    });
  });

  it('reports duplicate clone candidates without silently selecting a binding', async () => {
    const scanRoot = path.join(root, 'business');
    const first = path.join(scanRoot, 'first-local-name');
    const second = path.join(scanRoot, 'second-local-name');
    const home = path.join(root, 'member-a');
    await initFixtureRepository(first, 'https://github.com/acme/api.git');
    await initFixtureRepository(second, 'git@github.com:acme/api.git');

    const preview = await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    });

    expect(preview.repositories).toHaveLength(1);
    expect(preview.repositories[0]).toMatchObject({
      repo_id: 'github.com/acme/api',
      name: 'api',
      candidate_paths: [await fs.realpath(first), await fs.realpath(second)],
    });
    expect(preview.repositories[0]?.local_path).toBeUndefined();
    expect(preview.warnings.join('\n')).toMatch(/ambiguous.*explicit binding/i);

    await expect(applyInit(preview)).rejects.toMatchObject({
      code: 'AMBIGUOUS_BINDING',
      details: {
        repo_id: 'github.com/acme/api',
        candidate_paths: [await fs.realpath(first), await fs.realpath(second)],
      },
    });

    const bound = await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
      bindings: { 'github.com/acme/api': second },
    });
    expect(bound.repositories[0]?.local_path).toBe(await fs.realpath(second));
    const result = await applyInit(bound);
    expect(result.local.repository_paths).toEqual({
      'github.com/acme/api': await fs.realpath(second),
    });
  });

  it('rejects repository identity drift before applying init', async () => {
    const scanRoot = path.join(root, 'business');
    const repository = path.join(scanRoot, 'api');
    const home = path.join(root, 'member-a');
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    const preview = await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    });
    await fixtureGit(repository, ['remote', 'set-url', 'origin', 'https://github.com/evil/api.git']);

    await expect(applyInit(preview)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await pathExists(path.join(home, 'contexts', preview.workspace_id))).toBe(false);
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

  it('applies only authenticated locally stored preview data, not a caller payload', async () => {
    const scanRoot = path.join(root, 'business');
    const repository = path.join(scanRoot, 'api');
    const home = path.join(root, 'member-a');
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home,
    });
    preview.workspace_id = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    (preview.normalized_input as { name: string }).name = 'attacker-name';
    const result = await applyInitById(preview.preview_id, home);
    expect(result.workspace.name).toBe('platform');
    expect(result.workspace.workspace_id).not.toBe(preview.workspace_id);
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

  it('leaves no persistent init state when a concurrent initializer wins', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home,
    });
    const rival = path.join(root, 'rival-init-push');
    await fixtureGit(root, ['clone', contextRemote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'workspace.yaml'), stringify({
      schema_version: 1,
      workspace_id: preview.workspace_id,
      name: 'platform',
      context_remote: contextRemote,
      repositories: [],
    }));
    await fixtureGit(rival, ['add', 'workspace.yaml']);
    await fixtureGit(rival, ['commit', '-m', 'Concurrent initialization']);
    const rivalHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);
    await fixtureGit(rival, ['push', 'origin', 'HEAD:refs/race/next']);
    await fs.writeFile(path.join(root, 'advance-main-on-next-push'), rivalHead);

    await expect(applyInit(preview)).rejects.toThrow();
    expect(await pathExists(path.join(home, 'contexts', preview.workspace_id))).toBe(false);
    expect(await pathExists(registryPath(home, preview.workspace_id))).toBe(false);
    expect((await fs.readdir(home)).some((name) => name.startsWith('.acs-'))).toBe(false);

    const retry = await joinWorkspace({
      contextRemote,
      scanRoots: [scanRoot],
      maxDepth: 1,
      home,
    });
    const joined = await applyJoin(retry);
    expect(joined.workspace.workspace_id).toBe(preview.workspace_id);
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

  it('rejects repository identity drift before applying join', async () => {
    const memberAHome = path.join(root, 'member-a');
    const memberAScan = path.join(root, 'member-a-business');
    await initFixtureRepository(path.join(memberAScan, 'api'), 'https://github.com/acme/api.git');
    await applyInit(await initWorkspace({
      name: 'platform', contextRemote, scanRoot: memberAScan, maxDepth: 1, home: memberAHome,
    }));

    const memberBHome = path.join(root, 'member-b');
    const localApi = path.join(root, 'member-b-business', 'api');
    await initFixtureRepository(localApi, 'git@github.com:acme/api.git');
    const preview = await joinWorkspace({
      contextRemote, scanRoots: [path.dirname(localApi)], maxDepth: 1, home: memberBHome,
    });
    await fixtureGit(localApi, ['remote', 'set-url', 'origin', 'https://github.com/other/api.git']);

    await expect(applyJoin(preview)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await pathExists(path.join(memberBHome, 'contexts', preview.workspace_id))).toBe(false);
  });

  it('allows only one concurrent join application of an approved preview', async () => {
    const memberAHome = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    await applyInit(await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home: memberAHome,
    }));
    const memberBHome = path.join(root, 'member-b');
    const preview = await joinWorkspace({
      contextRemote, scanRoots: [scanRoot], maxDepth: 1, home: memberBHome,
    });

    const results = await Promise.allSettled([applyJoin(preview), applyJoin(preview)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'PREVIEW_ALREADY_USED' },
    });
  });

  it('rejects a raw local path as a join Context remote', async () => {
    const home = path.join(root, 'member-b');

    await expect(joinWorkspace({
      contextRemote: bareRemote,
      scanRoots: [],
      maxDepth: 1,
      home,
    })).rejects.toThrow(/shared remote|unsupported git remote/i);
    expect(await pathExists(path.join(home, 'contexts'))).toBe(false);
  });

  it('rejects a clone whose born Context HEAD differs from the precheck', async () => {
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const initialized = await applyInit(await initWorkspace({
      name: 'platform',
      contextRemote,
      scanRoot,
      maxDepth: 1,
      home: path.join(root, 'member-a'),
    }));
    const expectedHead = initialized.commit!;
    const rival = path.join(root, 'rival-born');
    await fixtureGit(root, ['clone', contextRemote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'advance\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Advance Context']);
    await fixtureGit(rival, ['push', 'origin', 'main']);

    await expect(cloneContext(
      contextRemote,
      path.join(root, 'stale-born-clone'),
      expectedHead,
    )).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  });

  it('rejects a clone that becomes born after an unborn precheck', async () => {
    const rival = path.join(root, 'rival-unborn');
    await fixtureGit(root, ['clone', contextRemote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'advance\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Advance empty Context']);
    await fixtureGit(rival, ['push', 'origin', 'main']);

    await expect(cloneContext(
      contextRemote,
      path.join(root, 'stale-unborn-clone'),
      UNBORN_HEAD,
    )).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  });

  it('rejects traversal-bearing repository manifest paths before filesystem use', () => {
    expect(() => repositoryManifestFile('github.com/acme/../../../outside'))
      .toThrow(/outside/i);
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

  it('rejects repository identity drift before applying add-repo', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const initialized = await applyInit(await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    }));
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');
    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });
    await fixtureGit(external, ['remote', 'set-url', 'origin', 'https://github.com/other/worker.git']);

    await expect(applyAddRepository(preview)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect((await readWorkspaceManifest(initialized.local.context_path)).repositories).toEqual([]);
  });

  it('rejects a same-HEAD Context mirror retarget before add-repo push or install', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const initialized = await applyInit(await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    }));
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');
    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });

    const mirrorBare = await createBareRemote(path.join(root, 'mirror-context.git'));
    const mirrorRemote = contextRemote.replace('platform-context.git', 'mirror-context.git');
    await fixtureGit(initialized.local.context_path, ['push', mirrorRemote, 'HEAD:main']);
    const mirrorHead = await fixtureGit(mirrorBare, ['rev-parse', 'main']);
    expect(mirrorHead).toBe(preview.context_head);

    const contextPath = initialized.local.context_path;
    const manifestPath = path.join(contextPath, 'workspace.yaml');
    const retargeted = { ...initialized.workspace, context_remote: mirrorRemote };
    await fs.writeFile(manifestPath, stringify(retargeted));
    const beforeHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    const beforeManifest = await fs.readFile(manifestPath);

    await expect(applyAddRepository(preview)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await fixtureGit(mirrorBare, ['rev-parse', 'main'])).toBe(mirrorHead);
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await fs.readFile(manifestPath)).toEqual(beforeManifest);
    expect((await readLocalWorkspace(home, initialized.workspace.workspace_id)).repository_paths)
      .not.toHaveProperty('github.com/acme/worker');
  });

  it('allows only one concurrent add-repo application of an approved preview', async () => {
    const home = path.join(root, 'member-a');
    const scanRoot = path.join(root, 'business');
    await fs.mkdir(scanRoot, { recursive: true });
    const initialized = await applyInit(await initWorkspace({
      name: 'platform', contextRemote, scanRoot, maxDepth: 1, home,
    }));
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');
    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });

    const results = await Promise.allSettled([
      applyAddRepository(preview),
      applyAddRepository(preview),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'PREVIEW_ALREADY_USED' },
    });
  });

  it('leaves persistent state unchanged on a concurrent add push and permits retry', async () => {
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
    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });
    const contextPath = initialized.local.context_path;
    const registryFile = registryPath(home, initialized.workspace.workspace_id);
    const beforeHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    const beforeManifest = await fs.readFile(path.join(contextPath, 'workspace.yaml'));
    const beforeRegistry = await fs.readFile(registryFile);

    const rival = path.join(root, 'rival-push');
    await fixtureGit(root, ['clone', contextRemote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'concurrent\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Concurrent Context change']);
    const rivalHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);
    await fixtureGit(rival, ['push', 'origin', 'HEAD:refs/race/next']);
    await fs.writeFile(path.join(root, 'advance-main-on-next-push'), rivalHead);

    await expect(applyAddRepository(preview)).rejects.toThrow();
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await fs.readFile(path.join(contextPath, 'workspace.yaml'))).toEqual(beforeManifest);
    expect(await fs.readFile(registryFile)).toEqual(beforeRegistry);
    expect((await fs.readdir(home)).some((name) => name.startsWith('.acs-'))).toBe(false);

    const retry = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });
    const result = await applyAddRepository(retry);
    expect(result.workspace.repositories.map((repository) => repository.repo_id))
      .toContain('github.com/acme/worker');
  });

  it('rejects a tracked repository-directory symlink without writing outside Context', async ({
    skip,
  }) => {
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
    const victim = path.join(root, 'victim');
    await fs.mkdir(victim);
    const sentinel = path.join(victim, 'sentinel.txt');
    await fs.writeFile(sentinel, 'unchanged\n');
    const attacker = path.join(root, 'attacker-context');
    await fixtureGit(root, ['clone', contextRemote, attacker]);
    await fs.mkdir(path.join(attacker, 'repositories'));
    try {
      await fs.symlink(victim, path.join(attacker, 'repositories', 'github.com'), 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }
    await fixtureGit(attacker, ['add', 'repositories/github.com']);
    await fixtureGit(attacker, ['commit', '-m', 'Add malicious repository symlink']);
    await fixtureGit(attacker, ['push', 'origin', 'main']);
    const persistentHead = await fixtureGit(
      initialized.local.context_path,
      ['rev-parse', 'HEAD'],
    );
    const registryFile = registryPath(home, initialized.workspace.workspace_id);
    const registryBefore = await fs.readFile(registryFile);
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');
    const preview = await addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    });

    await expect(applyAddRepository(preview)).rejects.toThrow(/symbolic|symlink/i);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('unchanged\n');
    expect(await pathExists(path.join(victim, 'acme', 'worker.yaml'))).toBe(false);
    expect(await fixtureGit(initialized.local.context_path, ['rev-parse', 'HEAD']))
      .toBe(persistentHead);
    expect(await fs.readFile(registryFile)).toEqual(registryBefore);
  });

  it('rejects a registry Context path that points at a business repository', async () => {
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
    const victim = path.join(root, 'business-victim');
    await initFixtureRepository(victim, 'https://github.com/acme/victim.git');
    await fs.writeFile(path.join(victim, 'workspace.yaml'), stringify(initialized.workspace));
    await fixtureGit(victim, ['add', 'workspace.yaml']);
    await fixtureGit(victim, ['commit', '-m', 'Business content']);
    const victimLog = await fixtureGit(victim, ['log', '--format=%H']);
    const victimManifest = await fs.readFile(path.join(victim, 'workspace.yaml'));
    await writeLocalWorkspace(home, {
      ...initialized.local,
      context_path: await fs.realpath(victim),
    });
    const external = path.join(root, 'outside', 'worker');
    await initFixtureRepository(external, 'https://github.com/acme/worker.git');

    await expect(addRepository({
      workspaceId: initialized.workspace.workspace_id,
      repositoryPath: external,
      home,
    })).rejects.toThrow(/context path/i);
    expect(await fixtureGit(victim, ['log', '--format=%H'])).toBe(victimLog);
    expect(await fs.readFile(path.join(victim, 'workspace.yaml'))).toEqual(victimManifest);
    expect(await fixtureGit(victim, ['status', '--porcelain=v1'])).toBe('');
  });
});
