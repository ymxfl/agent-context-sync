import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { compareCodeUnits } from '../domain/compare.js';
import { appError } from '../domain/errors.js';
import type { WorkspaceManifest } from '../domain/model.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import {
  assertPreviewIntegrity,
  assertApprovedRepositoryBindings,
  assertLocalContextCheckout,
  assertRemoteHead,
  commitAndPushContext,
  createContextTransaction,
  installContextTransaction,
  previewInputHash,
  readWorkspaceManifest,
  remoteHead,
  repositoryManifestFile,
  repositoryBindingHash,
  repositoryDisplayName,
  workspaceManifestHash,
  writeSharedManifests,
  type NormalizedAddRepositoryInput,
  type PreviewRepository,
  type WorkspacePreview,
  type WorkspaceResult,
} from '../workspace/context-repository.js';
import {
  bindRepositoryPath,
  readLocalWorkspace,
  writeLocalWorkspace,
} from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';
import { canonicalRemote } from '../workspace/repository-id.js';
import { claimPreview, peekPreview, savePreview } from '../workspace/preview-store.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';

export interface AddRepositoryInput {
  workspaceId: string;
  repositoryPath: string;
  home: string;
}

async function normalizeInput(
  input: AddRepositoryInput,
): Promise<Pick<NormalizedAddRepositoryInput, 'workspace_id' | 'repository_path' | 'home'>> {
  return {
    workspace_id: input.workspaceId,
    repository_path: await fs.realpath(path.resolve(input.repositoryPath)),
    home: path.resolve(input.home),
  };
}

async function repositoryAt(repositoryPath: string): Promise<PreviewRepository> {
  const [repository] = await scanRepositories(repositoryPath, { maxDepth: 0 });
  if (repository?.realPath !== repositoryPath || repository.repositoryId === undefined) {
    throw new Error('Repository must be a Git repository with a supported origin remote');
  }
  return {
    schema_version: 1,
    repo_id: repository.repositoryId,
    name: repositoryDisplayName(repository.repositoryId),
    local_path: repository.realPath,
    binding_hash: repositoryBindingHash(repository),
  };
}

function approvedContextManifestMatches(
  workspace: WorkspaceManifest,
  input: Pick<NormalizedAddRepositoryInput, 'workspace_id' | 'context_remote' | 'workspace_manifest_hash'>,
): boolean {
  try {
    return workspace.workspace_id === input.workspace_id
      && canonicalRemote(workspace.context_remote) === input.context_remote
      && workspaceManifestHash(workspace) === input.workspace_manifest_hash;
  } catch {
    return false;
  }
}

export async function addRepository(
  input: AddRepositoryInput,
): Promise<WorkspacePreview> {
  const baseInput = await normalizeInput(input);
  const local = await readLocalWorkspace(baseInput.home, baseInput.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    baseInput.home,
    baseInput.workspace_id,
    local.context_path,
  );
  const localWorkspace = await readWorkspaceManifest(contextPath);
  const approvedRemote = canonicalRemote(localWorkspace.context_remote);
  const approvedManifestHash = workspaceManifestHash(localWorkspace);
  if (localWorkspace.workspace_id !== baseInput.workspace_id) {
    throw appError('STALE_PREVIEW', 'Local Context manifest identity does not match the registry');
  }
  const contextHead = await remoteHead(approvedRemote);
  const transaction = await createContextTransaction(
    baseInput.home,
    approvedRemote,
    contextHead,
  );
  let workspace;
  try {
    workspace = await readWorkspaceManifest(transaction.context_path);
  } finally {
    await fs.rm(transaction.root, { recursive: true, force: true });
  }
  if (
    workspace.workspace_id !== baseInput.workspace_id
    || canonicalRemote(workspace.context_remote) !== approvedRemote
    || workspaceManifestHash(workspace) !== approvedManifestHash
  ) {
    throw appError('STALE_PREVIEW', 'Local and remote Context manifests do not match');
  }
  const added = await repositoryAt(baseInput.repository_path);
  const repositories: PreviewRepository[] = [];
  for (const repository of workspace.repositories) {
    const localPath = local.repository_paths[repository.repo_id];
    if (localPath === undefined) repositories.push(repository);
    else {
      const binding = await repositoryAt(localPath);
      if (binding.repo_id !== repository.repo_id) {
        throw appError('REPOSITORY_ID_DRIFT', 'A registered repository no longer matches its shared identity', {
          repo_id: repository.repo_id,
        });
      }
      repositories.push({ ...repository, ...binding, name: repository.name });
    }
  }
  const existing = repositories.find((repository) => repository.repo_id === added.repo_id);
  if (existing === undefined) {
    repositories.push(added);
  } else {
    existing.local_path = added.local_path;
    existing.binding_hash = added.binding_hash;
  }
  repositories.sort((left, right) => compareCodeUnits(left.repo_id, right.repo_id));
  const previousRepositoryPath = local.repository_paths[added.repo_id] === undefined
    ? null
    : await fs.realpath(local.repository_paths[added.repo_id] as string);
  const mode: NormalizedAddRepositoryInput['mode'] = existing === undefined
    ? 'add-shared'
    : 'bind-existing';
  const normalized: NormalizedAddRepositoryInput = {
    ...baseInput,
    context_remote: approvedRemote,
    workspace_manifest_hash: approvedManifestHash,
    mode,
    repository_id: added.repo_id,
    previous_repository_path: previousRepositoryPath,
  };
  const registryTarget = path.join(
    normalized.home,
    'workspaces',
    `${workspace.workspace_id}.yaml`,
  );
  const alreadyBound = mode === 'bind-existing'
    && previousRepositoryPath === added.local_path;
  const filesToWrite = mode === 'add-shared'
    ? ['workspace.yaml', repositoryManifestFile(added.repo_id), registryTarget]
    : alreadyBound ? [] : [registryTarget];
  const warnings = mode === 'add-shared'
    ? []
    : alreadyBound
      ? [`Repository ${added.repo_id} is already bound to ${added.local_path}`]
      : [`Repository ${added.repo_id} is already shared and will be bound locally`];
  const approval = {
    workspace_id: workspace.workspace_id,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  const preview: WorkspacePreview = {
    operation: 'add-repository',
    preview_id: createId('preview'),
    input_hash: previewInputHash('add-repository', normalized, contextHead, approval),
    context_head: contextHead,
    workspace_id: workspace.workspace_id,
    normalized_input: normalized,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  await savePreview(normalized.home, preview);
  return preview;
}

async function applyApprovedAddRepository(
  preview: WorkspacePreview,
): Promise<WorkspaceResult> {
  if (preview.operation !== 'add-repository') {
    throw new TypeError('Expected an add-repository preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedAddRepositoryInput;
  await assertApprovedRepositoryBindings(preview);
  const local = await readLocalWorkspace(input.home, input.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    input.home,
    input.workspace_id,
    local.context_path,
  );
  let localWorkspace: WorkspaceManifest;
  try {
    localWorkspace = await readWorkspaceManifest(contextPath);
  } catch {
    throw appError('STALE_PREVIEW', 'Local Context manifest changed after preview');
  }
  if (!approvedContextManifestMatches(localWorkspace, input)) {
    throw appError('STALE_PREVIEW', 'Local Context manifest changed after preview');
  }
  await assertRemoteHead(input.context_remote, preview.context_head);
  const added = await repositoryAt(input.repository_path);
  if (added.repo_id !== input.repository_id) {
    throw appError('STALE_PREVIEW', 'Approved repository binding changed after preview', {
      repo_id: input.repository_id,
    });
  }
  const currentPreviousPath = local.repository_paths[input.repository_id] === undefined
    ? null
    : await fs.realpath(local.repository_paths[input.repository_id] as string).catch(() => undefined);
  if (currentPreviousPath === undefined || currentPreviousPath !== input.previous_repository_path) {
    throw appError('STALE_PREVIEW', 'Local repository binding changed after preview', {
      repo_id: input.repository_id,
    });
  }
  const sharedRepository = localWorkspace.repositories.find(
    (repository) => repository.repo_id === input.repository_id,
  );
  if (input.mode === 'bind-existing') {
    if (sharedRepository === undefined) {
      throw appError('STALE_PREVIEW', 'Repository is no longer shared by the Workspace', {
        repo_id: input.repository_id,
      });
    }
    if (currentPreviousPath === input.repository_path) {
      return { workspace: localWorkspace, local };
    }
    const updatedLocal = bindRepositoryPath(local, input.repository_id, input.repository_path);
    await writeLocalWorkspace(input.home, updatedLocal);
    return { workspace: localWorkspace, local: updatedLocal };
  }
  if (sharedRepository !== undefined) {
    throw appError('STALE_PREVIEW', 'Repository became shared after preview', {
      repo_id: input.repository_id,
    });
  }
  const transaction = await createContextTransaction(
    input.home,
    input.context_remote,
    preview.context_head,
  );
  let workspace: WorkspaceManifest;
  let commit: string;
  try {
    let current: WorkspaceManifest;
    try {
      current = await readWorkspaceManifest(transaction.context_path);
    } catch {
      throw appError('STALE_PREVIEW', 'Remote Context manifest changed after preview');
    }
    if (!approvedContextManifestMatches(current, input)) {
      throw appError('STALE_PREVIEW', 'Remote Context manifest changed after preview');
    }
    const repositories = preview.repositories.map(({
      local_path: _localPath,
      candidate_paths: _candidatePaths,
      binding_hash: _bindingHash,
      ...item
    }) => item);
    workspace = parseWorkspaceManifest({ ...current, repositories });
    await writeSharedManifests(transaction.context_path, workspace, [added]);
    commit = await commitAndPushContext(
      transaction.context_path,
      `Add ${added.name} repository`,
    );
    await installContextTransaction(transaction.context_path, contextPath);
  } finally {
    await fs.rm(transaction.root, { recursive: true, force: true });
  }
  const updatedLocal = bindRepositoryPath(local, added.repo_id, input.repository_path);
  await writeLocalWorkspace(input.home, updatedLocal);
  return { workspace, local: updatedLocal, commit };
}

export async function applyAddRepository(
  previewId: string,
  home: string,
): Promise<WorkspaceResult> {
  const pending = await peekPreview(home, previewId, 'add-repository');
  return withWorkspaceLock(home, pending.workspace_id, async () => {
    const preview = await claimPreview(home, previewId, 'add-repository');
    return applyApprovedAddRepository(preview);
  });
}
