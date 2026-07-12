import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import type { WorkspaceManifest } from '../domain/model.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import {
  assertPreviewIntegrity,
  assertRemoteHead,
  commitAndPushContext,
  localHead,
  previewInputHash,
  readWorkspaceManifest,
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
  const workspace = await readWorkspaceManifest(local.context_path);
  const contextHead = await localHead(local.context_path);
  await assertRemoteHead(workspace.context_remote, contextHead);
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
  return {
    operation: 'add-repository',
    preview_id: createId('preview'),
    input_hash: previewInputHash('add-repository', normalized, contextHead),
    context_head: contextHead,
    workspace_id: workspace.workspace_id,
    normalized_input: normalized,
    files_to_write: [
      'workspace.yaml',
      repositoryManifestFile(added.repo_id),
      path.join(normalized.home, 'workspaces', `${workspace.workspace_id}.yaml`),
    ],
    repositories,
    warnings: existing === undefined ? [] : [`Repository ${added.repo_id} is already shared`],
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
  if (await localHead(local.context_path) !== preview.context_head) {
    throw appError(
      'STALE_PREVIEW',
      'Local Context HEAD changed after preview generation',
    );
  }
  const current = await readWorkspaceManifest(local.context_path);
  await assertRemoteHead(current.context_remote, preview.context_head);
  const added = await repositoryAt(input.repository_path);
  const repositories = preview.repositories.map(({ local_path: _localPath, ...item }) => item);
  const workspace: WorkspaceManifest = parseWorkspaceManifest({
    ...current,
    repositories,
  });
  await writeSharedManifests(local.context_path, workspace, [added]);
  const commit = await commitAndPushContext(
    local.context_path,
    `Add ${added.name} repository`,
  );
  const updatedLocal = bindRepositoryPath(local, added.repo_id, input.repository_path);
  await writeLocalWorkspace(input.home, updatedLocal);
  return { workspace, local: updatedLocal, commit };
}
