import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import type { WorkspaceManifest } from '../domain/model.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import {
  assertPreviewIntegrity,
  assertLocalContextCheckout,
  assertRemoteHead,
  commitAndPushContext,
  createContextTransaction,
  installContextTransaction,
  previewInputHash,
  readWorkspaceManifest,
  remoteHead,
  repositoryManifestFile,
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

export interface AddRepositoryInput {
  workspaceId: string;
  repositoryPath: string;
  home: string;
}

async function normalizeInput(
  input: AddRepositoryInput,
): Promise<NormalizedAddRepositoryInput> {
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
    name: path.basename(repository.realPath),
    local_path: repository.realPath,
  };
}

export async function addRepository(
  input: AddRepositoryInput,
): Promise<WorkspacePreview> {
  const normalized = await normalizeInput(input);
  const local = await readLocalWorkspace(normalized.home, normalized.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    normalized.home,
    normalized.workspace_id,
    local.context_path,
  );
  const localWorkspace = await readWorkspaceManifest(contextPath);
  const contextHead = await remoteHead(localWorkspace.context_remote);
  const transaction = await createContextTransaction(
    normalized.home,
    localWorkspace.context_remote,
    contextHead,
  );
  let workspace;
  try {
    workspace = await readWorkspaceManifest(transaction.context_path);
  } finally {
    await fs.rm(transaction.root, { recursive: true, force: true });
  }
  if (workspace.workspace_id !== normalized.workspace_id) {
    throw new Error('Workspace ID does not match the local registry');
  }
  const added = await repositoryAt(normalized.repository_path);
  const repositories: PreviewRepository[] = [
    ...workspace.repositories.map((repository) => ({
      ...repository,
      ...(local.repository_paths[repository.repo_id] === undefined
        ? {}
        : { local_path: local.repository_paths[repository.repo_id] }),
    })),
  ];
  const existing = repositories.find((repository) => repository.repo_id === added.repo_id);
  if (existing === undefined) {
    repositories.push(added);
  } else {
    existing.local_path = added.local_path;
  }
  repositories.sort((left, right) => left.repo_id.localeCompare(right.repo_id));
  const filesToWrite = [
    'workspace.yaml',
    repositoryManifestFile(added.repo_id),
    path.join(normalized.home, 'workspaces', `${workspace.workspace_id}.yaml`),
  ];
  const warnings = existing === undefined
    ? []
    : [`Repository ${added.repo_id} is already shared`];
  const approval = {
    workspace_id: workspace.workspace_id,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  return {
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
}

export async function applyAddRepository(
  preview: WorkspacePreview,
): Promise<WorkspaceResult> {
  if (preview.operation !== 'add-repository') {
    throw new TypeError('Expected an add-repository preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedAddRepositoryInput;
  const local = await readLocalWorkspace(input.home, input.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    input.home,
    input.workspace_id,
    local.context_path,
  );
  const localWorkspace = await readWorkspaceManifest(contextPath);
  await assertRemoteHead(localWorkspace.context_remote, preview.context_head);
  const added = await repositoryAt(input.repository_path);
  const transaction = await createContextTransaction(
    input.home,
    localWorkspace.context_remote,
    preview.context_head,
  );
  let workspace: WorkspaceManifest;
  let commit: string;
  try {
    const current = await readWorkspaceManifest(transaction.context_path);
    const repositories = preview.repositories.map(
      ({ local_path: _localPath, ...item }) => item,
    );
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
