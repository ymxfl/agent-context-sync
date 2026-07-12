import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { createBareRemote, fixtureGit, initFixtureRepository } from '../helpers/git.js';
import { invoke } from '../helpers/invoke.js';

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
      reason: 'Captured during the v0.2 bidirectional sync e2e.',
    }],
    rejected: [],
  };
}

it('syncs Claude knowledge to Codex and back across two homes', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'acs-v02-e2e-'));
  const daemon = await startGitDaemon(root);
  try {
    const memberAHome = path.join(root, 'member-a-acs');
    const memberAAgentHome = path.join(root, 'member-a-agent');
    const memberAScan = path.join(root, 'member-a-business');
    const apiA = path.join(memberAScan, 'api');
    await fs.mkdir(memberAAgentHome, { recursive: true });
    await initFixtureRepository(apiA, 'https://github.com/acme/api.git');
    await fs.writeFile(path.join(apiA, 'CLAUDE.md'), '# Claude API\n\nUse focused tests first.\n');
    const beforeA = await fixtureGit(apiA, ['log', '--oneline', '--all']);
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

    const capturePrepare = await invoke([
      'capture', 'prepare', '--workspace', workspaceId, '--agent', 'claude-code',
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
    const publishedCommit = captureApply.json.data.result.commit as string;
    expect(publishedCommit).toMatch(/^[0-9a-f]{40}$/);

    const memberBHome = path.join(root, 'member-b-acs');
    const memberBAgentHome = path.join(root, 'member-b-agent');
    const memberBScan = path.join(root, 'member-b-business');
    const apiB = path.join(memberBScan, 'api');
    await fs.mkdir(memberBAgentHome, { recursive: true });
    await initFixtureRepository(apiB, 'git@github.com:acme/api.git');
    await fs.writeFile(path.join(apiB, 'AGENTS.md'), '# Codex API\n\nKeep diffs reviewable.\n');
    const beforeB = await fixtureGit(apiB, ['log', '--oneline', '--all']);
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

    // Remove handwritten AGENTS.md so Codex render can create ACS-managed files.
    await fs.rm(path.join(apiB, 'AGENTS.md'));
    const applyPreviewB = await invoke([
      'apply', 'preview', '--workspace', workspaceId, '--agent', 'codex',
    ], memberBEnv);
    expect(applyPreviewB.exitCode).toBe(0);
    expect(applyPreviewB.json.data.preview.files.map(
      (file: { relativePath: string }) => file.relativePath,
    )).toContain('AGENTS.md');
    const applyResultB = await invoke([
      'apply', 'apply', '--preview-id', applyPreviewB.json.data.preview.preview_id,
    ], memberBEnv);
    expect(applyResultB.exitCode).toBe(0);
    const agentsB = await fs.readFile(path.join(apiB, 'AGENTS.md'), 'utf8');
    expect(agentsB).toContain('Generated by agent-context-sync');
    expect(agentsB).toContain('Prefer focused tests before the full verify suite.');
    expect(await fixtureGit(apiB, ['log', '--oneline', '--all'])).toBe(beforeB);

    const capturePrepareB = await invoke([
      'capture', 'prepare', '--workspace', workspaceId, '--agent', 'codex',
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

    // Pull Context updates on home A, then render Claude guidance.
    const syncPrepareA = await invoke([
      'sync', 'prepare', '--workspace', workspaceId, '--agent', 'claude-code',
    ], memberAEnv);
    expect(syncPrepareA.exitCode).toBe(0);

    await fs.rm(path.join(apiA, 'CLAUDE.md'));
    const applyPreviewA = await invoke([
      'apply', 'preview', '--workspace', workspaceId, '--agent', 'claude-code',
    ], memberAEnv);
    expect(applyPreviewA.exitCode).toBe(0);
    expect(applyPreviewA.json.data.preview.files.map(
      (file: { relativePath: string }) => file.relativePath,
    )).toContain('CLAUDE.md');
    const applyResultA = await invoke([
      'apply', 'apply', '--preview-id', applyPreviewA.json.data.preview.preview_id,
    ], memberAEnv);
    expect(applyResultA.exitCode).toBe(0);
    const claudeA = await fs.readFile(path.join(apiA, 'CLAUDE.md'), 'utf8');
    expect(claudeA).toContain('Generated by agent-context-sync');
    expect(claudeA).toContain('Prefer focused tests before the full verify suite.');
    expect(claudeA).toContain('Keep generated instruction diffs easy to review.');
    expect(await fixtureGit(apiA, ['log', '--oneline', '--all'])).toBe(beforeA);

    const remoteListing = await fixtureGit(root, ['ls-remote', daemon.remote]);
    const remoteHead = captureApplyB.json.data.result.commit as string;
    expect(remoteListing).toContain(remoteHead);
    const mirror = path.join(root, 'context-mirror');
    await fixtureGit(root, ['clone', daemon.remote, mirror]);
    const contextLog = await fixtureGit(mirror, ['log', '--format=%H']);
    expect(contextLog.split('\n')).toEqual(expect.arrayContaining([
      publishedCommit,
      remoteHead,
    ]));
  } finally {
    await stopProcess(daemon.process);
    await fs.rm(root, { recursive: true, force: true });
  }
});
