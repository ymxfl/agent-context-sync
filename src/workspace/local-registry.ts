import { realpathSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { LocalWorkspace } from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import { parseLocalWorkspace } from '../schema/workspace.js';

export type LocalRegistryWriter = (
  file: string,
  contents: string,
) => Promise<void>;

export function registryPath(home: string, workspaceId: string): string {
  return path.join(home, 'workspaces', `${workspaceId}.yaml`);
}

export async function readLocalWorkspace(
  home: string,
  workspaceId: string,
): Promise<LocalWorkspace> {
  const contents = await readFileAsync(registryPath(home, workspaceId), 'utf8');
  return parseLocalWorkspace(parse(contents));
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
