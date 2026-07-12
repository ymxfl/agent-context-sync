import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCapture, prepareCapture, previewCapture } from '../../src/commands/capture.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
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

const now = '2026-07-11T10:00:00Z';
const existingHash = `sha256:${'e'.repeat(64)}`;

function knowledge(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id: 'kn_01J00000000000000000000009',
    kind: 'workflow',
    scope: 'workspace',
    status: 'active',
    applies_to: { paths: ['src/**'], agents: ['codex'] },
    source: {
      agent: 'codex',
      source_type: 'project-instructions',
      locator: 'AGENTS.md',
      content_hash: existingHash,
      observed_at: now,
    },
    confidence: 0.9,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Ship focused tests before the full verify suite.',
    reason: 'Faster feedback on capture regressions.',
    ...overrides,
  };
}

async function currentBranchWasForcePushed(
  bare: string,
  previousMain: string,
): Promise<boolean> {
  try {
    await fixtureGit(bare, ['merge-base', '--is-ancestor', previousMain, 'main']);
    return false;
  } catch {
    return true;
  }
}

describe('capture apply', () => {
  let root: string;
  let daemon: ChildProcess;
  let bare: string;
  let remote: string;
  let home: string;
  let agentHome: string;
  let repository: string;
  let workspaceId: string;
  let contextPath: string;

  async function remoteContains(commit: string): Promise<boolean> {
    const listing = await fixtureGit(root, ['ls-remote', remote]);
    return listing.split('\n').some((line) => line.startsWith(commit));
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-capture-apply-'));
    bare = await createBareRemote(path.join(root, 'platform-context.git'));
    const started = await startGitDaemon(root, bare);
    daemon = started.process;
    remote = started.remote;
    home = path.join(root, 'acs-home');
    agentHome = path.join(root, 'agent-home');
    repository = path.join(root, 'business', 'api');
    await fs.mkdir(agentHome, { recursive: true });
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    await fs.writeFile(
      path.join(repository, 'AGENTS.md'),
      '# API instructions\n\nAlways run focused tests first.\n',
    );
    await fs.writeFile(path.join(repository, 'CLAUDE.md'), '# API instructions\n');
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

    const store = new KnowledgeStore(contextPath, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
    await store.put(knowledge());
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'seed knowledge']);
    await fixtureGit(contextPath, ['push', 'origin', 'main']);
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function prepareAndPreview(statement: string) {
    const packet = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });
    const teamSource = packet.sources.find((source) => source.shareability === 'team');
    expect(teamSource).toBeDefined();
    const preview = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [{
        kind: 'workflow',
        scope: 'workspace',
        applies_to: { paths: ['tests/**'], agents: ['codex'] },
        source: {
          agent: 'codex',
          source_type: teamSource!.source_type,
          locator: 'AGENTS.md',
          content_hash: teamSource!.content_hash,
          observed_at: now,
        },
        confidence: 0.7,
        supersedes: [],
        conflicts_with: [],
        statement,
        reason: 'Capture apply integration coverage.',
      }],
      rejected: [],
    }, { home });
    return { packet, preview };
  }

  it('publishes approved knowledge to Context Git end-to-end', async () => {
    const businessHeadBefore = await fixtureGit(repository, ['rev-parse', 'HEAD']);
    const { preview } = await prepareAndPreview(
      'Document daemon startup retries in capture apply tests.',
    );
    expect(preview.workspace_id).toBe(workspaceId);
    expect(preview.creates).toHaveLength(1);

    const result = await applyCapture(preview.preview_id, home);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await remoteContains(result.commit)).toBe(true);
    expect(result.remote_state.ahead).toBe(0);
    expect(result.remote_state.behind).toBe(0);
    expect(result.remote_state.diverged).toBe(false);

    const createdPath = path.join(contextPath, preview.creates[0]!.path);
    expect(await fs.readFile(createdPath, 'utf8')).toContain(
      'Document daemon startup retries in capture apply tests.',
    );
    const store = new KnowledgeStore(contextPath, {
      registeredRepositoryIds: new Set(['github.com/acme/api']),
    });
    expect(await store.get(preview.creates[0]!.entry.id)).toMatchObject({
      statement: 'Document daemon startup retries in capture apply tests.',
      status: 'active',
    });

    await expect(applyCapture(preview.preview_id, home)).rejects.toMatchObject({
      code: 'PREVIEW_ALREADY_USED',
    });
    expect(await fixtureGit(repository, ['rev-parse', 'HEAD'])).toBe(businessHeadBefore);
    expect(await fixtureGit(repository, ['log', '--all', '--format=%H'])).toBe(businessHeadBefore);
  });

  it('rejects stale previews after a remote Context commit without force push', async () => {
    const { preview: first } = await prepareAndPreview(
      'First approved capture before remote advances.',
    );
    const previousMain = await fixtureGit(bare, ['rev-parse', 'main']);

    const rival = path.join(root, 'rival');
    await fixtureGit(root, ['clone', remote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'remote advance\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Remote Context advance']);
    await fixtureGit(rival, ['push', 'origin', 'main']);

    await expect(applyCapture(first.preview_id, home)).rejects.toMatchObject({
      code: 'STALE_PREVIEW',
    });
    expect(await currentBranchWasForcePushed(bare, previousMain)).toBe(false);

    const { preview: fresh } = await prepareAndPreview(
      'Fresh capture after remote Context advance.',
    );
    const result = await applyCapture(fresh.preview_id, home);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await remoteContains(result.commit)).toBe(true);
  });

  it('archives superseded knowledge and keeps business repos untouched on push race', async () => {
    const businessHeadBefore = await fixtureGit(repository, ['rev-parse', 'HEAD']);
    const previousMain = await fixtureGit(bare, ['rev-parse', 'main']);
    const packet = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });
    const teamSource = packet.sources.find((source) => source.shareability === 'team');
    expect(teamSource).toBeDefined();
    const preview = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [{
        kind: 'workflow',
        scope: 'workspace',
        applies_to: { paths: ['src/**'], agents: ['codex'] },
        source: {
          agent: 'codex',
          source_type: teamSource!.source_type,
          locator: 'AGENTS.md',
          content_hash: teamSource!.content_hash,
          observed_at: now,
        },
        confidence: 0.8,
        supersedes: ['kn_01J00000000000000000000009'],
        conflicts_with: [],
        statement: 'Prefer applyCapture integration coverage over unit mocks.',
        reason: 'Archives the seeded entry.',
      }],
      rejected: [],
    }, { home });
    expect(preview.archives).toContainEqual(expect.objectContaining({
      id: 'kn_01J00000000000000000000009',
    }));

    const rival = path.join(root, 'rival-push');
    await fixtureGit(root, ['clone', remote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'RACE.md'), 'race\n');
    await fixtureGit(rival, ['add', 'RACE.md']);
    await fixtureGit(rival, ['commit', '-m', 'Concurrent Context change']);
    const rivalHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);
    await fixtureGit(rival, ['push', 'origin', 'HEAD:refs/race/next']);
    await fs.writeFile(path.join(root, 'advance-main-on-next-push'), rivalHead);

    await expect(applyCapture(preview.preview_id, home)).rejects.toMatchObject({
      code: 'REMOTE_CHANGED',
    });
    expect(await fixtureGit(repository, ['rev-parse', 'HEAD'])).toBe(businessHeadBefore);
    const finalMain = await fixtureGit(bare, ['rev-parse', 'main']);
    expect(finalMain).toBe(rivalHead);
    expect(await currentBranchWasForcePushed(bare, previousMain)).toBe(false);
  });

  it('rolls back knowledge writes and maps graph failures to INVALID_KNOWLEDGE_GRAPH', async () => {
    const { saveCapturePreview } = await import('../../src/preview/store.js');
    const { serializeKnowledge } = await import('../../src/knowledge/markdown.js');
    const head = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    const beforeStatus = await fixtureGit(contextPath, ['status', '--porcelain=v1', '--', 'knowledge']);
    const missingId = 'kn_01J00000000000000000000099';
    const entry: KnowledgeEntry = {
      schema_version: 1,
      id: 'kn_01J00000000000000000000050',
      kind: 'workflow',
      scope: 'workspace',
      status: 'active',
      applies_to: { paths: ['src/**'], agents: ['codex'] },
      source: {
        agent: 'codex',
        source_type: 'project-instructions',
        locator: 'AGENTS.md',
        content_hash: `sha256:${'a'.repeat(64)}`,
        observed_at: now,
      },
      confidence: 0.5,
      supersedes: [missingId],
      conflicts_with: [],
      created_at: now,
      updated_at: now,
      last_verified_at: null,
      statement: 'This create intentionally breaks the knowledge graph.',
      reason: 'Missing supersedes target should fail apply.',
    };
    const relativePath = `knowledge/workspace/${entry.id}.md`;
    const bytes = serializeKnowledge(entry);
    await saveCapturePreview(home, {
      preview_id: 'preview_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      packet_hash: `sha256:${'b'.repeat(64)}`,
      context_head: head,
      workspace_id: workspaceId,
      creates: [{
        entry,
        path: relativePath,
        bytes,
        diff: `--- ${relativePath}\n+++ ${relativePath}\n`,
      }],
      updates: [],
      archives: [],
      rejections: [],
      duplicates: [],
      warnings: [],
    });

    await expect(applyCapture('preview_01ARZ3NDEKTSV4RRFFQ69G5FAV', home)).rejects.toMatchObject({
      code: 'INVALID_KNOWLEDGE_GRAPH',
    });

    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await fixtureGit(contextPath, ['status', '--porcelain=v1', '--', 'knowledge']))
      .toBe(beforeStatus);
    await expect(fs.access(path.join(contextPath, relativePath)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
