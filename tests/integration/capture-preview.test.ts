import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareCapture, previewCapture } from '../../src/commands/capture.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { serializeKnowledge } from '../../src/knowledge/markdown.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { readLocalWorkspace } from '../../src/workspace/local-registry.js';
import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';

// Real Git daemons and repositories can take over 20 seconds on slower CI hosts.
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

describe('capture prepare and preview', () => {
  let root: string;
  let daemon: ChildProcess;
  let remote: string;
  let home: string;
  let agentHome: string;
  let repository: string;
  let workspaceId: string;
  let contextPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-capture-preview-'));
    const started = await startGitDaemon(root);
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
      contextRemote: started.remote,
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
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('prepares a packet and previews creates without writing Context knowledge', async () => {
    const beforeStatus = await fixtureGit(contextPath, ['status', '--porcelain=v1']);
    const beforeHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    const beforeKnowledge = await fs.readdir(path.join(contextPath, 'knowledge'), {
      recursive: true,
    });

    const packet = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });

    expect(packet.packet_id).toMatch(/^packet_/);
    expect(packet.sources.length).toBeGreaterThan(0);
    expect(packet.sources.every((source) => source.shareability !== 'personal')).toBe(true);
    expect(packet.sources.every((source) => source.shareability !== 'managed')).toBe(true);
    expect(packet.existing.some((item) => item.id === 'kn_01J00000000000000000000009')).toBe(true);

    const teamSource = packet.sources.find((source) => source.shareability === 'team');
    expect(teamSource).toBeDefined();

    const proposal = {
      schema_version: 1 as const,
      packet_id: packet.packet_id,
      accepted: [
        {
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
          confidence: 0.85,
          supersedes: [],
          conflicts_with: [],
          statement: 'Ship focused tests before the full verify suite.',
          reason: 'Matches the seeded knowledge statement for dedupe.',
        },
        {
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
          statement: 'Document daemon startup retries in capture tests.',
          reason: 'Git daemon readiness is flaky without retries.',
        },
      ],
      rejected: [],
    };

    const preview = await previewCapture(packet.packet_id, proposal, { home });

    expect(preview.creates).toHaveLength(1);
    expect(preview.duplicates).toContainEqual(expect.objectContaining({
      existing_id: 'kn_01J00000000000000000000009',
    }));
    expect(preview.context_head).toBe(packet.context_head);
    expect(preview.packet_hash).toBe(packet.packet_hash);
    expect(preview.creates[0]?.bytes).toBe(
      serializeKnowledge(preview.creates[0]!.entry),
    );

    expect(await fixtureGit(contextPath, ['status', '--porcelain=v1'])).toBe(beforeStatus);
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(await fs.readdir(path.join(contextPath, 'knowledge'), { recursive: true }))
      .toEqual(beforeKnowledge);
  });

  it('rejects missing source hashes and personal candidates without approval', async () => {
    const packet = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
      includePersonal: false,
    });
    const teamSource = packet.sources.find((source) => source.shareability === 'team');
    expect(teamSource).toBeDefined();

    const missing = await previewCapture(packet.packet_id, {
      schema_version: 1,
      packet_id: packet.packet_id,
      accepted: [{
        kind: 'workflow',
        scope: 'workspace',
        applies_to: { paths: [], agents: ['codex'] },
        source: {
          agent: 'codex',
          source_type: 'project-instructions',
          locator: 'AGENTS.md',
          content_hash: `sha256:${'f'.repeat(64)}`,
          observed_at: now,
        },
        confidence: 0.5,
        supersedes: [],
        conflicts_with: [],
        statement: 'This hash was never in the packet.',
        reason: 'Should be rejected.',
      }],
      rejected: [],
    }, { home });

    expect(missing.creates).toHaveLength(0);
    expect(missing.rejections).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/source hash|packet/i),
    }));

    await fs.mkdir(path.join(agentHome, '.codex'), { recursive: true });
    await fs.writeFile(path.join(agentHome, '.codex', 'AGENTS.md'), '# Personal home instructions\n');
    const withPersonalSources = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
      includePersonal: true,
    });
    const personal = withPersonalSources.sources.find((source) => source.shareability === 'personal');
    expect(personal).toBeDefined();

    // Re-persist the packet as if personal sources leaked without approval.
    const { persistExtractionPacket } = await import('../../src/commands/capture.js');
    await persistExtractionPacket(home, withPersonalSources, {
      includePersonal: false,
      registeredRepositoryIds: ['github.com/acme/api'],
      workspaceId,
    });

    const denied = await previewCapture(withPersonalSources.packet_id, {
      schema_version: 1,
      packet_id: withPersonalSources.packet_id,
      accepted: [{
        kind: 'workflow',
        scope: 'workspace',
        applies_to: { paths: [], agents: ['codex'] },
        source: {
          agent: 'codex',
          source_type: personal!.source_type,
          locator: 'global-agents.md',
          content_hash: personal!.content_hash,
          observed_at: now,
        },
        confidence: 0.5,
        supersedes: [],
        conflicts_with: [],
        statement: 'Do not share personal preferences.',
        reason: 'Requires include_personal.',
      }],
      rejected: [],
    }, { home });

    expect(denied.creates).toHaveLength(0);
    expect(denied.rejections).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/personal|include_personal|approval/i),
    }));

    const afterHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    expect(await fixtureGit(contextPath, ['status', '--porcelain=v1'])).toBe('');
    expect(afterHead).toMatch(/^[0-9a-f]{40}$/);
  });

  it('fast-forwards a behind Context checkout before binding packet.context_head', async () => {
    await fixtureGit(contextPath, ['push', 'origin', 'main']);
    const behindHead = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);

    const rival = path.join(root, 'rival-context');
    await fixtureGit(root, ['clone', remote, rival]);
    await fixtureGit(rival, ['config', 'user.name', 'Rival']);
    await fixtureGit(rival, ['config', 'user.email', 'rival@example.invalid']);
    await fs.writeFile(path.join(rival, 'README.md'), 'remote advance for prepare\n');
    await fixtureGit(rival, ['add', 'README.md']);
    await fixtureGit(rival, ['commit', '-m', 'Remote Context advance']);
    await fixtureGit(rival, ['push', 'origin', 'main']);
    const remoteHead = await fixtureGit(rival, ['rev-parse', 'HEAD']);
    expect(remoteHead).not.toBe(behindHead);
    expect(await fixtureGit(contextPath, ['rev-parse', 'HEAD'])).toBe(behindHead);

    const packet = await prepareCapture({
      workspaceId,
      agent: 'codex',
      home,
      homeDir: agentHome,
    });

    const localHeadAfter = await fixtureGit(contextPath, ['rev-parse', 'HEAD']);
    expect(localHeadAfter).toBe(remoteHead);
    expect(packet.context_head).toBe(remoteHead);
  });
});
