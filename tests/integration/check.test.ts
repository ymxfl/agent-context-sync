import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCheck, prepareCheck, previewCheck } from '../../src/commands/check.js';
import { applyInit, initWorkspace } from '../../src/commands/init.js';
import type { KnowledgeEntry } from '../../src/domain/model.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import { readLocalWorkspace } from '../../src/workspace/local-registry.js';
import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fixtureTemplate = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/verification-repo',
);

const now = '2026-07-11T10:00:00Z';
const contentHash = `sha256:${'a'.repeat(64)}`;
const repoId = 'github.com/acme/api';

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

function digest(contents: string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

function knowledge(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    schema_version: 1,
    id: 'kn_01J0000000000000000000000V',
    kind: 'architecture-decision',
    scope: `repository:${repoId}`,
    status: 'active',
    applies_to: { paths: ['src/**'], agents: ['claude-code', 'codex'] },
    source: {
      agent: 'claude-code',
      source_type: 'project-instructions',
      locator: 'CLAUDE.md',
      content_hash: contentHash,
      observed_at: now,
    },
    confidence: 0.9,
    supersedes: [],
    conflicts_with: [],
    created_at: now,
    updated_at: now,
    last_verified_at: null,
    statement: 'Use TypeORM for persistence.',
    reason: 'Historical data-layer guidance that no longer matches the repo.',
    ...overrides,
  };
}

describe('check prepare, preview, and apply', () => {
  let root: string;
  let daemon: ChildProcess;
  let remote: string;
  let home: string;
  let repository: string;
  let workspaceId: string;
  let contextPath: string;
  let old: KnowledgeEntry;
  let knowledgeStore: KnowledgeStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-check-'));
    const started = await startGitDaemon(root);
    daemon = started.process;
    remote = started.remote;
    home = path.join(root, 'acs-home');
    repository = path.join(root, 'business', 'api');
    await initFixtureRepository(repository, 'https://github.com/acme/api.git');
    await fs.cp(fixtureTemplate, repository, { recursive: true });
    await fixtureGit(repository, ['add', 'package.json', 'src', '.gitignore']);
    await fixtureGit(repository, ['commit', '-m', 'Seed verification fixture']);

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

    old = knowledge();
    knowledgeStore = new KnowledgeStore(contextPath, {
      registeredRepositoryIds: new Set([repoId]),
    });
    await knowledgeStore.put(old);
    await fixtureGit(contextPath, ['add', 'knowledge']);
    await fixtureGit(contextPath, ['commit', '-m', 'seed knowledge']);
    await fixtureGit(contextPath, ['push', 'origin', 'main']);
  });

  afterEach(async () => {
    await stopProcess(daemon);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function preparePackets() {
    return prepareCheck({
      workspaceId,
      home,
      repositories: [repoId],
    });
  }

  function supersedeProposal(packet: Awaited<ReturnType<typeof preparePackets>>[number]) {
    const dependency = packet.dependencies.find((item) => item.name === 'prisma');
    expect(dependency).toBeDefined();
    const file = packet.files.find((item) => item.path === 'package.json')
      ?? packet.files[0];
    expect(file).toBeDefined();
    return {
      schema_version: 1 as const,
      packet_id: packet.packet_id,
      packet_hash: packet.packet_hash,
      findings: [{
        knowledge_id: old.id,
        status: 'contradicted' as const,
        explanation: 'The repository depends on Prisma, not TypeORM.',
        evidence: [
          {
            type: 'dependency' as const,
            repo_id: repoId,
            manifest_path: dependency!.manifest_path,
            name: dependency!.name,
            version: dependency!.version,
            content_hash: dependency!.content_hash,
          },
          {
            type: 'file' as const,
            repo_id: repoId,
            path: file!.path,
            start_line: file!.start_line,
            end_line: file!.end_line,
            content_hash: file!.content_hash,
          },
        ],
        proposed_action: {
          type: 'supersede' as const,
          statement: 'Use Prisma for persistence.',
          reason: 'The active dependency and code imports use Prisma.',
        },
      }],
    };
  }

  it('previews supersede without writing, then apply marks old superseded and creates replacement', async () => {
    const packets = await preparePackets();
    expect(packets).toHaveLength(1);
    const packet = packets[0]!;
    expect(packet.knowledge.id).toBe(old.id);
    expect(packet.files.every((file) => !path.isAbsolute(file.path))).toBe(true);

    const proposal = supersedeProposal(packet);
    const preview = await previewCheck([packet.packet_id], proposal, { home });
    expect(preview.changes.supersede).toHaveLength(1);
    expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });

    const businessHeadBefore = await fixtureGit(repository, ['rev-parse', 'HEAD']);
    const result = await applyCheck(preview.preview_id, home);
    expect(result.required_apply).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'superseded' });
    expect((await knowledgeStore.list()).some((item) => item.statement === 'Use Prisma for persistence.')).toBe(true);
    expect(await fixtureGit(repository, ['rev-parse', 'HEAD'])).toBe(businessHeadBefore);
  });

  it('rejects nonexistent evidence paths without writing knowledge', async () => {
    const packets = await preparePackets();
    const packet = packets[0]!;
    const proposal = supersedeProposal(packet);
    proposal.findings[0]!.evidence = [{
      type: 'file',
      repo_id: repoId,
      path: 'does-not-exist.ts',
      start_line: 1,
      end_line: 1,
      content_hash: digest('missing'),
    }];

    await expect(previewCheck([packet.packet_id], proposal, { home })).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE',
    });
    expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });
    expect((await knowledgeStore.list()).every((item) => item.statement !== 'Use Prisma for persistence.')).toBe(true);
  });

  it('rejects changed evidence hashes without writing knowledge', async () => {
    const packets = await preparePackets();
    const packet = packets[0]!;
    const proposal = supersedeProposal(packet);
    const finding = proposal.findings[0]!;
    finding.evidence = finding.evidence.map((item, index) => (
      index === 0 && 'content_hash' in item
        ? { ...item, content_hash: `sha256:${'f'.repeat(64)}` }
        : item
    ));

    await expect(previewCheck([packet.packet_id], proposal, { home })).rejects.toMatchObject({
      code: 'INVALID_EVIDENCE',
    });
    expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });
  });

  it('rejects apply after Context HEAD changes without writing knowledge', async () => {
    const packets = await preparePackets();
    const packet = packets[0]!;
    const proposal = supersedeProposal(packet);
    const preview = await previewCheck([packet.packet_id], proposal, { home });
    expect(preview.changes.supersede).toHaveLength(1);

    await fs.writeFile(path.join(contextPath, 'README.md'), 'context advanced\n');
    await fixtureGit(contextPath, ['add', 'README.md']);
    await fixtureGit(contextPath, ['commit', '-m', 'Advance Context HEAD']);
    await fixtureGit(contextPath, ['push', 'origin', 'main']);

    await expect(applyCheck(preview.preview_id, home)).rejects.toMatchObject({
      code: 'STALE_PREVIEW',
    });
    expect(await knowledgeStore.get(old.id)).toMatchObject({ status: 'active' });
    expect((await knowledgeStore.list()).every((item) => item.statement !== 'Use Prisma for persistence.')).toBe(true);
  });
});
