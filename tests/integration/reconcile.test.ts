import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyReconcile,
  prepareReconcile,
  previewReconcile,
} from '../../src/commands/reconcile.js';
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

const now = '2026-07-11T10:00:00Z';
const later = '2026-07-11T11:00:00Z';
const contentHash = `sha256:${'a'.repeat(64)}`;

function knowledge(id: string, overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id,
    kind: 'architecture-decision',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: ['src/**'], agents: ['claude-code', 'codex'] },
    source: {
      agent: 'claude-code',
      source_type: 'project-instructions',
      locator: 'AGENTS.md',
      content_hash: contentHash,
      observed_at: now,
    },
    confidence: 0.9,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: `Statement ${id}`,
    reason: `Reason ${id}`,
    ...overrides,
  };
}

describe('reconcile divergent Context knowledge', () => {
  let root: string;
  let daemon: ChildProcess;
  let remote: string;
  let home: string;
  let repository: string;
  let workspaceId: string;
  let contextPath: string;
  let rivalContextPath: string;
  let baseEntry: KnowledgeEntry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-reconcile-'));
    const started = await startGitDaemon(root);
    daemon = started.process;
    remote = started.remote;
    home = path.join(root, 'acs-home');
    repository = path.join(root, 'business', 'api');
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    await fs.writeFile(path.join(repository, 'README.md'), '# api\n');
    await fixtureGit(repository, ['add', 'README.md']);
    await fixtureGit(repository, ['commit', '-m', 'Seed business repo']);

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
    contextPath = local.context_path;

    baseEntry = knowledge('kn_01J0000000000000000000000B', {
      statement: 'Shared base rule.',
      reason: 'Present on both sides before divergence.',
    });
    const store = new KnowledgeStore(contextPath);
    await store.put(baseEntry);
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'seed shared knowledge']);
    await fixtureGit(contextPath, ['push', 'origin', 'main']);

    rivalContextPath = path.join(root, 'rival-context');
    await fixtureGit(root, ['clone', remote, rivalContextPath]);
    await fixtureGit(rivalContextPath, ['config', 'user.name', 'Rival']);
    await fixtureGit(rivalContextPath, ['config', 'user.email', 'rival@example.invalid']);
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function parentCount(repo: string, rev: string): Promise<number> {
    const output = await fixtureGit(repo, ['rev-list', '--parents', '-n', '1', rev]);
    return output.trim().split(/\s+/).length - 1;
  }

  it('auto-merges additive divergence into a merge commit without force push', async () => {
    const localOnly = knowledge('kn_01J0000000000000000000000M', {
      statement: 'Local additive rule.',
      reason: 'Added only on local before fetch.',
      applies_to: { paths: ['apps/local/**'], agents: ['claude-code'] },
    });
    const remoteOnly = knowledge('kn_01J0000000000000000000000N', {
      statement: 'Remote additive rule.',
      reason: 'Added only on remote before local fetch.',
      applies_to: { paths: ['apps/remote/**'], agents: ['codex'] },
    });

    const localStore = new KnowledgeStore(contextPath);
    await localStore.put(localOnly);
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'local additive knowledge']);

    const rivalStore = new KnowledgeStore(rivalContextPath);
    await rivalStore.put(remoteOnly);
    await fixtureGit(rivalContextPath, ['add', 'knowledge']);
    await fixtureGit(rivalContextPath, ['commit', '-m', 'remote additive knowledge']);
    await fixtureGit(rivalContextPath, ['push', 'origin', 'main']);

    await fixtureGit(contextPath, ['fetch', 'origin']);

    const packet = await prepareReconcile({ workspaceId, home });
    expect(packet.conflicts).toEqual([]);
    expect(packet.automatic).toEqual(expect.arrayContaining([localOnly.id, remoteOnly.id]));

    const preview = await previewReconcile(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      packet_hash: packet.packet_hash,
      resolutions: [],
    }, { home });

    const published = await applyReconcile(preview.preview_id, home);
    expect(published.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await parentCount(contextPath, published.commit)).toBe(2);

    const remoteHead = (await fixtureGit(root, ['ls-remote', remote, 'refs/heads/main']))
      .split(/\s+/)[0];
    expect(remoteHead).toBe(published.commit);
    expect(await parentCount(contextPath, 'origin/main')).toBe(2);

    const merged = new KnowledgeStore(contextPath);
    expect(await merged.get(localOnly.id)).toMatchObject({ statement: localOnly.statement });
    expect(await merged.get(remoteOnly.id)).toMatchObject({ statement: remoteOnly.statement });
    expect(await merged.get(baseEntry.id)).toMatchObject({ statement: baseEntry.statement });
  });

  it('applies Agent conflict resolutions without rewriting published history', async () => {
    const localEdit = knowledge(baseEntry.id, {
      statement: 'Local divergent edit.',
      reason: 'Changed on local.',
      updated_at: later,
    });
    const remoteEdit = knowledge(baseEntry.id, {
      statement: 'Remote divergent edit.',
      reason: 'Changed on remote.',
      updated_at: later,
    });

    const localStore = new KnowledgeStore(contextPath);
    await localStore.put(localEdit);
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'local edit knowledge']);

    const rivalStore = new KnowledgeStore(rivalContextPath);
    await rivalStore.put(remoteEdit);
    await fixtureGit(rivalContextPath, ['add', 'knowledge']);
    await fixtureGit(rivalContextPath, ['commit', '-m', 'remote edit knowledge']);
    await fixtureGit(rivalContextPath, ['push', 'origin', 'main']);
    await fixtureGit(contextPath, ['fetch', 'origin']);

    const packet = await prepareReconcile({ workspaceId, home });
    expect(packet.conflicts).toContainEqual(expect.objectContaining({
      knowledge_id: baseEntry.id,
      type: 'SAME_ENTRY_EDIT',
    }));
    const conflict = packet.conflicts.find((item) => item.knowledge_id === baseEntry.id);
    expect(conflict).toBeDefined();

    const preview = await previewReconcile(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      packet_hash: packet.packet_hash,
      resolutions: [{
        conflict_id: conflict!.conflict_id,
        choice: 'remote',
      }],
    }, { home });

    const beforeParents = await fixtureGit(contextPath, ['rev-parse', 'HEAD', 'origin/main']);
    const [localParent, remoteParent] = beforeParents.split('\n');

    const published = await applyReconcile(preview.preview_id, home);
    expect(await parentCount(contextPath, published.commit)).toBe(2);

    const parents = (await fixtureGit(contextPath, [
      'rev-list', '--parents', '-n', '1', published.commit,
    ])).trim().split(/\s+/).slice(1);
    expect(parents).toEqual(expect.arrayContaining([localParent, remoteParent]));

    const store = new KnowledgeStore(contextPath);
    expect(await store.get(baseEntry.id)).toMatchObject({
      statement: 'Remote divergent edit.',
    });
  });
});
