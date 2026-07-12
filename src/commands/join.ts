import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import type { LocalWorkspace } from '../domain/model.js';
import {
  assertPreviewIntegrity,
  assertRemoteHead,
  cloneContext,
  contextCheckoutPath,
  previewInputHash,
  readWorkspaceManifest,
  remoteHead,
  validateContextRemote,
  type NormalizedJoinInput,
  type PreviewRepository,
  type WorkspacePreview,
  type WorkspaceResult,
} from '../workspace/context-repository.js';
import { writeLocalWorkspace } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';

export interface JoinInput {
  contextRemote: string;
  scanRoots: string[];
  maxDepth: number;
  home: string;
}

async function normalizeInput(input: JoinInput): Promise<NormalizedJoinInput> {
  if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }
  const roots = await Promise.all(
    input.scanRoots.map((root) => fs.realpath(path.resolve(root))),
  );
  return {
    context_remote: input.contextRemote.trim(),
    scan_roots: [...new Set(roots)].sort(),
    max_depth: input.maxDepth,
    home: path.resolve(input.home),
  };
}

export async function joinWorkspace(input: JoinInput): Promise<WorkspacePreview> {
  const normalized = await normalizeInput(input);
  validateContextRemote(normalized.context_remote);
  const contextHead = await remoteHead(normalized.context_remote);
  const temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'acs-join-preview-'));
  let workspace;
  try {
    const temporaryContext = path.join(temporaryRoot, 'context');
    await cloneContext(normalized.context_remote, temporaryContext);
    workspace = await readWorkspaceManifest(temporaryContext);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
  if (workspace.context_remote !== normalized.context_remote) {
    throw new Error('Context remote does not match workspace manifest');
  }

  const discovered = (await Promise.all(normalized.scan_roots.map((root) =>
    scanRepositories(root, { maxDepth: normalized.max_depth }),
  ))).flat();
  const localPaths = new Map<string, string>();
  for (const repository of discovered) {
    if (repository.repositoryId !== undefined && !localPaths.has(repository.repositoryId)) {
      localPaths.set(repository.repositoryId, repository.realPath);
    }
  }
  const repositories: PreviewRepository[] = workspace.repositories.map((repository) => ({
    ...repository,
    ...(localPaths.has(repository.repo_id)
      ? { local_path: localPaths.get(repository.repo_id) }
      : {}),
  }));
  const warnings = repositories
    .filter((repository) => repository.local_path === undefined)
    .map((repository) => `Repository ${repository.repo_id} is not available locally`);

  return {
    operation: 'join',
    preview_id: createId('preview'),
    input_hash: previewInputHash('join', normalized, contextHead),
    context_head: contextHead,
    workspace_id: workspace.workspace_id,
    normalized_input: normalized,
    files_to_write: [path.join(normalized.home, 'workspaces', `${workspace.workspace_id}.yaml`)],
    repositories,
    warnings,
  };
}

export async function applyJoin(preview: WorkspacePreview): Promise<WorkspaceResult> {
  if (preview.operation !== 'join') {
    throw new TypeError('Expected a join preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedJoinInput;
  await assertRemoteHead(input.context_remote, preview.context_head);
  const contextPath = contextCheckoutPath(input.home, preview.workspace_id);
  await cloneContext(input.context_remote, contextPath);
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== preview.workspace_id) {
    throw new Error('Workspace ID changed after preview generation');
  }
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
  return { workspace, local };
}
