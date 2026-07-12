import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentName, CoverageReport } from '../adapters/adapter.js';
import { defaultAdapterRegistry, type AdapterRegistry } from '../adapters/registry.js';
import { appError } from '../domain/errors.js';
import { assertLocalContextCheckout, readWorkspaceManifest } from '../workspace/context-repository.js';
import { readLocalWorkspace } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';

export interface InspectInput {
  workspaceId: string;
  agent: AgentName;
  home: string;
  homeDir: string;
  repositories?: readonly string[];
  cwd?: string;
  adapterRegistry?: AdapterRegistry;
}

export interface RepositoryCoverageReport {
  repo_id: string;
  report: CoverageReport;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function inspect(input: InspectInput): Promise<RepositoryCoverageReport[]> {
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
  if (input.cwd !== undefined && repositories.length !== 1) {
    throw new Error('Option cwd requires exactly one requested local repository');
  }
  const adapter = (input.adapterRegistry ?? defaultAdapterRegistry).adapterFor(input.agent);
  return Promise.all(repositories.map(async (repository) => {
    const recordedRoot = local.repository_paths[repository.repo_id] as string;
    const repositoryRoot = await fs.realpath(recordedRoot).catch(() => undefined);
    const [current] = repositoryRoot === undefined
      ? []
      : await scanRepositories(repositoryRoot, { maxDepth: 0 });
    if (
      repositoryRoot === undefined
      || repositoryRoot !== recordedRoot
      || current?.realPath !== repositoryRoot
      || current.repositoryId !== repository.repo_id
    ) {
      throw appError('REPOSITORY_ID_DRIFT', 'Registered repository identity no longer matches the Workspace', {
        repo_id: repository.repo_id,
      });
    }
    const cwd = input.cwd === undefined ? repositoryRoot : await fs.realpath(path.resolve(input.cwd));
    if (!isInside(repositoryRoot, cwd)) {
      throw appError('INVALID_CWD', 'Inspection cwd must be contained in the bound repository', {
        repo_id: repository.repo_id,
      });
    }
    const report = await adapter.discover({
      repositoryRoot,
      cwd,
      homeDir: path.resolve(input.homeDir),
    });
    return { repo_id: repository.repo_id, report };
  }));
}
