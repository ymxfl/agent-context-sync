import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { compareCodeUnits } from '../domain/compare.js';
import { appError } from '../domain/errors.js';
import type { LocalWorkspace, WorkspaceManifest } from '../domain/model.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import {
  assertPreviewIntegrity,
  assertApprovedRepositoryBindings,
  assertRemoteHead,
  commitAndPushContext,
  contextCheckoutPath,
  createContextTransaction,
  installContextTransaction,
  previewInputHash,
  remoteHead,
  repositoryManifestFile,
  repositoryBindingHash,
  repositoryDisplayName,
  writeSharedManifests,
  type NormalizedInitInput,
  type PreviewRepository,
  type WorkspacePreview,
  type WorkspaceResult,
  UNBORN_HEAD,
} from '../workspace/context-repository.js';
import { writeLocalWorkspace } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';
import { canonicalRemote } from '../workspace/repository-id.js';
import { claimPreview, peekPreview, savePreview } from '../workspace/preview-store.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';

export interface InitInput {
  name: string;
  contextRemote: string;
  scanRoot: string;
  maxDepth: number;
  home: string;
  bindings?: Readonly<Record<string, string>>;
}

function validateInitInput(input: NormalizedInitInput, workspaceId: string): void {
  parseWorkspaceManifest({
    schema_version: 1,
    workspace_id: workspaceId,
    name: input.name,
    context_remote: input.context_remote,
    repositories: [],
  });
  if (!Number.isInteger(input.max_depth) || input.max_depth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }
}

async function normalizeInput(input: InitInput): Promise<NormalizedInitInput> {
  return {
    name: input.name.trim(),
    context_remote: canonicalRemote(input.contextRemote),
    scan_root: await fs.realpath(path.resolve(input.scanRoot)),
    max_depth: input.maxDepth,
    home: path.resolve(input.home),
  };
}

export async function initWorkspace(input: InitInput): Promise<WorkspacePreview> {
  const workspaceId = createId('ws');
  const normalized = await normalizeInput(input);
  validateInitInput(normalized, workspaceId);
  const contextHead = await remoteHead(normalized.context_remote);
  if (contextHead !== UNBORN_HEAD) {
    throw appError(
      'CONTEXT_NOT_EMPTY',
      'Context repository must be empty before initialization',
    );
  }
  const discovered = await scanRepositories(normalized.scan_root, {
    maxDepth: normalized.max_depth,
  });
  const warnings: string[] = [];
  const byIdentity = new Map<string, typeof discovered>();
  for (const repository of discovered) {
    if (repository.repositoryId === undefined) {
      warnings.push(`Repository ${repository.realPath} has no supported origin remote`);
      continue;
    }
    const candidates = byIdentity.get(repository.repositoryId) ?? [];
    candidates.push(repository);
    byIdentity.set(repository.repositoryId, candidates);
  }
  const requestedBindings = input.bindings ?? {};
  const repositories: PreviewRepository[] = [];
  for (const [repoId, candidates] of byIdentity) {
    const candidatePaths = candidates.map((candidate) => candidate.realPath).sort(compareCodeUnits);
    const requested = requestedBindings[repoId] === undefined
      ? undefined
      : await fs.realpath(path.resolve(requestedBindings[repoId] as string));
    if (requested !== undefined && !candidatePaths.includes(requested)) {
      throw appError('INVALID_BINDING', 'Explicit binding is not one of the discovered candidates', { repo_id: repoId });
    }
    const selected = requested === undefined
      ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find((candidate) => candidate.realPath === requested);
    if (selected === undefined) {
      warnings.push(`Repository ${repoId} has ambiguous clone candidates; rerun preview with an explicit binding`);
    }
    repositories.push({
      schema_version: 1,
      repo_id: repoId,
      name: repositoryDisplayName(repoId),
      ...(selected === undefined ? {} : {
        local_path: selected.realPath,
        binding_hash: repositoryBindingHash(selected),
      }),
      ...(candidates.length < 2 ? {} : { candidate_paths: candidatePaths }),
    });
  }
  repositories.sort((left, right) => compareCodeUnits(left.repo_id, right.repo_id));

  const filesToWrite = [
    'workspace.yaml',
    ...repositories.map((repository) => repositoryManifestFile(repository.repo_id)),
    path.join(normalized.home, 'workspaces', `${workspaceId}.yaml`),
  ];
  const approval = {
    workspace_id: workspaceId,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  const preview: WorkspacePreview = {
    operation: 'init',
    preview_id: createId('preview'),
    input_hash: previewInputHash('init', normalized, contextHead, approval),
    context_head: contextHead,
    workspace_id: workspaceId,
    normalized_input: normalized,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  await savePreview(normalized.home, preview);
  return preview;
}

async function applyApprovedInit(preview: WorkspacePreview): Promise<WorkspaceResult> {
  if (preview.operation !== 'init') {
    throw new TypeError('Expected an init preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedInitInput;
  validateInitInput(input, preview.workspace_id);
  await assertApprovedRepositoryBindings(preview);
  await assertRemoteHead(input.context_remote, preview.context_head);

  const repositories = preview.repositories.map(({
    local_path: _localPath,
    candidate_paths: _candidatePaths,
    binding_hash: _bindingHash,
    ...item
  }) => item);
  const workspace: WorkspaceManifest = parseWorkspaceManifest({
    schema_version: 1,
    workspace_id: preview.workspace_id,
    name: input.name,
    context_remote: input.context_remote,
    repositories,
  });
  const contextPath = contextCheckoutPath(input.home, preview.workspace_id);
  const transaction = await createContextTransaction(
    input.home,
    input.context_remote,
    preview.context_head,
  );
  let commit: string;
  try {
    await writeSharedManifests(transaction.context_path, workspace, repositories);
    commit = await commitAndPushContext(
      transaction.context_path,
      `Initialize ${workspace.name} workspace`,
    );
    await installContextTransaction(transaction.context_path, contextPath);
  } finally {
    await fs.rm(transaction.root, { recursive: true, force: true });
  }
  const repositoryPaths: Record<string, string> = {};
  for (const repository of preview.repositories) {
    if (repository.local_path !== undefined) {
      repositoryPaths[repository.repo_id] = repository.local_path;
    }
  }
  const local: LocalWorkspace = {
    schema_version: 1,
    workspace_id: workspace.workspace_id,
    context_path: await fs.realpath(contextPath),
    repository_paths: repositoryPaths,
  };
  await writeLocalWorkspace(input.home, local);
  return { workspace, local, commit };
}

export async function applyInit(previewId: string, home: string): Promise<WorkspaceResult> {
  const pending = await peekPreview(home, previewId, 'init');
  return withWorkspaceLock(home, pending.workspace_id, async () => {
    const preview = await claimPreview(home, previewId, 'init');
    return applyApprovedInit(preview);
  });
}
