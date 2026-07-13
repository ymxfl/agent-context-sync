/**
 * Full MVP acceptance scenario.
 *
 * Targets the planned ten-repository Workspace with five member-B bindings,
 * covering bidirectional Claude↔Codex sync, check stale mutation, reconcile
 * divergence, and businessCommitsCreatedByTool === 0.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it, vi } from 'vitest';

import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';
import { invoke } from '../helpers/invoke.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WORKSPACE_REPOS = 10;
const MEMBER_B_REPOS = 5;

const verificationFixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/verification-repo',
);

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

function proposalFromPacket(
  packet: {
    packet_id: string;
    sources: Array<{
      agent: string;
      source_type: string;
      content_hash: string;
      shareability: string;
    }>;
  },
  statement: string,
  agents: string[],
  locator: string,
): unknown {
  const teamSource = packet.sources.find((source) => source.shareability === 'team');
  if (teamSource === undefined) throw new Error('Expected a team source in the extraction packet');
  return {
    schema_version: 1,
    packet_id: packet.packet_id,
    accepted: [{
      kind: 'workflow',
      scope: 'workspace',
      applies_to: { paths: [], agents },
      source: {
        agent: teamSource.agent,
        source_type: teamSource.source_type,
        locator,
        content_hash: teamSource.content_hash,
        observed_at: '2026-07-11T12:00:00.000Z',
      },
      confidence: 0.95,
      supersedes: [],
      conflicts_with: [],
      statement,
      reason: 'Captured during the MVP acceptance scenario.',
    }],
    rejected: [],
  };
}

async function businessCommitCount(repoPaths: readonly string[]): Promise<number> {
  let total = 0;
  for (const repo of repoPaths) {
    const log = await fixtureGit(repo, ['rev-list', '--count', 'HEAD']);
    total += Number.parseInt(log, 10);
  }
  return total;
}

async function seedBusinessRepos(scanRoot: string, count: number): Promise<string[]> {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `svc-${index}`;
    const repository = path.join(scanRoot, name);
    await initFixtureRepository(repository, `https://github.com/acme/${name}.git`);
    await fs.writeFile(
      path.join(repository, 'CLAUDE.md'),
      `# Claude ${name}\n\nUse focused tests first for ${name}.\n`,
    );
    await fs.writeFile(
      path.join(repository, 'AGENTS.md'),
      `# Codex ${name}\n\nKeep ${name} diffs reviewable.\n`,
    );
    if (index === 0) {
      await fs.cp(verificationFixture, repository, { recursive: true });
      await fixtureGit(repository, ['add', 'package.json', 'src', '.gitignore']);
      await fixtureGit(repository, ['commit', '-m', 'Seed verification fixture']);
    }
    paths.push(repository);
  }
  return paths;
}

async function runMvpScenario(): Promise<{
  workspaceRepositories: number;
  memberBRepositories: number;
  claudeToCodex: 'pass' | 'fail';
  codexToClaude: 'pass' | 'fail';
  staleRuleCheck: 'pass' | 'fail';
  divergentContextReconcile: 'pass' | 'fail';
  businessCommitsCreatedByTool: number;
}> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'acs-mvp-'));
  const daemon = await startGitDaemon(root);
  try {
    const memberAHome = path.join(root, 'member-a-acs');
    const memberAAgentHome = path.join(root, 'member-a-agent');
    const memberAScan = path.join(root, 'member-a-business');
    await fs.mkdir(memberAAgentHome, { recursive: true });
    const memberARepos = await seedBusinessRepos(memberAScan, WORKSPACE_REPOS);
    const businessHeadsBefore = await Promise.all(
      memberARepos.map(async (repo) => [repo, await fixtureGit(repo, ['rev-parse', 'HEAD'])] as const),
    );
    const commitsBeforeA = await businessCommitCount(memberARepos);
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
    const initResult = await invoke([
      'init', 'apply', '--preview-id', initPreview.json.data.preview.preview_id,
    ], memberAEnv);
    expect(initResult.exitCode).toBe(0);
    const workspaceId = initResult.json.data.result.workspace.workspace_id as string;
    const workspaceRepos = initResult.json.data.result.workspace.repositories as unknown[];
    expect(workspaceRepos).toHaveLength(WORKSPACE_REPOS);

    // --- Claude → Codex ---
    const capturePrepare = await invoke([
      'capture', 'prepare', '--workspace', workspaceId, '--agent', 'claude-code',
      '--repository', 'github.com/acme/svc-0',
    ], memberAEnv);
    expect(capturePrepare.exitCode).toBe(0);
    const packetA = capturePrepare.json.data.packet;
    const proposalPathA = path.join(root, 'proposal-a.json');
    await fs.writeFile(
      proposalPathA,
      JSON.stringify(proposalFromPacket(
        packetA,
        'Prefer focused tests before the full verify suite.',
        ['claude-code', 'codex'],
        'CLAUDE.md',
      )),
      'utf8',
    );
    const capturePreview = await invoke([
      'capture', 'preview', '--packet-id', packetA.packet_id, '--proposal', proposalPathA,
    ], memberAEnv);
    expect(capturePreview.exitCode).toBe(0);
    const captureApply = await invoke([
      'capture', 'apply', '--preview-id', capturePreview.json.data.preview.preview_id,
    ], memberAEnv);
    expect(captureApply.exitCode).toBe(0);

    const memberBHome = path.join(root, 'member-b-acs');
    const memberBAgentHome = path.join(root, 'member-b-agent');
    const memberBScan = path.join(root, 'member-b-business');
    await fs.mkdir(memberBAgentHome, { recursive: true });
    const memberBRepos: string[] = [];
    for (let index = 0; index < MEMBER_B_REPOS; index += 1) {
      const name = `svc-${index}`;
      const repository = path.join(memberBScan, name);
      await initFixtureRepository(repository, `git@github.com:acme/${name}.git`);
      await fs.writeFile(path.join(repository, 'AGENTS.md'), `# Codex ${name}\n`);
      memberBRepos.push(repository);
    }
    const commitsBeforeB = await businessCommitCount(memberBRepos);
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
    const joinResult = await invoke([
      'join', 'apply', '--preview-id', joinPreview.json.data.preview.preview_id,
    ], memberBEnv);
    expect(joinResult.exitCode).toBe(0);
    const memberBBindings = Object.keys(
      joinResult.json.data.result.local.repository_paths as Record<string, string>,
    );
    expect(memberBBindings).toHaveLength(MEMBER_B_REPOS);

    await fs.rm(path.join(memberBRepos[0]!, 'AGENTS.md'));
    const applyPreviewB = await invoke([
      'apply', 'preview', '--workspace', workspaceId, '--agent', 'codex',
      '--repository', 'github.com/acme/svc-0',
    ], memberBEnv);
    expect(applyPreviewB.exitCode).toBe(0);
    const applyResultB = await invoke([
      'apply', 'apply', '--preview-id', applyPreviewB.json.data.preview.preview_id,
    ], memberBEnv);
    expect(applyResultB.exitCode).toBe(0);
    const agentsB = await fs.readFile(path.join(memberBRepos[0]!, 'AGENTS.md'), 'utf8');
    const claudeToCodex = agentsB.includes('Prefer focused tests before the full verify suite.')
      ? 'pass' as const
      : 'fail' as const;

    // --- Codex → Claude ---
    const capturePrepareB = await invoke([
      'capture', 'prepare', '--workspace', workspaceId, '--agent', 'codex',
      '--repository', 'github.com/acme/svc-0',
    ], memberBEnv);
    expect(capturePrepareB.exitCode).toBe(0);
    const packetB = capturePrepareB.json.data.packet;
    const proposalPathB = path.join(root, 'proposal-b.json');
    await fs.writeFile(
      proposalPathB,
      JSON.stringify(proposalFromPacket(
        packetB,
        'Keep generated instruction diffs easy to review.',
        ['claude-code', 'codex'],
        'AGENTS.md',
      )),
      'utf8',
    );
    const capturePreviewB = await invoke([
      'capture', 'preview', '--packet-id', packetB.packet_id, '--proposal', proposalPathB,
    ], memberBEnv);
    expect(capturePreviewB.exitCode).toBe(0);
    const captureApplyB = await invoke([
      'capture', 'apply', '--preview-id', capturePreviewB.json.data.preview.preview_id,
    ], memberBEnv);
    expect(captureApplyB.exitCode).toBe(0);

    const syncPrepareA = await invoke([
      'sync', 'prepare', '--workspace', workspaceId, '--agent', 'claude-code',
      '--repository', 'github.com/acme/svc-0',
    ], memberAEnv);
    expect(syncPrepareA.exitCode).toBe(0);
    await fs.rm(path.join(memberARepos[0]!, 'CLAUDE.md'));
    const applyPreviewA = await invoke([
      'apply', 'preview', '--workspace', workspaceId, '--agent', 'claude-code',
      '--repository', 'github.com/acme/svc-0',
    ], memberAEnv);
    expect(applyPreviewA.exitCode).toBe(0);
    const applyResultA = await invoke([
      'apply', 'apply', '--preview-id', applyPreviewA.json.data.preview.preview_id,
    ], memberAEnv);
    expect(applyResultA.exitCode).toBe(0);
    const claudeA = await fs.readFile(path.join(memberARepos[0]!, 'CLAUDE.md'), 'utf8');
    const codexToClaude = (
      claudeA.includes('Prefer focused tests before the full verify suite.')
      && claudeA.includes('Keep generated instruction diffs easy to review.')
    ) ? 'pass' as const : 'fail' as const;

    // --- check stale ---
    const staleStatement = 'Use TypeORM for persistence in svc-0.';
    // Seed a stale knowledge entry via a second capture-like path: write through check.
    // First capture a knowledge entry that will be marked stale.
    const captureStalePrepare = await invoke([
      'capture', 'prepare', '--workspace', workspaceId, '--agent', 'claude-code',
      '--repository', 'github.com/acme/svc-0',
    ], memberAEnv);
    expect(captureStalePrepare.exitCode).toBe(0);
    const stalePacket = captureStalePrepare.json.data.packet;
    const staleProposalPath = path.join(root, 'proposal-stale.json');
    await fs.writeFile(
      staleProposalPath,
      JSON.stringify(proposalFromPacket(
        stalePacket,
        staleStatement,
        ['claude-code', 'codex'],
        'CLAUDE.md',
      )),
      'utf8',
    );
    const staleCapturePreview = await invoke([
      'capture', 'preview', '--packet-id', stalePacket.packet_id, '--proposal', staleProposalPath,
    ], memberAEnv);
    expect(staleCapturePreview.exitCode).toBe(0);
    const staleCaptureApply = await invoke([
      'capture', 'apply', '--preview-id', staleCapturePreview.json.data.preview.preview_id,
    ], memberAEnv);
    expect(staleCaptureApply.exitCode).toBe(0);

    const checkPrepare = await invoke([
      'check', 'prepare', '--workspace', workspaceId, '--repository', 'github.com/acme/svc-0',
    ], memberAEnv);
    expect(checkPrepare.exitCode).toBe(0);
    const packets = checkPrepare.json.data.packets as Array<{
      packet_id: string;
      packet_hash: string;
      knowledge: { id: string; statement: string };
      files: Array<{
        path: string;
        start_line: number;
        end_line: number;
        content_hash: string;
      }>;
      dependencies: Array<{
        manifest_path: string;
        name: string;
        version: string;
        content_hash: string;
      }>;
    }>;
    const staleTarget = packets.find((packet) => packet.knowledge.statement === staleStatement)
      ?? packets[0];
    expect(staleTarget).toBeDefined();
    const dependency = staleTarget!.dependencies.find((item) => item.name === 'prisma')
      ?? staleTarget!.dependencies[0];
    const evidenceFile = staleTarget!.files.find((item) => item.path === 'package.json')
      ?? staleTarget!.files[0];
    expect(dependency).toBeDefined();
    expect(evidenceFile).toBeDefined();
    const verificationProposal = {
      schema_version: 1,
      packet_id: staleTarget!.packet_id,
      packet_hash: staleTarget!.packet_hash,
      findings: [{
        knowledge_id: staleTarget!.knowledge.id,
        status: 'stale',
        explanation: 'The statement no longer matches repository evidence.',
        evidence: [
          {
            type: 'dependency',
            repo_id: 'github.com/acme/svc-0',
            manifest_path: dependency!.manifest_path,
            name: dependency!.name,
            version: dependency!.version,
            content_hash: dependency!.content_hash,
          },
          {
            type: 'file',
            repo_id: 'github.com/acme/svc-0',
            path: evidenceFile!.path,
            start_line: evidenceFile!.start_line,
            end_line: evidenceFile!.end_line,
            content_hash: evidenceFile!.content_hash,
          },
        ],
        proposed_action: {
          type: 'archive',
          reason: 'Evidence shows the guidance is outdated.',
        },
      }],
    };
    const checkPreviewPath = path.join(root, 'check-proposal.json');
    await fs.writeFile(checkPreviewPath, JSON.stringify(verificationProposal), 'utf8');
    const checkPreview = await invoke([
      'check', 'preview',
      '--packet-id', staleTarget!.packet_id,
      '--proposal', checkPreviewPath,
    ], memberAEnv);
    if (checkPreview.exitCode !== 0) {
      throw new Error(`check preview failed: ${JSON.stringify(checkPreview.json)} stderr=${checkPreview.stderr}`);
    }
    const checkApply = await invoke([
      'check', 'apply', '--preview-id', checkPreview.json.data.preview.preview_id,
    ], memberAEnv);
    const staleRuleCheck = checkApply.exitCode === 0 ? 'pass' as const : 'fail' as const;

    // --- reconcile divergence (additive knowledge on both sides) ---
    const { parse: parseYaml } = await import('yaml');
    const memberALocal = parseYaml(
      await fs.readFile(path.join(memberAHome, 'workspaces', `${workspaceId}.yaml`), 'utf8'),
    ) as { context_path: string };
    const localContextPath = memberALocal.context_path;

    const rivalContextPath = path.join(root, 'rival-context');
    await fixtureGit(root, ['clone', daemon.remote, rivalContextPath]);
    await fixtureGit(rivalContextPath, ['config', 'user.name', 'Rival']);
    await fixtureGit(rivalContextPath, ['config', 'user.email', 'rival@example.invalid']);

    const { KnowledgeStore } = await import('../../src/knowledge/store.js');
    const now = '2026-07-11T12:00:00.000Z';
    const contentHash = `sha256:${'b'.repeat(64)}`;
    const localOnlyEntry = {
      schema_version: 1 as const,
      id: 'kn_01J0000000000000000000000M',
      kind: 'workflow' as const,
      scope: 'workspace' as const,
      status: 'active' as const,
      applies_to: { paths: ['apps/local/**'], agents: ['claude-code'] },
      source: {
        agent: 'claude-code' as const,
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
      statement: 'Local-only reconcile additive rule.',
      reason: 'Added only on local before fetch.',
    };
    const remoteOnlyEntry = {
      ...localOnlyEntry,
      id: 'kn_01J0000000000000000000000N',
      applies_to: { paths: ['apps/remote/**'], agents: ['codex'] },
      statement: 'Remote-only reconcile additive rule.',
      reason: 'Added only on remote before local fetch.',
      source: {
        ...localOnlyEntry.source,
        agent: 'codex' as const,
        locator: 'AGENTS.md',
      },
    };

    const localStore = new KnowledgeStore(localContextPath);
    await localStore.put(localOnlyEntry);
    await fixtureGit(localContextPath, ['add', 'knowledge']);
    await fixtureGit(localContextPath, ['commit', '-m', 'local additive knowledge']);

    const rivalStore = new KnowledgeStore(rivalContextPath);
    await rivalStore.put(remoteOnlyEntry);
    await fixtureGit(rivalContextPath, ['add', 'knowledge']);
    await fixtureGit(rivalContextPath, ['commit', '-m', 'remote additive knowledge']);
    await fixtureGit(rivalContextPath, ['push', 'origin', 'main']);
    await fixtureGit(localContextPath, ['fetch', 'origin']);

    const reconcilePrepare = await invoke([
      'reconcile', 'prepare', '--workspace', workspaceId,
    ], memberAEnv);
    expect(reconcilePrepare.exitCode).toBe(0);
    const reconcilePacket = reconcilePrepare.json.data.packet;
    const reconcilePreview = await invoke([
      'reconcile', 'preview',
      '--packet-id', reconcilePacket.packet_id,
      '--proposal', JSON.stringify({
        schema_version: 1,
        packet_id: reconcilePacket.packet_id,
        packet_hash: reconcilePacket.packet_hash,
        resolutions: [],
      }),
    ], memberAEnv);
    expect(reconcilePreview.exitCode).toBe(0);
    const reconcileApply = await invoke([
      'reconcile', 'apply', '--preview-id', reconcilePreview.json.data.preview.preview_id,
    ], memberAEnv);
    const divergentContextReconcile = reconcileApply.exitCode === 0
      ? 'pass' as const
      : 'fail' as const;

    const commitsAfterA = await businessCommitCount(memberARepos);
    const commitsAfterB = await businessCommitCount(memberBRepos);
    for (const [repo, head] of businessHeadsBefore) {
      // Generated files may change working tree, but HEAD must not advance from tool commits.
      expect(await fixtureGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
    }

    return {
      workspaceRepositories: WORKSPACE_REPOS,
      memberBRepositories: MEMBER_B_REPOS,
      claudeToCodex,
      codexToClaude,
      staleRuleCheck,
      divergentContextReconcile,
      businessCommitsCreatedByTool: (commitsAfterA - commitsBeforeA) + (commitsAfterB - commitsBeforeB),
    };
  } finally {
    await stopProcess(daemon.process);
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('passes the full MVP acceptance scenario', async () => {
  const result = await runMvpScenario();
  expect(result).toMatchObject({
    workspaceRepositories: WORKSPACE_REPOS,
    memberBRepositories: MEMBER_B_REPOS,
    claudeToCodex: 'pass',
    codexToClaude: 'pass',
    staleRuleCheck: 'pass',
    divergentContextReconcile: 'pass',
    businessCommitsCreatedByTool: 0,
  });
});
