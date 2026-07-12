import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';
import { invoke } from '../helpers/invoke.js';

it('documents the exact Skill approval workflow and v0.1 boundaries', async () => {
  const skill = await fs.readFile(
    path.resolve('skill/agent-context-sync/SKILL.md'),
    'utf8',
  );
  const readme = await fs.readFile(path.resolve('README.md'), 'utf8');

  expect(skill).toContain('Ask exactly one approval question at a time.');
  expect(skill).toContain('Never interpret `unknown` coverage as complete.');
  expect(skill).toContain('init preview --name');
  expect(skill).toContain("init apply --preview-json '$PREVIEW_JSON'");
  expect(skill).toContain('join preview --context-remote');
  expect(skill).toContain("join apply --preview-json '$PREVIEW_JSON'");
  expect(skill).toContain('add-repo preview --workspace');
  expect(skill).toContain("add-repo apply --preview-json '$PREVIEW_JSON'");
  expect(readme).toContain('~/.codex/skills/agent-context-sync');
  expect(readme).toContain('~/.claude/skills/agent-context-sync');
  expect(readme).toContain('Claude Code and Codex');
});

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

it('delivers the v0.1 two-repository Skill workflow without business mutations', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'acs-v01-e2e-'));
  const daemon = await startGitDaemon(root);
  try {
    const memberAHome = path.join(root, 'member-a-acs');
    const memberAAgentHome = path.join(root, 'member-a-agent');
    const memberAScan = path.join(root, 'member-a-business');
    const apiA = path.join(memberAScan, 'api');
    const webA = path.join(memberAScan, 'web');
    await fs.mkdir(memberAAgentHome, { recursive: true });
    await initFixtureRepository(apiA, 'https://github.com/acme/api.git');
    await initFixtureRepository(webA, 'https://github.com/acme/web.git');
    await fs.writeFile(path.join(apiA, 'AGENTS.md'), '# API Codex\n');
    await fs.writeFile(path.join(apiA, 'CLAUDE.md'), '# API Claude\n');
    await fs.writeFile(path.join(webA, 'AGENTS.md'), '# Web Codex\n');
    await fs.writeFile(path.join(webA, 'CLAUDE.md'), '# Web Claude\n');
    const beforeA = await Promise.all([apiA, webA].map(async (repository) => ({
      head: await fixtureGit(repository, ['rev-parse', 'HEAD']),
      status: await fixtureGit(repository, ['status', '--porcelain=v1']),
      agents: await fs.readFile(path.join(repository, 'AGENTS.md')),
      claude: await fs.readFile(path.join(repository, 'CLAUDE.md')),
    })));
    const memberAEnv = {
      AGENT_CONTEXT_SYNC_HOME: memberAHome,
      HOME: memberAAgentHome,
      CODEX_HOME: path.join(memberAAgentHome, '.codex'),
    };
    const initPreview = await invoke([
      'init', 'preview', '--name', 'platform', '--context-remote', daemon.remote,
      '--scan-root', memberAScan, '--max-depth', '1',
    ], memberAEnv);
    expect(initPreview.exitCode).toBe(0);
    expect(initPreview.json.data.preview.repositories).toHaveLength(2);
    const initResult = await invoke([
      'init', 'apply', '--preview-json', JSON.stringify(initPreview.json.data.preview),
    ], memberAEnv);
    expect(initResult.exitCode).toBe(0);
    const workspaceId = initResult.json.data.result.workspace.workspace_id as string;

    const memberBHome = path.join(root, 'member-b-acs');
    const memberBAgentHome = path.join(root, 'member-b-agent');
    const memberBScan = path.join(root, 'member-b-business');
    const apiB = path.join(memberBScan, 'api');
    await fs.mkdir(memberBAgentHome, { recursive: true });
    await initFixtureRepository(apiB, 'git@github.com:acme/api.git');
    await fs.writeFile(path.join(apiB, 'AGENTS.md'), '# Joined API Codex\n');
    await fs.writeFile(path.join(apiB, 'CLAUDE.md'), '# Joined API Claude\n');
    const beforeB = {
      head: await fixtureGit(apiB, ['rev-parse', 'HEAD']),
      status: await fixtureGit(apiB, ['status', '--porcelain=v1']),
      agents: await fs.readFile(path.join(apiB, 'AGENTS.md')),
      claude: await fs.readFile(path.join(apiB, 'CLAUDE.md')),
    };
    const memberBEnv = {
      AGENT_CONTEXT_SYNC_HOME: memberBHome,
      HOME: memberBAgentHome,
      CODEX_HOME: path.join(memberBAgentHome, '.codex'),
    };
    const joinPreview = await invoke([
      'join', 'preview', '--context-remote', daemon.remote,
      '--scan-root', memberBScan, '--max-depth', '1',
    ], memberBEnv);
    expect(joinPreview.exitCode).toBe(0);
    expect(joinPreview.json.data.preview.repositories).toHaveLength(2);
    expect(joinPreview.json.data.preview.repositories.filter(
      (repository: { local_path?: string }) => repository.local_path !== undefined,
    )).toHaveLength(1);
    const joinResult = await invoke([
      'join', 'apply', '--preview-json', JSON.stringify(joinPreview.json.data.preview),
    ], memberBEnv);
    expect(joinResult.exitCode).toBe(0);

    const codex = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'codex',
    ], memberBEnv);
    expect(codex.exitCode).toBe(0);
    expect(codex.json.data.reports).toHaveLength(1);
    expect(codex.json.data.reports[0].agent).toBe('codex');
    expect(codex.json.data.reports[0].sources.length).toBeGreaterThan(0);
    const claude = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'claude-code',
    ], memberBEnv);
    expect(claude.exitCode).toBe(0);
    expect(claude.json.data.reports[0].agent).toBe('claude-code');
    expect(claude.json.data.reports[0].sources.length).toBeGreaterThan(0);

    const diagnosis = await invoke(['doctor', '--workspace', workspaceId], memberBEnv);
    expect(diagnosis.exitCode).toBe(0);
    expect(diagnosis.json.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node-version', status: 'pass' }),
      expect.objectContaining({ id: 'context-git', status: 'pass' }),
      expect.objectContaining({ id: 'adapter-coverage' }),
    ]));

    expect(await Promise.all([apiA, webA].map(async (repository) => ({
      head: await fixtureGit(repository, ['rev-parse', 'HEAD']),
      status: await fixtureGit(repository, ['status', '--porcelain=v1']),
      agents: await fs.readFile(path.join(repository, 'AGENTS.md')),
      claude: await fs.readFile(path.join(repository, 'CLAUDE.md')),
    })))).toEqual(beforeA);
    expect({
      head: await fixtureGit(apiB, ['rev-parse', 'HEAD']),
      status: await fixtureGit(apiB, ['status', '--porcelain=v1']),
      agents: await fs.readFile(path.join(apiB, 'AGENTS.md')),
      claude: await fs.readFile(path.join(apiB, 'CLAUDE.md')),
    }).toEqual(beforeB);
  } finally {
    await stopProcess(daemon.process);
    await fs.rm(root, { recursive: true, force: true });
  }
});
