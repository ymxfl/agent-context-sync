import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';

import { appError } from '../domain/errors.js';
import { compareCodeUnits } from '../domain/compare.js';
import type {
  LocalWorkspace,
  RepositoryManifest,
  WorkspaceManifest,
} from '../domain/model.js';
import { atomicWriteFile } from '../fs/atomic-write.js';
import { runGit } from '../git/run-git.js';
import { parseWorkspaceManifest } from '../schema/workspace.js';
import { scanRepositories, type DiscoveredRepository } from './scanner.js';

export const UNBORN_HEAD = 'UNBORN';

export type WorkspaceOperation = 'init' | 'join' | 'add-repository';

export interface PreviewRepository extends RepositoryManifest {
  local_path?: string;
  candidate_paths?: string[];
  binding_hash?: string;
}

export function repositoryDisplayName(repoId: string): string {
  return repoId.slice(repoId.lastIndexOf('/') + 1);
}

export function repositoryBindingHash(repository: DiscoveredRepository): string {
  return createHash('sha256').update(canonicalJson({
    local_path: repository.realPath,
    remote: repository.remote,
    repo_id: repository.repositoryId,
  })).digest('hex');
}

export async function assertApprovedRepositoryBindings(
  preview: WorkspacePreview,
): Promise<void> {
  for (const approved of preview.repositories) {
    if (approved.local_path === undefined) {
      if (approved.candidate_paths !== undefined && approved.candidate_paths.length > 1) {
        throw appError(
          'AMBIGUOUS_BINDING',
          'Multiple local clones match this repository; an explicit binding is required',
          { repo_id: approved.repo_id, candidate_paths: approved.candidate_paths },
        );
      }
      continue;
    }
    const canonical = await fs.realpath(approved.local_path).catch(() => undefined);
    const [current] = canonical === undefined
      ? []
      : await scanRepositories(canonical, { maxDepth: 0 });
    if (
      current === undefined
      || current.realPath !== approved.local_path
      || current.repositoryId !== approved.repo_id
      || approved.binding_hash === undefined
      || repositoryBindingHash(current) !== approved.binding_hash
      || (approved.candidate_paths !== undefined
        && !approved.candidate_paths.includes(approved.local_path))
    ) {
      throw appError('STALE_PREVIEW', 'An approved repository binding changed after preview', {
        repo_id: approved.repo_id,
      });
    }
  }
}

export interface NormalizedInitInput {
  name: string;
  context_remote: string;
  scan_root: string;
  max_depth: number;
  home: string;
}

export interface NormalizedJoinInput {
  context_remote: string;
  scan_roots: string[];
  max_depth: number;
  home: string;
}

export interface NormalizedAddRepositoryInput {
  workspace_id: string;
  repository_path: string;
  home: string;
  context_remote: string;
  workspace_manifest_hash: string;
  mode: 'add-shared' | 'bind-existing';
  repository_id: string;
  previous_repository_path: string | null;
}

export type NormalizedWorkspaceInput =
  | NormalizedInitInput
  | NormalizedJoinInput
  | NormalizedAddRepositoryInput;

export interface WorkspacePreview {
  operation: WorkspaceOperation;
  preview_id: string;
  input_hash: string;
  context_head: string;
  workspace_id: string;
  normalized_input: NormalizedWorkspaceInput;
  files_to_write: string[];
  repositories: PreviewRepository[];
  warnings: string[];
}

export interface WorkspaceResult {
  workspace: WorkspaceManifest;
  local: LocalWorkspace;
  commit?: string;
}

interface PreviewApproval {
  workspace_id: string;
  files_to_write: string[];
  repositories: PreviewRepository[];
  warnings: string[];
}

export function validateContextRemote(remote: string): void {
  parseWorkspaceManifest({
    schema_version: 1,
    workspace_id: 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'Context remote validation',
    context_remote: remote,
    repositories: [],
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function workspaceManifestHash(workspace: WorkspaceManifest): string {
  return createHash('sha256').update(canonicalJson(workspace)).digest('hex');
}

export function previewInputHash(
  operation: WorkspaceOperation,
  input: NormalizedWorkspaceInput,
  contextHead: string,
  approval: PreviewApproval,
): string {
  return createHash('sha256')
    .update(canonicalJson({
      operation,
      input,
      context_head: contextHead,
      ...approval,
    }))
    .digest('hex');
}

export function assertPreviewIntegrity(preview: WorkspacePreview): void {
  if (!/^preview_[0-9A-HJKMNP-TV-Z]{26}$/.test(preview.preview_id)) {
    throw appError('INVALID_PREVIEW', 'Preview ID is invalid');
  }
  const expected = previewInputHash(
    preview.operation,
    preview.normalized_input,
    preview.context_head,
    {
      workspace_id: preview.workspace_id,
      files_to_write: preview.files_to_write,
      repositories: preview.repositories,
      warnings: preview.warnings,
    },
  );
  if (preview.input_hash !== expected) {
    throw appError('STALE_PREVIEW', 'Preview inputs changed after preview generation');
  }
}

export async function remoteHead(remote: string): Promise<string> {
  const { stdout } = await runGit(process.cwd(), [
    'ls-remote',
    '--',
    remote,
    'refs/heads/main',
    'HEAD',
  ]);
  const main = stdout.split('\n').find((line) => line.endsWith('\trefs/heads/main'));
  const first = main ?? stdout.split('\n').find((line) => line.trim().length > 0);
  return first?.split(/\s+/, 1)[0] ?? UNBORN_HEAD;
}

export async function localHead(contextPath: string): Promise<string> {
  try {
    const { stdout } = await runGit(contextPath, ['rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return UNBORN_HEAD;
  }
}

export async function assertRemoteHead(
  remote: string,
  expectedHead: string,
): Promise<void> {
  const actualHead = await remoteHead(remote);
  if (actualHead !== expectedHead) {
    throw appError('STALE_PREVIEW', 'Context HEAD changed after preview generation', {
      expected_head: expectedHead,
      actual_head: actualHead,
    });
  }
}

export function contextCheckoutPath(home: string, workspaceId: string): string {
  return path.join(home, 'contexts', workspaceId);
}

export async function assertLocalContextCheckout(
  home: string,
  workspaceId: string,
  recordedPath: string,
): Promise<string> {
  const canonicalHome = await fs.realpath(home);
  const contextsPath = path.join(canonicalHome, 'contexts');
  const expectedPath = path.join(contextsPath, workspaceId);
  if (path.resolve(recordedPath) !== expectedPath) {
    throw new Error('Registry Context path does not match the expected checkout path');
  }

  const contextsInfo = await fs.lstat(contextsPath);
  const checkoutInfo = await fs.lstat(expectedPath);
  if (
    contextsInfo.isSymbolicLink()
    || !contextsInfo.isDirectory()
    || checkoutInfo.isSymbolicLink()
    || !checkoutInfo.isDirectory()
  ) {
    throw new Error('Registry Context path is not a trusted checkout directory');
  }
  if (await fs.realpath(expectedPath) !== expectedPath) {
    throw new Error('Registry Context path does not have the expected canonical identity');
  }

  const gitInfo = await fs.lstat(path.join(expectedPath, '.git'));
  if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory()) {
    throw new Error('Registry Context path is not a Git checkout');
  }
  return expectedPath;
}

export interface ContextTransaction {
  root: string;
  context_path: string;
}

export async function createContextTransaction(
  home: string,
  remote: string,
  expectedHead: string,
): Promise<ContextTransaction> {
  await fs.mkdir(home, { recursive: true });
  const root = await fs.mkdtemp(path.join(home, '.acs-context-transaction-'));
  const contextPath = path.join(root, 'context');
  try {
    await cloneContext(remote, contextPath, expectedHead);
    return { root, context_path: contextPath };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function installContextTransaction(
  transactionPath: string,
  destination: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const backup = `${destination}.previous-${createHash('sha256')
    .update(transactionPath)
    .digest('hex')
    .slice(0, 16)}`;
  let hadPrevious = false;
  try {
    await fs.rename(destination, backup);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    await fs.rename(transactionPath, destination);
  } catch (error) {
    if (hadPrevious) await fs.rename(backup, destination);
    throw error;
  }
  if (hadPrevious) await fs.rm(backup, { recursive: true, force: true });
}

export async function cloneContext(
  remote: string,
  destination: string,
  expectedHead: string,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await runGit(path.dirname(destination), ['clone', '--', remote, destination]);
  const clonedHead = await localHead(destination);
  if (clonedHead !== expectedHead) {
    await fs.rm(destination, { recursive: true, force: true });
    throw appError('STALE_PREVIEW', 'Cloned Context HEAD differs from preview', {
      expected_head: expectedHead,
      actual_head: clonedHead,
    });
  }
}

export async function readWorkspaceManifest(
  contextPath: string,
): Promise<WorkspaceManifest> {
  const contents = await fs.readFile(path.join(contextPath, 'workspace.yaml'), 'utf8');
  return parseWorkspaceManifest(parse(contents));
}

function checkedRepositoryManifestPath(root: string, repoId: string): string {
  const file = path.resolve(root, `${repoId}.yaml`);
  const relative = path.relative(root, file);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('Repository manifest path resolves outside its root');
  }
  return file;
}

function repositoryManifestPath(contextPath: string, repoId: string): string {
  return checkedRepositoryManifestPath(path.join(contextPath, 'repositories'), repoId);
}

async function lstatIfExists(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeRepositoryManifestFile(
  contextPath: string,
  file: string,
): Promise<void> {
  const contextInfo = await fs.lstat(contextPath);
  if (contextInfo.isSymbolicLink() || !contextInfo.isDirectory()) {
    throw new Error('Context root must be a non-symbolic directory');
  }

  const relativeParent = path.relative(contextPath, path.dirname(file));
  let current = contextPath;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstatIfExists(current);
    if (info === undefined) break;
    if (info.isSymbolicLink()) {
      throw new Error(`Repository manifest ancestor is a symbolic link: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Repository manifest ancestor is not a directory: ${current}`);
    }
  }

  const fileInfo = await lstatIfExists(file);
  if (fileInfo?.isSymbolicLink()) {
    throw new Error(`Repository manifest file is a symbolic link: ${file}`);
  }
  if (fileInfo !== undefined && !fileInfo.isFile()) {
    throw new Error(`Repository manifest path is not a regular file: ${file}`);
  }
}

export function repositoryManifestFile(repoId: string): string {
  checkedRepositoryManifestPath('/repositories', repoId);
  return path.posix.join('repositories', `${repoId}.yaml`);
}

export async function writeSharedManifests(
  contextPath: string,
  workspace: WorkspaceManifest,
  repositories: readonly RepositoryManifest[],
): Promise<void> {
  const validated = parseWorkspaceManifest(workspace);
  const repositoryFiles = repositories.map((repository) => ({
    repository,
    file: repositoryManifestPath(contextPath, repository.repo_id),
  }));
  await Promise.all(repositoryFiles.map(({ file }) =>
    assertSafeRepositoryManifestFile(contextPath, file),
  ));
  await atomicWriteFile(path.join(contextPath, 'workspace.yaml'), stringify(validated));
  for (const { repository, file } of repositoryFiles) {
    await assertSafeRepositoryManifestFile(contextPath, file);
    await atomicWriteFile(
      file,
      stringify(repository),
    );
  }
}

export async function commitAndPushContext(
  contextPath: string,
  message: string,
): Promise<string> {
  await runGit(contextPath, ['config', 'user.name', 'Agent Context Sync']);
  await runGit(contextPath, [
    'config',
    'user.email',
    'agent-context-sync@localhost.invalid',
  ]);
  await runGit(contextPath, ['add', 'workspace.yaml']);
  try {
    await fs.access(path.join(contextPath, 'repositories'));
    await runGit(contextPath, ['add', 'repositories']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await runGit(contextPath, ['commit', '-m', message]);
  const { stdout } = await runGit(contextPath, ['rev-parse', 'HEAD']);
  await runGit(contextPath, ['push', 'origin', 'HEAD:refs/heads/main']);
  return stdout.trim();
}
