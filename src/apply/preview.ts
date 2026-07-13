import { createTwoFilesPatch } from 'diff';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentName, RenderedFile } from '../adapters/adapter.js';
import { renderClaude } from '../adapters/claude/render.js';
import { renderCodex } from '../adapters/codex/render.js';
import { compareCodeUnits } from '../domain/compare.js';
import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import { compileSections } from '../compiler/compile.js';
import { preflightContextRemote } from '../git/context-publisher.js';
import { runGit } from '../git/run-git.js';
import { KnowledgeStore } from '../knowledge/store.js';
import {
  assertLocalContextCheckout,
  localHead,
  readWorkspaceManifest,
} from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import {
  assessTarget,
  fileHashHex,
  normalizeGeneratedText,
} from './drift.js';
import { saveApplyPreview } from './preview-store.js';

export interface ApplyInput {
  workspaceId: string;
  agents: readonly AgentName[];
  home: string;
  repositories?: readonly string[];
}

export interface ApplyPreviewFile {
  readonly repo_id: string;
  readonly agent: AgentName;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly action: 'create' | 'replace' | 'unchanged';
  readonly current_hash: string | null;
  readonly generated_hash: string;
  readonly generated_bytes: string;
  readonly diff: string;
}

export interface ApplyDriftCandidate {
  readonly repo_id: string;
  readonly agent: AgentName;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly reason: 'missing_acs_header' | 'body_mismatch';
  readonly current_hash: string | null;
  readonly generated_hash: string;
  readonly diff: string;
}

/** Preview of compiled Agent files bound to Context and business repository state. */
export interface ApplyPreview {
  readonly preview_id: string;
  readonly workspace_id: string;
  readonly context_head: string;
  readonly business_heads: Readonly<Record<string, string>>;
  readonly target_hashes: Readonly<Record<string, string | null>>;
  readonly agents: readonly AgentName[];
  readonly files: readonly ApplyPreviewFile[];
  readonly drift_candidates: readonly ApplyDriftCandidate[];
  readonly warnings: readonly string[];
}

function renderForAgent(agent: AgentName, compiled: ReturnType<typeof compileSections>): RenderedFile[] {
  if (agent === 'claude-code') return renderClaude({ compiled });
  return renderCodex({ compiled });
}

function targetKey(repoId: string, relativePath: string): string {
  return `${repoId}::${relativePath}`;
}

async function readOptionalFile(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function businessHead(repositoryPath: string): Promise<string> {
  const { stdout } = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function unifiedDiff(
  relativePath: string,
  current: string | undefined,
  generated: string,
): string {
  return createTwoFilesPatch(
    relativePath,
    relativePath,
    current === undefined ? '' : normalizeGeneratedText(current),
    normalizeGeneratedText(generated),
  );
}

/**
 * Compile requested agents against local repositories, build complete diffs,
 * and persist a one-time authenticated preview. Never writes business files.
 */
export async function previewApply(input: ApplyInput): Promise<ApplyPreview> {
  const home = path.resolve(input.home);
  const agents = [...new Set(input.agents)].sort(compareCodeUnits) as AgentName[];
  if (agents.length === 0) {
    throw appError('INVALID_ARGUMENT', 'At least one agent is required for apply preview');
  }
  for (const agent of agents) {
    if (agent !== 'claude-code' && agent !== 'codex') {
      throw appError('INVALID_ARGUMENT', `Unsupported agent: ${agent}`);
    }
  }

  const local = await readLocalWorkspace(home, input.workspaceId);
  const contextPath = await assertLocalContextCheckout(
    home,
    input.workspaceId,
    local.context_path,
  );
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== input.workspaceId) {
    throw appError('INVALID_WORKSPACE', 'Workspace manifest does not match the requested workspace');
  }

  await preflightContextRemote(contextPath);
  const contextHead = await localHead(contextPath);
  const registeredRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));
  const store = new KnowledgeStore(contextPath, { registeredRepositoryIds });
  const entries = await store.list();

  const requestedRepos = input.repositories === undefined
    ? Object.keys(local.repository_paths).sort(compareCodeUnits)
    : [...input.repositories].sort(compareCodeUnits);

  const files: ApplyPreviewFile[] = [];
  const driftCandidates: ApplyDriftCandidate[] = [];
  const businessHeads: Record<string, string> = {};
  const targetHashes: Record<string, string | null> = {};
  const warnings: string[] = [];

  for (const repoId of requestedRepos) {
    const repositoryPath = local.repository_paths[repoId];
    if (repositoryPath === undefined) {
      warnings.push(`Skipping unbound repository ${repoId}`);
      continue;
    }
    if (!registeredRepositoryIds.has(repoId)) {
      warnings.push(`Skipping repository ${repoId} absent from the shared Workspace manifest`);
      continue;
    }

    businessHeads[repoId] = await businessHead(repositoryPath);

    for (const agent of agents) {
      const compiled = compileSections({
        entries,
        target: {
          repoId,
          agent,
          workspaceId: input.workspaceId,
          contextHead,
        },
      });
      const rendered = renderForAgent(agent, compiled);
      for (const file of rendered) {
        const absolutePath = path.join(repositoryPath, file.relativePath);
        const generatedBytes = Buffer.from(file.bytes).toString('utf8');
        const current = await readOptionalFile(absolutePath);
        const currentHash = current === undefined ? null : fileHashHex(current);
        const key = targetKey(repoId, file.relativePath);
        targetHashes[key] = currentHash;
        const assessment = assessTarget(current, generatedBytes);
        const diff = unifiedDiff(file.relativePath, current, generatedBytes);

        if (assessment.kind === 'drifted') {
          driftCandidates.push({
            repo_id: repoId,
            agent,
            relativePath: file.relativePath,
            absolutePath,
            reason: assessment.reason,
            current_hash: currentHash,
            generated_hash: file.sha256,
            diff,
          });
          continue;
        }

        files.push({
          repo_id: repoId,
          agent,
          relativePath: file.relativePath,
          absolutePath,
          action: assessment.kind === 'missing'
            ? 'create'
            : assessment.kind === 'clean'
              ? 'unchanged'
              : 'replace',
          current_hash: currentHash,
          generated_hash: file.sha256,
          generated_bytes: normalizeGeneratedText(generatedBytes),
          diff,
        });
      }
    }
  }

  files.sort((left, right) => (
    compareCodeUnits(left.repo_id, right.repo_id)
    || compareCodeUnits(left.agent, right.agent)
    || compareCodeUnits(left.relativePath, right.relativePath)
  ));
  driftCandidates.sort((left, right) => (
    compareCodeUnits(left.repo_id, right.repo_id)
    || compareCodeUnits(left.agent, right.agent)
    || compareCodeUnits(left.relativePath, right.relativePath)
  ));

  const preview: ApplyPreview = {
    preview_id: createId('preview'),
    workspace_id: input.workspaceId,
    context_head: contextHead,
    business_heads: businessHeads,
    target_hashes: targetHashes,
    agents,
    files,
    drift_candidates: driftCandidates,
    warnings,
  };
  await saveApplyPreview(home, preview);
  return preview;
}
