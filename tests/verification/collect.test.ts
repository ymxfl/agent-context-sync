import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KnowledgeEntry } from '../../src/domain/model.js';
import { collectEvidence } from '../../src/verification/collect.js';
import { fixtureGit } from '../helpers/git.js';

const fixtureTemplate = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/verification-repo',
);

const now = '2026-07-11T10:00:00Z';
const contentHash = `sha256:${'a'.repeat(64)}`;
const repoId = 'github.com/acme/verification-fixture';

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
    statement: 'Use Prisma for persistence.',
    reason: 'The API data layer depends on Prisma client imports.',
    ...overrides,
  };
}

async function copyFixture(destination: string): Promise<void> {
  await fs.cp(fixtureTemplate, destination, { recursive: true });
}

async function materializeRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await copyFixture(repo);
  await fixtureGit(repo, ['init', '--initial-branch=main']);
  await fixtureGit(repo, ['config', 'user.name', 'Agent Context Sync Tests']);
  await fixtureGit(repo, ['config', 'user.email', 'tests@agent-context-sync.invalid']);
  await fixtureGit(repo, ['config', 'commit.gpgsign', 'false']);
  await fixtureGit(repo, ['config', 'core.fsmonitor', 'false']);
  await fixtureGit(repo, ['add', 'package.json', 'src', '.gitignore']);
  await fixtureGit(repo, ['commit', '-m', 'Seed verification fixture']);
  // Keep secrets.env on disk but untracked / ignored.
  return repo;
}

describe('collectEvidence', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'acs-verify-collect-'));
    repo = await materializeRepo(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('collects bounded package, dependency, and relative file evidence', async () => {
    const packet = await collectEvidence({
      entry: knowledge(),
      repositoryPath: repo,
      repoId,
      limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 5_000 },
    });

    expect(packet.files.some((file) => file.path === 'package.json')).toBe(true);
    expect(packet.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'prisma', version: '5.0.0' })]),
    );
    expect(packet.total_bytes).toBeLessThanOrEqual(200_000);
    expect(packet.files.every((file) => !path.isAbsolute(file.path))).toBe(true);
    expect(packet.searches.length).toBeGreaterThan(0);
    expect(packet.commits.length).toBeGreaterThan(0);
    expect(packet.packet_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packet.knowledge.id).toBe('kn_01J0000000000000000000000V');
  });

  it('honors gitignore for secrets and redacts secret material in collected text', async () => {
    const packet = await collectEvidence({
      entry: knowledge(),
      repositoryPath: repo,
      repoId,
      limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 5_000 },
    });

    expect(packet.files.every((file) => file.path !== 'secrets.env')).toBe(true);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(serialized).not.toContain('sk-test-should-be-redacted-abcdefghijklmnopqrst');
    expect(serialized).toMatch(/\[REDACTED_SECRET\]/);
  });

  it('reports truncation when byte budget is exhausted without throwing', async () => {
    const packet = await collectEvidence({
      entry: knowledge(),
      repositoryPath: repo,
      repoId,
      limits: { maxFiles: 20, maxBytes: 80, maxCommits: 20, timeoutMs: 5_000 },
    });

    expect(packet.truncated).toBe(true);
    expect(packet.total_bytes).toBeLessThanOrEqual(80);
    expect(packet.timed_out).toBe(false);
  });

  it('reports command timeout in the packet instead of throwing a bare Error', async () => {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const slowRg = path.join(bin, 'rg');
    // exec so SIGTERM from execFile timeout reaches sleep directly.
    await fs.writeFile(slowRg, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });

    const started = Date.now();
    const packet = await collectEvidence({
      entry: knowledge(),
      repositoryPath: repo,
      repoId,
      limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 200 },
      rgPath: slowRg,
    });
    const elapsed = Date.now() - started;

    expect(packet.timed_out).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
    expect(packet.packet_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps collected file paths inside the real repository root', async () => {
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'should-not-be-read\n');
    await fs.symlink(outside, path.join(repo, 'src', 'escaped.txt'));

    const packet = await collectEvidence({
      entry: knowledge({
        statement: 'escaped should never leave the repository root.',
        reason: 'Symlink escape regression coverage.',
      }),
      repositoryPath: repo,
      repoId,
      limits: { maxFiles: 20, maxBytes: 200_000, maxCommits: 20, timeoutMs: 5_000 },
    });

    expect(packet.files.every((file) => !file.path.includes('..'))).toBe(true);
    expect(packet.files.every((file) => file.path !== 'outside.txt')).toBe(true);
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toContain('should-not-be-read');
  });
});
