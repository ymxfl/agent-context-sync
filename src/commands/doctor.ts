import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';

import type { CoverageReport } from '../adapters/adapter.js';
import { runGit } from '../git/run-git.js';
import { assertLocalContextCheckout, readWorkspaceManifest, remoteHead } from '../workspace/context-repository.js';
import { readLocalWorkspace, registryPath } from '../workspace/local-registry.js';
import { scanRepositories } from '../workspace/scanner.js';
import { inspect } from './inspect.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: 'node-version' | 'git-availability' | 'context-git' | 'registry-validity'
    | 'repository-path-drift' | 'adapter-version-support' | 'permissions'
    | 'adapter-coverage';
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  workspace_id: string;
  checks: DoctorCheck[];
}

export interface DoctorInput {
  workspaceId: string;
  home: string;
  homeDir: string;
}

function check(id: DoctorCheck['id'], status: DoctorStatus, detail: string): DoctorCheck {
  return { id, status, detail };
}

function coverageStatus(reports: readonly CoverageReport[]): DoctorStatus {
  return reports.some((report) => report.coverage.some(
    (item) => item.status !== 'covered',
  )) ? 'warn' : 'pass';
}

export async function doctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  checks.push(Number.isSafeInteger(nodeMajor) && nodeMajor >= 20
    ? check('node-version', 'pass', 'Node.js 20 or newer is available.')
    : check('node-version', 'fail', 'Node.js 20 or newer is required.'));

  try {
    await runGit(process.cwd(), ['--version']);
    checks.push(check('git-availability', 'pass', 'Git is available.'));
  } catch {
    checks.push(check('git-availability', 'fail', 'Git is unavailable.'));
  }

  let local: Awaited<ReturnType<typeof readLocalWorkspace>> | undefined;
  try {
    local = await readLocalWorkspace(input.home, input.workspaceId);
    checks.push(check('registry-validity', 'pass', 'The local Workspace registry is valid.'));
  } catch {
    checks.push(check('registry-validity', 'fail', 'The local Workspace registry is invalid or unreadable.'));
  }

  let contextPath: string | undefined;
  let workspace: Awaited<ReturnType<typeof readWorkspaceManifest>> | undefined;
  if (local !== undefined) {
    try {
      contextPath = await assertLocalContextCheckout(
        input.home,
        input.workspaceId,
        local.context_path,
      );
      workspace = await readWorkspaceManifest(contextPath);
      if (workspace.workspace_id !== input.workspaceId) throw new Error('workspace mismatch');
      await remoteHead(workspace.context_remote);
      checks.push(check('context-git', 'pass', 'The Context Git checkout and remote are reachable.'));
    } catch {
      checks.push(check('context-git', 'fail', 'The Context Git checkout or remote is unavailable.'));
    }
  } else {
    checks.push(check('context-git', 'fail', 'The Context Git checkout or remote is unavailable.'));
  }

  if (local !== undefined && workspace !== undefined) {
    try {
      const shared = new Set(workspace.repositories.map((repository) => repository.repo_id));
      let drifted = false;
      for (const [repositoryId, repositoryPath] of Object.entries(local.repository_paths)) {
        if (!shared.has(repositoryId) || await fs.realpath(repositoryPath) !== repositoryPath) {
          drifted = true;
          break;
        }
        const [discovered] = await scanRepositories(repositoryPath, { maxDepth: 0 });
        if (discovered?.realPath !== repositoryPath || discovered.repositoryId !== repositoryId) {
          drifted = true;
          break;
        }
      }
      checks.push(drifted
        ? check('repository-path-drift', 'warn', 'One or more local repository bindings have drifted.')
        : check('repository-path-drift', 'pass', 'Local repository bindings match the Workspace.'));
    } catch {
      checks.push(check('repository-path-drift', 'warn', 'One or more local repository bindings have drifted.'));
    }
  } else {
    checks.push(check('repository-path-drift', 'warn', 'Repository path drift could not be checked.'));
  }

  checks.push(check(
    'adapter-version-support',
    'pass',
    'The v0.1 Claude Code and Codex Adapter contracts are supported.',
  ));

  if (local !== undefined && contextPath !== undefined) {
    try {
      await Promise.all([
        fs.access(registryPath(input.home, input.workspaceId), fsConstants.R_OK),
        fs.access(contextPath, fsConstants.R_OK),
        ...Object.values(local.repository_paths).map((repositoryPath) =>
          fs.access(repositoryPath, fsConstants.R_OK),
        ),
      ]);
      checks.push(check('permissions', 'pass', 'Required Workspace paths are readable.'));
    } catch {
      checks.push(check('permissions', 'fail', 'One or more required Workspace paths are unreadable.'));
    }
  } else {
    checks.push(check('permissions', 'fail', 'One or more required Workspace paths are unreadable.'));
  }

  if (local !== undefined && workspace !== undefined) {
    try {
      const reports = (await Promise.all((['claude-code', 'codex'] as const).map((agent) =>
        inspect({
          workspaceId: input.workspaceId,
          agent,
          home: input.home,
          homeDir: input.homeDir,
        }),
      ))).flat();
      checks.push(coverageStatus(reports) === 'pass'
        ? check('adapter-coverage', 'pass', 'Adapter discovery completed with covered diagnostics.')
        : check('adapter-coverage', 'warn', 'Adapter discovery contains partial, unknown, or inaccessible coverage.'));
    } catch {
      checks.push(check('adapter-coverage', 'warn', 'Adapter discovery coverage could not be completed.'));
    }
  } else {
    checks.push(check('adapter-coverage', 'warn', 'Adapter discovery coverage could not be completed.'));
  }

  const order: DoctorCheck['id'][] = [
    'node-version',
    'git-availability',
    'context-git',
    'registry-validity',
    'repository-path-drift',
    'adapter-version-support',
    'permissions',
    'adapter-coverage',
  ];
  checks.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  return { workspace_id: input.workspaceId, checks };
}
