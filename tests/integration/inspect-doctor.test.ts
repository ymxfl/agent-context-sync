import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adapterFor, type AdapterRegistry } from '../../src/adapters/registry.js';
import { doctor } from '../../src/commands/doctor.js';
import { inspect } from '../../src/commands/inspect.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import { readLocalWorkspace, writeLocalWorkspace } from '../../src/workspace/local-registry.js';
import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';

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

async function startGitDaemon(root: string): Promise<{ process: ChildProcess; remote: string }> {
  const repository = await createBareRemote(path.join(root, 'platform-context.git'));
  const port = await availablePort();
  const child = spawn('git', [
    'daemon', '--reuseaddr', '--export-all', '--enable=receive-pack',
    '--listen=127.0.0.1', `--port=${port}`, `--base-path=${root}`, root,
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

describe('inspect and doctor', () => {
  let root: string;
  let daemon: ChildProcess;
  let home: string;
  let agentHome: string;
  let repository: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-inspect-doctor-'));
    const started = await startGitDaemon(root);
    daemon = started.process;
    home = path.join(root, 'acs-home');
    agentHome = path.join(root, 'agent-home');
    repository = path.join(root, 'business', 'api');
    await fs.mkdir(agentHome, { recursive: true });
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    await fs.writeFile(path.join(repository, 'AGENTS.md'), '# API instructions\n');
    await fs.writeFile(path.join(repository, 'CLAUDE.md'), '# API instructions\n');
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote: started.remote,
      scanRoot: path.dirname(repository),
      maxDepth: 1,
      home,
    });
    const result = await applyInit(preview.preview_id, home);
    workspaceId = result.workspace.workspace_id;
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns one deterministic read-only coverage report per requested repository', async () => {
    const before = {
      status: await fixtureGit(repository, ['status', '--porcelain=v1']),
      head: await fixtureGit(repository, ['rev-parse', 'HEAD']),
      agents: await fs.readFile(path.join(repository, 'AGENTS.md')),
      claude: await fs.readFile(path.join(repository, 'CLAUDE.md')),
    };

    const first = await inspect({ workspaceId, agent: 'codex', home, homeDir: agentHome });
    const second = await inspect({ workspaceId, agent: 'codex', home, homeDir: agentHome });

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      repo_id: 'github.com/acme/api',
      report: { agent: 'codex' },
    });
    expect(first[0]?.report.sources.length).toBeGreaterThan(0);
    expect(await fixtureGit(repository, ['status', '--porcelain=v1'])).toBe(before.status);
    expect(await fixtureGit(repository, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(await fs.readFile(path.join(repository, 'AGENTS.md'))).toEqual(before.agents);
    expect(await fs.readFile(path.join(repository, 'CLAUDE.md'))).toEqual(before.claude);
  });

  it('uses a canonical contained cwd for nested Agent discovery', async () => {
    const nested = path.join(repository, 'packages/api');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'AGENTS.override.md'), '# Nested API\n');

    const [result] = await inspect({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
      repositories: ['github.com/acme/api'],
      cwd: nested,
    });

    expect(result?.repo_id).toBe('github.com/acme/api');
    expect(result?.report.loadPlan.map((item) => item.locator))
      .toContain(await fs.realpath(path.join(nested, 'AGENTS.override.md')));
  });

  it('refuses to inspect a binding whose current remote identity drifted', async () => {
    await fixtureGit(repository, ['remote', 'set-url', 'origin', 'https://github.com/other/api.git']);
    await expect(inspect({ workspaceId, agent: 'codex', home, homeDir: agentHome }))
      .rejects.toMatchObject({ code: 'REPOSITORY_ID_DRIFT' });
  });

  it('reports the fixed diagnostic set without writing', async () => {
    const beforeHead = await fixtureGit(repository, ['rev-parse', 'HEAD']);

    const report = await doctor({ workspaceId, home, homeDir: agentHome });

    expect(report.workspace_id).toBe(workspaceId);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node-version', status: 'pass' }),
      expect.objectContaining({ id: 'git-availability', status: 'pass' }),
      expect.objectContaining({ id: 'context-git', status: 'pass' }),
      expect.objectContaining({ id: 'registry-validity', status: 'pass' }),
      expect.objectContaining({ id: 'repository-path-drift', status: 'pass' }),
      expect.objectContaining({ id: 'adapter-version-support', status: 'pass' }),
      expect.objectContaining({ id: 'permissions', status: 'pass' }),
      expect.objectContaining({ id: 'adapter-coverage' }),
    ]));
    expect(report.checks.map((check) => check.id)).toHaveLength(8);
    expect(await fixtureGit(repository, ['rev-parse', 'HEAD'])).toBe(beforeHead);
  });

  it('does not report Adapter coverage as complete with zero local bindings', async () => {
    const local = await readLocalWorkspace(home, workspaceId);
    await writeLocalWorkspace(home, { ...local, repository_paths: {} });

    const report = await doctor({ workspaceId, home, homeDir: agentHome });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'adapter-coverage',
      status: 'warn',
      detail: 'No local repositories were available for Adapter coverage discovery.',
    }));
  });

  it('fails Adapter contract support when registered metadata is unsupported', async () => {
    const adapterRegistry = {
      adapterFor,
      contracts: () => [
        { agent: 'claude-code', contractVersion: 1, coverageVersion: 1, supported: true },
        { agent: 'codex', contractVersion: 1, coverageVersion: 1, supported: false },
      ] as const,
    } satisfies AdapterRegistry;

    const report = await doctor({
      workspaceId,
      home,
      homeDir: agentHome,
      adapterRegistry,
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'adapter-version-support',
      status: 'fail',
      detail: 'One or more Adapter contracts do not support coverage contract version 1.',
    }));
  });

  it('warns when registered Adapter contract metadata is missing', async () => {
    const adapterRegistry = {
      adapterFor,
      contracts: () => [
        { agent: 'codex', contractVersion: 1, coverageVersion: 1, supported: true },
      ] as const,
    } satisfies AdapterRegistry;

    const report = await doctor({
      workspaceId,
      home,
      homeDir: agentHome,
      adapterRegistry,
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'adapter-version-support',
      status: 'warn',
      detail: 'Adapter contract metadata is incomplete for Claude Code and Codex.',
    }));
  });
});
