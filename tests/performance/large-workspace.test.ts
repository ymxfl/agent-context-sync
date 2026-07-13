import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inspect } from '../../src/commands/inspect.js';
import { doctor } from '../../src/commands/doctor.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO_COUNT = 6;

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

describe('large workspace inspect cache', () => {
  let root: string;
  let daemon: ChildProcess;
  let home: string;
  let agentHome: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-large-ws-'));
    const started = await startGitDaemon(root);
    daemon = started.process;
    home = path.join(root, 'acs-home');
    agentHome = path.join(root, 'agent-home');
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(path.join(agentHome, '.codex'), { recursive: true });
    await fs.writeFile(path.join(agentHome, '.codex', 'config.toml'), 'project_doc_max_bytes = 32768\n');

    const scanRoot = path.join(root, 'business');
    for (let index = 0; index < REPO_COUNT; index += 1) {
      const name = `svc-${index}`;
      const repository = path.join(scanRoot, name);
      await initFixtureRepository(repository, `https://github.com/acme/${name}.git`);
      await fs.writeFile(
        path.join(repository, 'AGENTS.md'),
        `# ${name}\n\nKeep ${name} diffs reviewable and prefer focused tests.\n`,
      );
      await fs.writeFile(
        path.join(repository, 'CLAUDE.md'),
        `# ${name}\n\nPrefer focused tests for ${name} before the full suite.\n`,
      );
      await fs.mkdir(path.join(repository, 'packages', 'api'), { recursive: true });
      await fs.writeFile(
        path.join(repository, 'packages', 'api', 'AGENTS.override.md'),
        `# ${name} api override\n`,
      );
      await fs.mkdir(path.join(repository, '.claude', 'rules'), { recursive: true });
      await fs.writeFile(
        path.join(repository, '.claude', 'rules', 'api.md'),
        `# ${name} rule\n`,
      );
    }

    const preview = await initWorkspace({
      name: 'platform',
      contextRemote: started.remote,
      scanRoot,
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

  it('reuses discovery cache so a second inspect reads fewer files within 30s', async () => {
    const startedAt = Date.now();

    const first = await inspect({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });
    const second = await inspect({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });

    expect(first.reports).toHaveLength(REPO_COUNT);
    expect(second.reports).toEqual(first.reports);
    expect(first.stats.files_read).toBeGreaterThan(0);
    expect(second.stats.files_read).toBeLessThan(first.stats.files_read);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it('reports cache corruption without deleting cache files', async () => {
    await inspect({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });

    const cacheDir = path.join(home, 'cache');
    const entries = await fs.readdir(cacheDir);
    expect(entries.length).toBeGreaterThan(0);
    // Use an orphan corrupt file that inspect will not overwrite during doctor coverage.
    const corruptPath = path.join(cacheDir, 'corrupt-orphan.json');
    await fs.writeFile(corruptPath, '{not-valid-cache');
    const beforeEntries = await fs.readdir(cacheDir);

    const report = await doctor({ workspaceId, home, homeDir: agentHome });
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'cache-integrity',
      status: 'warn',
    }));
    const check = report.checks.find((item) => item.id === 'cache-integrity');
    expect(check?.detail.toLowerCase()).toMatch(/corrupt|remov/);
    // doctor must report corruption without deleting cache files
    expect(await fs.readFile(corruptPath, 'utf8')).toBe('{not-valid-cache');
    expect(await fs.readdir(cacheDir)).toEqual(expect.arrayContaining(beforeEntries));
  });
});
