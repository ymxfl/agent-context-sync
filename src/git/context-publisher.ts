import * as fs from 'node:fs/promises';
import path from 'node:path';

import { appError } from '../domain/errors.js';
import { runGit } from './run-git.js';

/** Ahead/behind snapshot for a Context checkout after fetch. */
export interface ContextRemoteState {
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  diverged: boolean;
}

/** Result of publishing knowledge into Context Git. */
export interface PublishResult {
  commit: string;
  remote_state: ContextRemoteState;
}

const STAGE_PATHS = [
  'workspace.yaml',
  'repositories',
  'knowledge',
  'sources',
  'schema',
] as const;

async function configureCommitter(contextPath: string): Promise<void> {
  await runGit(contextPath, ['config', 'user.name', 'Agent Context Sync']);
  await runGit(contextPath, [
    'config',
    'user.email',
    'agent-context-sync@localhost.invalid',
  ]);
}

async function fetchOrigin(contextPath: string): Promise<void> {
  await runGit(contextPath, ['fetch', '--', 'origin']);
}

async function revParse(contextPath: string, rev: string): Promise<string> {
  const { stdout } = await runGit(contextPath, ['rev-parse', rev]);
  return stdout.trim();
}

async function countRevs(
  contextPath: string,
  range: string,
): Promise<number> {
  const { stdout } = await runGit(contextPath, [
    'rev-list',
    '--count',
    range,
  ]);
  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

async function upstreamRef(contextPath: string): Promise<string> {
  try {
    const { stdout } = await runGit(contextPath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);
    const ref = stdout.trim();
    if (ref.length > 0) return ref;
  } catch {
    // Fall through to origin/main when upstream is unset.
  }
  return 'refs/remotes/origin/main';
}

/** Fetch origin and compute ahead/behind/diverged for the current Context HEAD. */
export async function inspectContextRemoteState(
  contextPath: string,
): Promise<ContextRemoteState> {
  await fetchOrigin(contextPath);
  const head = await revParse(contextPath, 'HEAD');
  const upstreamName = await upstreamRef(contextPath);
  const upstream = await revParse(contextPath, upstreamName);
  const ahead = await countRevs(contextPath, `${upstreamName}..HEAD`);
  const behind = await countRevs(contextPath, `HEAD..${upstreamName}`);
  return {
    head,
    upstream,
    ahead,
    behind,
    diverged: ahead > 0 && behind > 0,
  };
}

/**
 * Fetch and reconcile the Context checkout before writes.
 * Fast-forwards when behind-only; rejects divergent history.
 */
export async function preflightContextRemote(
  contextPath: string,
): Promise<ContextRemoteState> {
  let state = await inspectContextRemoteState(contextPath);
  if (state.diverged) {
    throw appError(
      'CONTEXT_DIVERGED',
      'Context Git history diverged from origin; reconcile before publishing',
      {
        head: state.head,
        upstream: state.upstream,
        ahead: state.ahead,
        behind: state.behind,
        recovery: 'Fetch, reconcile divergent Context knowledge, then re-preview and retry.',
      },
    );
  }
  if (state.behind > 0 && state.ahead === 0) {
    const upstreamName = await upstreamRef(contextPath);
    await runGit(contextPath, ['merge', '--ff-only', upstreamName]);
    state = await inspectContextRemoteState(contextPath);
  }
  return state;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function stagePublishPaths(contextPath: string): Promise<void> {
  for (const relative of STAGE_PATHS) {
    if (await pathExists(path.join(contextPath, relative))) {
      await runGit(contextPath, ['add', '--', relative]);
    }
  }
}

function isNonFastForwardPushError(error: unknown): boolean {
  const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
    ? (error as { stderr: string }).stderr
    : '';
  const message = error instanceof Error ? error.message : String(error);
  const text = `${stderr}\n${message}`.toLowerCase();
  return text.includes('non-fast-forward')
    || text.includes('failed to push')
    || text.includes('fetch first')
    || text.includes('rejected');
}

/**
 * Stage Context knowledge paths, create one semantic commit, and push without force.
 * On a push race, preserves the local commit and throws REMOTE_CHANGED.
 */
export async function commitAndPushKnowledge(
  contextPath: string,
  message: string,
): Promise<PublishResult> {
  await configureCommitter(contextPath);
  await stagePublishPaths(contextPath);
  await runGit(contextPath, ['commit', '-m', message]);
  const commit = await revParse(contextPath, 'HEAD');
  try {
    await runGit(contextPath, ['push', 'origin', 'HEAD:refs/heads/main']);
  } catch (error) {
    if (isNonFastForwardPushError(error)) {
      throw appError(
        'REMOTE_CHANGED',
        'Context remote advanced during push; local commit was preserved',
        {
          commit,
          recovery: 'Fetch origin, reconcile or re-preview against the new HEAD, then retry without force push.',
        },
      );
    }
    throw error;
  }
  const remote_state = await inspectContextRemoteState(contextPath);
  return { commit, remote_state };
}
