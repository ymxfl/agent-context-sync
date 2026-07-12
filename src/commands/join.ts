import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createId } from '../domain/ids.js';
import { compareCodeUnits } from '../domain/compare.js';
import { appError } from '../domain/errors.js';
import type { LocalWorkspace } from '../domain/model.js';
import {
  assertPreviewIntegrity,
  assertApprovedRepositoryBindings,
  assertRemoteHead,
  cloneContext,
  contextCheckoutPath,
  createContextTransaction,
  installContextTransaction,
  previewInputHash,
  readWorkspaceManifest,
  repositoryBindingHash,
  remoteHead,
  validateContextRemote,
  type NormalizedJoinInput,
  type PreviewRepository,
  type WorkspacePreview,
  type WorkspaceResult,
} from '../workspace/context-repository.js';
import { writeLocalWorkspace } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';
import { canonicalRemote } from '../workspace/repository-id.js';
import { claimPreview, peekPreview, savePreview } from '../workspace/preview-store.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';

export interface JoinInput {
  contextRemote: string;
  scanRoots: string[];
  maxDepth: number;
  home: string;
  bindings?: Readonly<Record<string, string>>;
}

async function normalizeInput(input: JoinInput): Promise<NormalizedJoinInput> {
  if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }
  const roots = await Promise.all(
    input.scanRoots.map((root) => fs.realpath(path.resolve(root))),
  );
  return {
    context_remote: canonicalRemote(input.contextRemote),
    scan_roots: [...new Set(roots)].sort(compareCodeUnits),
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
    await cloneContext(normalized.context_remote, temporaryContext, contextHead);
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
  const localPaths = new Map<string, typeof discovered>();
  for (const repository of discovered) {
    if (repository.repositoryId === undefined) continue;
    const candidates = localPaths.get(repository.repositoryId) ?? [];
    if (!candidates.some((candidate) => candidate.realPath === repository.realPath)) candidates.push(repository);
    localPaths.set(repository.repositoryId, candidates);
  }
  const warnings: string[] = [];
  const repositories: PreviewRepository[] = [];
  for (const repository of workspace.repositories) {
    const candidates = localPaths.get(repository.repo_id) ?? [];
    const candidatePaths = candidates.map((candidate) => candidate.realPath).sort(compareCodeUnits);
    const requestedRaw = input.bindings?.[repository.repo_id];
    const requested = requestedRaw === undefined
      ? undefined
      : await fs.realpath(path.resolve(requestedRaw));
    if (requested !== undefined && !candidatePaths.includes(requested)) {
      throw appError(
        'INVALID_BINDING',
        'Explicit binding is not one of the discovered candidates',
        { repo_id: repository.repo_id, candidate_paths: candidatePaths },
      );
    }
    const selected = requested === undefined
      ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find((candidate) => candidate.realPath === requested);
    if (candidates.length === 0) warnings.push(`Repository ${repository.repo_id} is not available locally`);
    else if (selected === undefined) warnings.push(`Repository ${repository.repo_id} has ambiguous clone candidates; rerun preview with an explicit binding`);
    repositories.push({
      ...repository,
      ...(selected === undefined ? {} : {
        local_path: selected.realPath,
        binding_hash: repositoryBindingHash(selected),
      }),
      ...(candidates.length < 2 ? {} : { candidate_paths: candidatePaths }),
    });
  }

  const filesToWrite = [
    path.join(normalized.home, 'workspaces', `${workspace.workspace_id}.yaml`),
  ];
  const approval = {
    workspace_id: workspace.workspace_id,
    files_to_write: filesToWrite,
    repositories,
    warnings,
  };
  const preview: WorkspacePreview = {
    operation: 'join',
    preview_id: createId('preview'),
    input_hash: previewInputHash('join', normalized, contextHead, approval),
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

async function applyApprovedJoin(preview: WorkspacePreview): Promise<WorkspaceResult> {
  if (preview.operation !== 'join') {
    throw new TypeError('Expected a join preview');
  }
  assertPreviewIntegrity(preview);
  const input = preview.normalized_input as NormalizedJoinInput;
  await assertApprovedRepositoryBindings(preview);
  await assertRemoteHead(input.context_remote, preview.context_head);
  const contextPath = contextCheckoutPath(input.home, preview.workspace_id);
  const transaction = await createContextTransaction(
    input.home,
    input.context_remote,
    preview.context_head,
  );
  let workspace;
  try {
    workspace = await readWorkspaceManifest(transaction.context_path);
    if (workspace.workspace_id !== preview.workspace_id) {
      throw new Error('Workspace ID changed after preview generation');
    }
    await assertRemoteHead(input.context_remote, preview.context_head);
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
  return { workspace, local };
}

export async function applyJoin(previewId: string, home: string): Promise<WorkspaceResult> {
  const pending = await peekPreview(home, previewId, 'join');
  return withWorkspaceLock(home, pending.workspace_id, async () => {
    const preview = await claimPreview(home, previewId, 'join');
    return applyApprovedJoin(preview);
  });
}
