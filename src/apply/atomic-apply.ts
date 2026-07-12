import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '../domain/compare.js';
import { appError } from '../domain/errors.js';
import { runGit } from '../git/run-git.js';
import {
  assertLocalContextCheckout,
  localHead,
  readWorkspaceManifest,
} from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import { withWorkspaceLock } from '../workspace/workspace-lock.js';
import { fileHashHex } from './drift.js';
import type { ApplyPreview, ApplyPreviewFile } from './preview.js';
import { claimApplyPreview, peekApplyPreview } from './preview-store.js';

export interface ApplyResult {
  readonly workspace_id: string;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
  readonly written: readonly { repo_id: string; relativePath: string }[];
}

async function readOptionalHash(file: string): Promise<string | null> {
  try {
    return fileHashHex(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function businessHead(repositoryPath: string): Promise<string> {
  const { stdout } = await runGit(repositoryPath, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function targetKey(repoId: string, relativePath: string): string {
  return `${repoId}::${relativePath}`;
}

async function assertPreviewStillFresh(
  preview: ApplyPreview,
  home: string,
): Promise<Map<string, string>> {
  const local = await readLocalWorkspace(home, preview.workspace_id);
  const contextPath = await assertLocalContextCheckout(
    home,
    preview.workspace_id,
    local.context_path,
  );
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== preview.workspace_id) {
    throw appError('STALE_PREVIEW', 'Workspace identity changed after preview generation');
  }

  const head = await localHead(contextPath);
  if (head !== preview.context_head) {
    throw appError('STALE_PREVIEW', 'Context HEAD changed after preview generation', {
      expected_head: preview.context_head,
      actual_head: head,
    });
  }

  const repositoryPaths = new Map<string, string>();
  for (const [repoId, expectedHead] of Object.entries(preview.business_heads)) {
    const repositoryPath = local.repository_paths[repoId];
    if (repositoryPath === undefined) {
      throw appError('STALE_PREVIEW', 'A bound repository disappeared after preview generation', {
        repo_id: repoId,
      });
    }
    const actualHead = await businessHead(repositoryPath);
    if (actualHead !== expectedHead) {
      throw appError('STALE_PREVIEW', 'Business repository HEAD changed after preview generation', {
        repo_id: repoId,
        expected_head: expectedHead,
        actual_head: actualHead,
      });
    }
    repositoryPaths.set(repoId, repositoryPath);
  }

  for (const [key, expectedHash] of Object.entries(preview.target_hashes)) {
    const separator = key.indexOf('::');
    if (separator <= 0) {
      throw appError('INVALID_PREVIEW', 'Stored apply preview target key is invalid');
    }
    const repoId = key.slice(0, separator);
    const relativePath = key.slice(separator + 2);
    const repositoryPath = repositoryPaths.get(repoId) ?? local.repository_paths[repoId];
    if (repositoryPath === undefined) {
      throw appError('STALE_PREVIEW', 'A target repository is no longer bound', { repo_id: repoId });
    }
    const absolutePath = path.join(repositoryPath, relativePath);
    const actualHash = await readOptionalHash(absolutePath);
    if (actualHash !== expectedHash) {
      throw appError('TARGET_DRIFT', 'A generated target changed after preview generation', {
        repo_id: repoId,
        relative_path: relativePath,
        expected_hash: expectedHash,
        actual_hash: actualHash,
      });
    }
  }

  return repositoryPaths;
}

async function backupFile(
  home: string,
  previewId: string,
  repoId: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const backupPath = path.join(
    home,
    'apply-backups',
    previewId,
    repoId,
    relativePath,
  );
  await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(backupPath, 'w', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplaceFile(absolutePath: string, contents: string): Promise<void> {
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  let renamed = false;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o644);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, absolutePath);
    renamed = true;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the write error.
      }
    }
    if (!renamed) {
      try {
        await fs.unlink(temporaryPath);
      } catch {
        // Preserve the write error.
      }
    }
    throw error;
  }
}

async function applyRepositoryFiles(
  home: string,
  preview: ApplyPreview,
  repoId: string,
  repositoryPath: string,
  files: readonly ApplyPreviewFile[],
): Promise<{ repo_id: string; relativePath: string }[]> {
  const written: { repo_id: string; relativePath: string }[] = [];
  for (const file of files) {
    if (file.action === 'unchanged') continue;
    const absolutePath = path.join(repositoryPath, file.relativePath);
    try {
      const existing = await fs.readFile(absolutePath, 'utf8');
      await backupFile(home, preview.preview_id, repoId, file.relativePath, existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicReplaceFile(absolutePath, file.generated_bytes);
    written.push({ repo_id: repoId, relativePath: file.relativePath });
  }
  return written;
}

async function applyApprovedPreview(
  preview: ApplyPreview,
  home: string,
): Promise<ApplyResult> {
  if (preview.drift_candidates.length > 0) {
    throw appError(
      'TARGET_DRIFT',
      'Apply preview includes drifted targets that must not be overwritten',
      {
        drift_candidates: preview.drift_candidates.map((item) => ({
          repo_id: item.repo_id,
          relative_path: item.relativePath,
          reason: item.reason,
        })),
      },
    );
  }

  const repositoryPaths = await assertPreviewStillFresh(preview, home);
  const byRepository = new Map<string, ApplyPreviewFile[]>();
  for (const file of preview.files) {
    const list = byRepository.get(file.repo_id) ?? [];
    list.push(file);
    byRepository.set(file.repo_id, list);
  }

  const repoIds = [...byRepository.keys()].sort(compareCodeUnits);
  const completed: string[] = [];
  const written: { repo_id: string; relativePath: string }[] = [];

  for (const repoId of repoIds) {
    const repositoryPath = repositoryPaths.get(repoId);
    if (repositoryPath === undefined) {
      throw appError('STALE_PREVIEW', 'A target repository is no longer bound', { repo_id: repoId });
    }
    const pending = repoIds.filter((id) => !completed.includes(id) && id !== repoId);
    try {
      const files = byRepository.get(repoId) ?? [];
      written.push(...await applyRepositoryFiles(home, preview, repoId, repositoryPath, files));
      completed.push(repoId);
    } catch (error) {
      throw appError(
        'APPLY_REPOSITORY_FAILED',
        'Atomic apply stopped after a business repository write failure',
        {
          failed_repo_id: repoId,
          completed,
          pending: [repoId, ...pending],
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  return {
    workspace_id: preview.workspace_id,
    completed,
    pending: [],
    written,
  };
}

/**
 * Claim an approved apply preview and atomically replace generated business files.
 * Never runs git add/commit/push in business repositories.
 */
export async function applyRendered(
  previewId: string,
  home: string,
): Promise<ApplyResult> {
  const resolvedHome = path.resolve(home);
  const pending = await peekApplyPreview(resolvedHome, previewId);
  return withWorkspaceLock(resolvedHome, pending.workspace_id, async () => {
    const preview = await claimApplyPreview(resolvedHome, previewId);
    return applyApprovedPreview(preview, resolvedHome);
  });
}
