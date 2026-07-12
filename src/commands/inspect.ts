import path from 'node:path';

import type { AgentName, CoverageReport } from '../adapters/adapter.js';
import { defaultAdapterRegistry, type AdapterRegistry } from '../adapters/registry.js';
import { assertLocalContextCheckout, readWorkspaceManifest } from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';

export interface InspectInput {
  workspaceId: string;
  agent: AgentName;
  home: string;
  homeDir: string;
  repositories?: readonly string[];
  adapterRegistry?: AdapterRegistry;
}

export async function inspect(input: InspectInput): Promise<CoverageReport[]> {
  const local = await readLocalWorkspace(input.home, input.workspaceId);
  const contextPath = await assertLocalContextCheckout(
    input.home,
    input.workspaceId,
    local.context_path,
  );
  const workspace = await readWorkspaceManifest(contextPath);
  if (workspace.workspace_id !== input.workspaceId) {
    throw new Error('Workspace manifest does not match the requested workspace');
  }

  const requested = input.repositories === undefined
    ? undefined
    : new Set(input.repositories);
  if (requested?.size === 0) {
    throw new Error('At least one repository must be requested');
  }
  const knownRepositoryIds = new Set(workspace.repositories.map((item) => item.repo_id));
  for (const repositoryId of requested ?? []) {
    if (!knownRepositoryIds.has(repositoryId)) {
      throw new Error('Requested repository is not part of the Workspace');
    }
    if (local.repository_paths[repositoryId] === undefined) {
      throw new Error('Requested repository is not available locally');
    }
  }

  const repositories = workspace.repositories.filter((repository) => (
    local.repository_paths[repository.repo_id] !== undefined
    && (requested === undefined || requested.has(repository.repo_id))
  ));
  const adapter = (input.adapterRegistry ?? defaultAdapterRegistry).adapterFor(input.agent);
  return Promise.all(repositories.map(async (repository) => {
    const repositoryRoot = local.repository_paths[repository.repo_id] as string;
    return adapter.discover({
      repositoryRoot,
      cwd: repositoryRoot,
      homeDir: path.resolve(input.homeDir),
    });
  }));
}
