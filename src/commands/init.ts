import * as fs from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { appError } from '../domain/errors.js';
import type { LocalWorkspace, WorkspaceManifest } from '../domain/model.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import {
  assertPreviewIntegrity,
  assertRemoteHead,
  cloneContext,
  commitAndPushContext,
  contextCheckoutPath,
  previewInputHash,
  remoteHead,
  repositoryManifestFile,
  writeSharedManifests,
  type NormalizedInitInput,
  type PreviewRepository,
  type WorkspacePreview,
  type WorkspaceResult,
  UNBORN_HEAD,
} from '../workspace/context-repository.js';
import { writeLocalWorkspace } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';

export interface InitInput {
  name: string;
  contextRemote: string;
  scanRoot: string;
  maxDepth: number;
  home: string;
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
    context_remote: input.contextRemote.trim(),
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
  const repositories: PreviewRepository[] = [];
  for (const repository of discovered) {
    if (repository.repositoryId === undefined) {
      warnings.push(`Repository ${repository.realPath} has no supported origin remote`);
      continue;
    }
    repositories.push({
      schema_version: 1,
      repo_id: repository.repositoryId,
      name: path.basename(repository.realPath),
      local_path: repository.realPath,
    });
  }
  repositories.sort((left, right) => left.repo_id.localeCompare(right.repo_id));

  return {
    operation: 'init',
    preview_id: createId('preview'),
    input_hash: previewInputHash('init', normalized, contextHead),
    context_head: contextHead,
    workspace_id: workspaceId,
    normalized_input: normalized,
    files_to_write: [
      'workspace.yaml',
      ...repositories.map((repository) => repositoryManifestFile(repository.repo_id)),
      path.join(normalized.home, 'workspaces', `${workspaceId}.yaml`),
    ],
    repositories,
    warnings,
  };
}

export async function applyInit(preview: WorkspacePreview): Promise<WorkspaceResult> {
  if (preview.operation !== 'init') {
    throw new TypeError('Expected an init preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedInitInput;
  validateInitInput(input, preview.workspace_id);
  await assertRemoteHead(input.context_remote, preview.context_head);

  const repositories = preview.repositories.map(({ local_path: _localPath, ...item }) => item);
  const workspace: WorkspaceManifest = parseWorkspaceManifest({
    schema_version: 1,
    workspace_id: preview.workspace_id,
    name: input.name,
    context_remote: input.context_remote,
    repositories,
  });
  const contextPath = contextCheckoutPath(input.home, preview.workspace_id);
  await cloneContext(input.context_remote, contextPath);
  await writeSharedManifests(contextPath, workspace, repositories);
  const commit = await commitAndPushContext(
    contextPath,
    `Initialize ${workspace.name} workspace`,
  );
  const local: LocalWorkspace = {
    schema_version: 1,
    workspace_id: workspace.workspace_id,
    context_path: await fs.realpath(contextPath),
    repository_paths: Object.fromEntries(
      preview.repositories
        .filter((repository) => repository.local_path !== undefined)
        .map((repository) => [repository.repo_id, repository.local_path as string]),
    ),
  };
  await writeLocalWorkspace(input.home, local);
  return { workspace, local, commit };
}
