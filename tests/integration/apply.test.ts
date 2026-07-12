import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyRendered, previewApply } from '../../src/commands/apply.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { readLocalWorkspace } from '../../src/workspace/local-registry.js';
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

const now = '2026-07-11T10:00:00Z';
const existingHash = `sha256:${'a'.repeat(64)}`;

function knowledge(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id: 'kn_01J0000000000000000000000A',
    kind: 'workflow',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: [], agents: ['claude-code', 'codex'] },
    source: {
      agent: 'claude-code',
      source_type: 'project-instructions',
      locator: 'CLAUDE.md',
      content_hash: existingHash,
      observed_at: now,
    },
    confidence: 0.9,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Prefer focused tests before the full verify suite.',
    reason: 'Faster feedback on apply regressions.',
    ...overrides,
  };
}

describe('apply preview and atomic apply', () => {
  let root: string;
  let daemon: ChildProcess;
  let bare: string;
  let remote: string;
  let home: string;
  let repository: string;
  let workspaceId: string;
  let existingAgents: string;
  let existingClaude: string;

  async function businessGitLog(): Promise<string> {
    return fixtureGit(repository, ['log', '--oneline', '--all']);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-apply-'));
    bare = await createBareRemote(path.join(root, 'platform-context.git'));
    const started = await startGitDaemon(root, bare);
    daemon = started.process;
    remote = started.remote;
    home = path.join(root, 'acs-home');
    repository = path.join(root, 'business', 'api');
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    existingAgents = path.join(repository, 'AGENTS.md');
    existingClaude = path.join(repository, 'CLAUDE.md');
    // Leave generated targets absent so preview can create ACS-managed files.
    const preview = await initWorkspace({
      name: 'platform',
      contextRemote: remote,
      scanRoot: path.dirname(repository),
      maxDepth: 1,
      home,
    });
    const result = await applyInit(preview.preview_id, home);
    workspaceId = result.workspace.workspace_id;
    const local = await readLocalWorkspace(home, workspaceId);
    const store = new KnowledgeStore(local.context_path, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
    await store.put(knowledge());
    await fixtureGit(local.context_path, ['add', 'knowledge']);
    await fixtureGit(local.context_path, ['commit', '-m', 'seed knowledge']);
    await fixtureGit(local.context_path, ['push', 'origin', 'main']);
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('previews without writing, then rejects apply after target drift', async () => {
    const beforeLog = await businessGitLog();
    const preview = await previewApply({
      workspaceId,
      agents: ['claude-code', 'codex'],
      home,
    });
    expect(preview.files.map((file) => file.relativePath)).toContain('AGENTS.md');
    expect(preview.files.map((file) => file.relativePath)).toContain('CLAUDE.md');
    expect(preview.drift_candidates).toEqual([]);
    await expect(fs.access(existingAgents)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(existingClaude)).rejects.toMatchObject({ code: 'ENOENT' });

    const applied = await applyRendered(preview.preview_id, home);
    expect(applied.completed).toContain('github.com/acme/api');
    const original = await fs.readFile(existingAgents, 'utf8');
    expect(original).toContain('Generated by agent-context-sync');
    expect(await fs.readFile(existingClaude, 'utf8')).toContain('Generated by agent-context-sync');
    expect(await businessGitLog()).toEqual(beforeLog);

    const second = await previewApply({
      workspaceId,
      agents: ['claude-code', 'codex'],
      home,
    });
    expect(await fs.readFile(existingAgents, 'utf8')).toBe(original);

    await fs.appendFile(existingAgents, '\nmanual edit\n');
    await expect(applyRendered(second.preview_id, home)).rejects.toMatchObject({
      code: 'TARGET_DRIFT',
    });
    expect(await businessGitLog()).toEqual(beforeLog);
  });

  it('reports handwritten targets as drift candidates and refuses overwrite', async () => {
    await fs.writeFile(existingAgents, '# Handwritten Codex guidance\n', 'utf8');
    await fs.writeFile(existingClaude, '# Handwritten Claude guidance\n', 'utf8');
    const beforeLog = await businessGitLog();
    const beforeAgents = await fs.readFile(existingAgents, 'utf8');

    const preview = await previewApply({
      workspaceId,
      agents: ['claude-code', 'codex'],
      home,
    });
    expect(preview.drift_candidates.length).toBeGreaterThan(0);
    expect(preview.drift_candidates.some((item) => item.relativePath === 'AGENTS.md')).toBe(true);

    await expect(applyRendered(preview.preview_id, home)).rejects.toMatchObject({
      code: 'TARGET_DRIFT',
    });
    expect(await fs.readFile(existingAgents, 'utf8')).toBe(beforeAgents);
    expect(await businessGitLog()).toEqual(beforeLog);
  });
});
