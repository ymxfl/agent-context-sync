import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';
import { invoke } from '../helpers/invoke.js';

const execFileAsync = promisify(execFile);

it('documents the exact Skill approval workflow and v0.1 boundaries', async () => {
  const skill = await fs.readFile(
    path.resolve('skill/agent-context-sync/SKILL.md'),
    'utf8',
  );
  const readme = await fs.readFile(path.resolve('README.md'), 'utf8');

  expect(skill).toContain('Ask exactly one approval question at a time.');
  expect(skill).toContain('Never interpret `unknown` coverage as complete.');
  expect(skill).toContain('init preview --name');
  expect(skill).toContain('join preview --context-remote');
  expect(skill).toContain('add-repo preview --workspace');
  expect(skill).toContain('--binding repo_id=path');
  expect(readme).toContain('~/.codex/skills/agent-context-sync');
  expect(readme).toContain('~/.claude/skills/agent-context-sync');
  expect(readme).toContain('Claude Code and Codex');

  const mockSkill = await fs.mkdtemp(path.join(tmpdir(), 'acs-documented-skill-'));
  try {
    await fs.mkdir(path.join(mockSkill, 'scripts'));
    await fs.writeFile(
      path.join(mockSkill, 'scripts/acs.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const previewId = 'preview_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const applyInvocations = skill.match(/^node .* (?:init|join|add-repo) apply .*$/gm) ?? [];
    expect(applyInvocations).toHaveLength(3);
    for (const invocation of applyInvocations) {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', invocation], {
        env: { ...process.env, SKILL_DIR: mockSkill, PREVIEW_ID: previewId },
      });
      const args = JSON.parse(stdout) as string[];
      expect(args.slice(-2)).toEqual(['--preview-id', previewId]);
    }
  } finally {
    await fs.rm(mockSkill, { recursive: true, force: true });
  }
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

async function startGitDaemon(root: string): Promise<{
  process: ChildProcess;
  remote: string;
  repository: string;
}> {
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
      return { process: child, remote, repository };
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
      'init', 'apply', '--preview-id', initPreview.json.data.preview.preview_id,
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
    const nestedB = path.join(apiB, 'packages/api');
    await fs.mkdir(nestedB, { recursive: true });
    await fs.writeFile(path.join(nestedB, 'AGENTS.override.md'), '# Nested Codex\n');
    await fs.writeFile(path.join(nestedB, 'CLAUDE.md'), '# Nested Claude\n');
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
      'join', 'apply', '--preview-id', joinPreview.json.data.preview.preview_id,
    ], memberBEnv);
    expect(joinResult.exitCode).toBe(0);

    const codex = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'codex',
    ], memberBEnv);
    expect(codex.exitCode).toBe(0);
    expect(codex.json.data.reports).toHaveLength(1);
    expect(codex.json.data.reports[0].repo_id).toBe('github.com/acme/api');
    expect(codex.json.data.reports[0].report.agent).toBe('codex');
    expect(codex.json.data.reports[0].report.sources.length).toBeGreaterThan(0);
    const nestedCodex = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'codex',
      '--repository', 'github.com/acme/api', '--cwd', nestedB,
    ], memberBEnv);
    expect(nestedCodex.json.data.reports[0].report.loadPlan.map(
      (item: { locator: string }) => item.locator,
    )).toContain(await fs.realpath(path.join(nestedB, 'AGENTS.override.md')));
    const claude = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'claude-code',
    ], memberBEnv);
    expect(claude.exitCode).toBe(0);
    expect(claude.json.data.reports[0].report.agent).toBe('claude-code');
    expect(claude.json.data.reports[0].report.sources.length).toBeGreaterThan(0);
    const nestedClaude = await invoke([
      'inspect', '--workspace', workspaceId, '--agent', 'claude-code',
      '--repository', 'github.com/acme/api', '--cwd', nestedB,
    ], memberBEnv);
    expect(nestedClaude.json.data.reports[0].report.loadPlan.map(
      (item: { locator: string }) => item.locator,
    )).toContain(await fs.realpath(path.join(nestedB, 'CLAUDE.md')));

    const diagnosis = await invoke(['doctor', '--workspace', workspaceId], memberBEnv);
    expect(diagnosis.exitCode).toBe(0);
    expect(diagnosis.json.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'node-version', status: 'pass' }),
      expect.objectContaining({ id: 'context-git', status: 'pass' }),
      expect.objectContaining({ id: 'adapter-coverage' }),
    ]));

    const webB = path.join(memberBScan, 'web');
    await initFixtureRepository(webB, 'git@github.com:acme/web.git');
    const webBefore = {
      head: await fixtureGit(webB, ['rev-parse', 'HEAD']),
      status: await fixtureGit(webB, ['status', '--porcelain=v1']),
    };
    const contextHeadBeforeBind = await fixtureGit(daemon.repository, ['rev-parse', 'main']);
    const contextPathB = joinResult.json.data.result.local.context_path as string;
    const workspaceBeforeBind = await fs.readFile(path.join(contextPathB, 'workspace.yaml'));
    const webManifest = path.join(contextPathB, 'repositories/github.com/acme/web.yaml');
    const webManifestBeforeBind = await fs.readFile(webManifest);
    const bindPreview = await invoke([
      'add-repo', 'preview', '--workspace', workspaceId, '--repository', webB,
    ], memberBEnv);
    expect(bindPreview.exitCode).toBe(0);
    expect(bindPreview.json.data.preview.normalized_input.mode).toBe('bind-existing');
    expect(bindPreview.json.data.preview.files_to_write).toEqual([
      path.join(memberBHome, 'workspaces', `${workspaceId}.yaml`),
    ]);
    const bindResult = await invoke([
      'add-repo', 'apply', '--preview-id', bindPreview.json.data.preview.preview_id,
    ], memberBEnv);
    expect(bindResult.exitCode).toBe(0);
    expect(bindResult.json.data.result.commit).toBeUndefined();
    expect(bindResult.json.data.result.local.repository_paths['github.com/acme/web'])
      .toBe(await fs.realpath(webB));
    expect(await fixtureGit(daemon.repository, ['rev-parse', 'main'])).toBe(contextHeadBeforeBind);
    expect(await fs.readFile(path.join(contextPathB, 'workspace.yaml'))).toEqual(workspaceBeforeBind);
    expect(await fs.readFile(webManifest)).toEqual(webManifestBeforeBind);
    expect({
      head: await fixtureGit(webB, ['rev-parse', 'HEAD']),
      status: await fixtureGit(webB, ['status', '--porcelain=v1']),
    }).toEqual(webBefore);

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
