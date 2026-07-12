import path from 'node:path';
import { z } from 'zod';
import type {
  LocalWorkspace,
  RepositoryManifest,
  WorkspaceManifest,
} from '../domain/model.js';

const workspaceIdSchema = z.string().regex(
  /^ws_[0-9A-HJKMNP-TV-Z]{26}$/,
  'Workspace ID must use the ws_ prefix and 26 Crockford Base32 characters',
);

const repositoryIdSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?\/[^\s\\/?#]+(?:\/[^\s\\/?#]+)*$/,
  'Repository ID must be a normalized host/path string',
).refine((value) => !value.endsWith('.git'), {
  message: 'Repository ID must not include a .git suffix',
}).refine((value) => {
  const repositoryPath = value.slice(value.indexOf('/') + 1);
  return repositoryPath.split('/').every((segment) => segment !== '.' && segment !== '..');
}, {
  message: 'Repository ID must not contain dot path segments',
});

const absolutePathSchema = z.string().refine(path.isAbsolute, {
  message: 'Path must be absolute',
});

function isSupportedRemote(value: string): boolean {
  if (value.startsWith('-')) return false;
  if (/^(?:https|ssh|git):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.hostname.length > 0 && parsed.pathname.replace(/^\/+/, '').length > 0;
    } catch {
      return false;
    }
  }
  if (value.includes('://')) return false;
  return /^(?:[^@\s/:]+@)?[^\s/:\\]+:[^\s\\]+$/.test(value);
}

const sharedRemoteSchema = z.string().trim().min(1).refine(isSupportedRemote, {
  message: 'Shared remote must be an HTTPS, SSH, Git, or SCP-like remote',
});

const repositoryManifestSchema: z.ZodType<RepositoryManifest> = z.strictObject({
  schema_version: z.literal(1),
  repo_id: repositoryIdSchema,
  name: z.string().trim().min(1),
});

const workspaceManifestSchema: z.ZodType<WorkspaceManifest> = z.strictObject({
  schema_version: z.literal(1),
  workspace_id: workspaceIdSchema,
  name: z.string().trim().min(1),
  context_remote: sharedRemoteSchema,
  repositories: z.array(repositoryManifestSchema),
});

const localWorkspaceSchema: z.ZodType<LocalWorkspace> = z.strictObject({
  schema_version: z.literal(1),
  workspace_id: workspaceIdSchema,
  context_path: absolutePathSchema,
  repository_paths: z.record(repositoryIdSchema, absolutePathSchema),
});

export function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  return workspaceManifestSchema.parse(value);
}

export function parseWorkspaceId(value: unknown): string {
  return workspaceIdSchema.parse(value);
}

export function parseLocalWorkspace(value: unknown): LocalWorkspace {
  return localWorkspaceSchema.parse(value);
}
