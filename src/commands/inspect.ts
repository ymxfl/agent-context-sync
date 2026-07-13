import * as fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentName, CoverageReport } from '../adapters/adapter.js';
import { ClaudeAdapter } from '../adapters/claude/discover.js';
import { CodexAdapter } from '../adapters/codex/discover.js';
import { defaultAdapterRegistry, type AdapterRegistry } from '../adapters/registry.js';
import { appError } from '../domain/errors.js';
import { runGit } from '../git/run-git.js';
import {
  ContentCache,
  contentHashFingerprint,
  mtimeFingerprint,
} from '../performance/cache.js';
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
  /** Optional cache override for tests. */
  cache?: ContentCache;
}

export interface RepositoryCoverageReport {
  repo_id: string;
  report: CoverageReport;
}

export interface InspectStats {
  files_read: number;
}

export interface InspectResult {
  reports: RepositoryCoverageReport[];
  stats: InspectStats;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function directoryChain(repositoryRoot: string, cwd: string): string[] {
  if (!isInside(repositoryRoot, cwd)) return [repositoryRoot];
  const suffix = path.relative(repositoryRoot, cwd);
  if (suffix === '') return [repositoryRoot];
  const directories = [repositoryRoot];
  let cursor = repositoryRoot;
  for (const segment of suffix.split(path.sep)) {
    cursor = path.join(cursor, segment);
    directories.push(cursor);
  }
  return directories;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

async function discoveryCandidatePaths(
  agent: AgentName,
  repositoryRoot: string,
  cwd: string,
  homeDir: string,
): Promise<string[]> {
  const candidates = new Set<string>();
  const chain = directoryChain(repositoryRoot, cwd);

  if (agent === 'codex') {
    const codexHome = process.env.CODEX_HOME === undefined
      ? path.join(homeDir, '.codex')
      : path.resolve(process.env.CODEX_HOME);
    candidates.add(path.join(codexHome, 'config.toml'));
    candidates.add(path.join(codexHome, 'AGENTS.md'));
    candidates.add(path.join(codexHome, 'AGENTS.override.md'));
    for (const directory of chain) {
      candidates.add(path.join(directory, 'AGENTS.md'));
      candidates.add(path.join(directory, 'AGENTS.override.md'));
      candidates.add(path.join(directory, 'TEAM.md'));
      candidates.add(path.join(directory, '.codex', 'config.toml'));
    }
  } else {
    candidates.add(path.join(homeDir, '.claude', 'CLAUDE.md'));
    candidates.add(path.join(homeDir, '.claude', 'settings.json'));
    candidates.add(path.join(homeDir, '.claude', 'settings.local.json'));
    for (const directory of chain) {
      candidates.add(path.join(directory, 'CLAUDE.md'));
      candidates.add(path.join(directory, 'CLAUDE.local.md'));
      candidates.add(path.join(directory, '.claude', 'CLAUDE.md'));
      candidates.add(path.join(directory, '.claude', 'settings.json'));
      candidates.add(path.join(directory, '.claude', 'settings.local.json'));
      const rulesRoot = path.join(directory, '.claude', 'rules');
      for (const file of await listMarkdownFiles(rulesRoot)) {
        candidates.add(file);
      }
    }
  }

  return [...candidates];
}

async function configHashForAgent(agent: AgentName, homeDir: string): Promise<string> {
  if (agent === 'codex') {
    const codexHome = process.env.CODEX_HOME === undefined
      ? path.join(homeDir, '.codex')
      : path.resolve(process.env.CODEX_HOME);
    return contentHashFingerprint([
      path.join(codexHome, 'config.toml'),
      path.join(codexHome, 'AGENTS.md'),
      path.join(codexHome, 'AGENTS.override.md'),
    ]);
  }
  return contentHashFingerprint([
    path.join(homeDir, '.claude', 'settings.json'),
    path.join(homeDir, '.claude', 'settings.local.json'),
    path.join(homeDir, '.claude', 'CLAUDE.md'),
  ]);
}

async function repositoryHead(repositoryRoot: string): Promise<string> {
  const { stdout } = await runGit(repositoryRoot, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

function countingFileSystem(filesRead: { count: number }) {
  return {
    readFile: async (filePath: string): Promise<string> => {
      filesRead.count += 1;
      return fs.readFile(filePath, 'utf8');
    },
    readdir: (directory: string, options: { withFileTypes: true }) =>
      fs.readdir(directory, options),
    realpath: (filePath: string) => fs.realpath(filePath),
    stat: (filePath: string) => fs.stat(filePath),
  };
}

function createCountingAdapter(
  agent: AgentName,
  filesRead: { count: number },
  adapterRegistry: AdapterRegistry | undefined,
) {
  // Prefer counting filesystem adapters so cache hit/miss stats are meaningful.
  if (adapterRegistry !== undefined && adapterRegistry !== defaultAdapterRegistry) {
    return adapterRegistry.adapterFor(agent);
  }
  const fsLayer = countingFileSystem(filesRead);
  return agent === 'claude-code'
    ? new ClaudeAdapter(fsLayer)
    : new CodexAdapter({ ...fsLayer, env: process.env });
}

export async function inspect(input: InspectInput): Promise<InspectResult> {
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

  const cache = input.cache ?? new ContentCache({ home: input.home });
  const homeDir = path.resolve(input.homeDir);
  const configHash = await configHashForAgent(input.agent, homeDir);
  const filesRead = { count: 0 };
  const adapter = createCountingAdapter(input.agent, filesRead, input.adapterRegistry);
  const adapterVersion = [
    adapter.metadata.agent,
    adapter.metadata.contractVersion,
    adapter.metadata.coverageVersion,
  ].join(':');

  const reports = await Promise.all(repositories.map(async (repository) => {
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

    const head = await repositoryHead(repositoryRoot);
    await cache.invalidateByHead(repository.repo_id, head);
    const candidates = await discoveryCandidatePaths(input.agent, repositoryRoot, cwd, homeDir);
    const fingerprint = await mtimeFingerprint(candidates);
    const key = ContentCache.discoveryKey({
      adapterVersion,
      configHash,
      repositoryId: repository.repo_id,
      head,
      targetPath: cwd,
      mtimeFingerprint: fingerprint,
    });

    const cached = await cache.get<CoverageReport>(key);
    if (cached !== undefined) {
      return { repo_id: repository.repo_id, report: cached };
    }

    const report = await adapter.discover({
      repositoryRoot,
      cwd,
      homeDir,
    });
    await cache.put(key, report, {
      repositoryId: repository.repo_id,
      head,
      kind: 'discovery',
    });
    return { repo_id: repository.repo_id, report };
  }));

  return {
    reports,
    stats: { files_read: filesRead.count },
  };
}
