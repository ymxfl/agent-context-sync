import { realpathSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { LocalWorkspace } from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import {
  parseLocalWorkspace,
  parseWorkspaceId,
} from '../schema/workspace.js';

export type LocalRegistryWriter = (
  file: string,
  contents: string,
) => Promise<void>;

export function registryPath(home: string, workspaceId: string): string {
  const validWorkspaceId = parseWorkspaceId(workspaceId);
  const directory = path.resolve(home, 'workspaces');
  const file = path.resolve(directory, `${validWorkspaceId}.yaml`);
  const relativePath = path.relative(directory, file);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('Workspace ID resolves outside the registry directory');
  }
  return file;
}

export async function readLocalWorkspace(
  home: string,
  workspaceId: string,
): Promise<LocalWorkspace> {
  const validWorkspaceId = parseWorkspaceId(workspaceId);
  const contents = await readFileAsync(
    registryPath(home, validWorkspaceId),
    'utf8',
  );
  const local = parseLocalWorkspace(parse(contents));
  if (local.workspace_id !== validWorkspaceId) {
    throw new Error(
      `Registry workspace ID ${local.workspace_id} does not match ${validWorkspaceId}`,
    );
  }
  return local;
}

export async function writeLocalWorkspace(
  home: string,
  value: LocalWorkspace,
  writer: LocalRegistryWriter = atomicWriteFile,
): Promise<void> {
  const local = parseLocalWorkspace(value);
  await writer(registryPath(home, local.workspace_id), stringify(local));
}

export function bindRepositoryPath(
  local: LocalWorkspace,
  repoId: string,
  repositoryPath: string,
): LocalWorkspace {
  if (!path.isAbsolute(repositoryPath)) {
    throw new TypeError('Repository path must be absolute');
  }

  const canonicalPath = realpathSync(repositoryPath);
  return parseLocalWorkspace({
    ...local,
    repository_paths: {
      ...local.repository_paths,
      [repoId]: canonicalPath,
    },
  });
}
