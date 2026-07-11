import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { runGit } from '../git/run-git.js';
import { repositoryIdFromRemote } from './repository-id.js';

export interface DiscoveredRepository {
  localPath: string;
  realPath: string;
  encounteredViaSymlink: boolean;
  remote?: string;
  repositoryId?: string;
}

const ignoredDirectories = new Set(['.git', 'node_modules']);

function isInsideIgnoredDirectory(directory: string): boolean {
  return directory.split(path.sep).some((part) => ignoredDirectories.has(part));
}

function isDescendantOf(directory: string, parent: string): boolean {
  const relative = path.relative(parent, directory);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function isRepository(directory: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readOrigin(directory: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(directory, ['config', '--get', 'remote.origin.url']);
    const remote = stdout.trim();
    return remote.length === 0 ? undefined : remote;
  } catch {
    return undefined;
  }
}

export async function scanRepositories(
  root: string,
  options: { maxDepth: number },
): Promise<DiscoveredRepository[]> {
  if (!Number.isInteger(options.maxDepth) || options.maxDepth < 0) {
    throw new RangeError('maxDepth must be a non-negative integer');
  }

  const repositories = new Map<string, DiscoveredRepository>();
  const visitedDepths = new Map<string, number>();

  async function visit(directory: string, depth: number, viaSymlink: boolean): Promise<void> {
    const directoryInfo = await lstat(directory);
    let encounteredViaSymlink = viaSymlink;

    if (directoryInfo.isSymbolicLink()) {
      let targetInfo;
      try {
        targetInfo = await stat(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') {
          return;
        }
        throw error;
      }
      if (!targetInfo.isDirectory()) {
        return;
      }
      encounteredViaSymlink = true;
    } else if (!directoryInfo.isDirectory()) {
      return;
    }

    const canonicalDirectory = await realpath(directory);
    if (isInsideIgnoredDirectory(canonicalDirectory)) {
      return;
    }
    if (
      [...repositories.keys()].some((repositoryPath) =>
        isDescendantOf(canonicalDirectory, repositoryPath),
      )
    ) {
      return;
    }
    const previousDepth = visitedDepths.get(canonicalDirectory);
    if (previousDepth !== undefined && previousDepth <= depth) {
      return;
    }
    visitedDepths.set(canonicalDirectory, depth);

    if (await isRepository(directory)) {
      for (const repositoryPath of repositories.keys()) {
        if (isDescendantOf(repositoryPath, canonicalDirectory)) {
          repositories.delete(repositoryPath);
        }
      }

      const remote = await readOrigin(directory);
      let repositoryId: string | undefined;
      if (remote !== undefined) {
        try {
          repositoryId = repositoryIdFromRemote(remote);
        } catch {
          repositoryId = undefined;
        }
      }

      repositories.set(canonicalDirectory, {
        localPath: directory,
        realPath: canonicalDirectory,
        encounteredViaSymlink,
        ...(remote === undefined ? {} : { remote }),
        ...(repositoryId === undefined ? {} : { repositoryId }),
      });
      return;
    }

    if (depth >= options.maxDepth) {
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      await visit(path.join(directory, entry.name), depth + 1, encounteredViaSymlink);
    }
  }

  await visit(path.resolve(root), 0, false);
  return [...repositories.values()].sort((left, right) =>
    left.realPath.localeCompare(right.realPath),
  );
}
