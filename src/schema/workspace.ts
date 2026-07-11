import path from 'node:path';
import { z } from 'zod';
import type {
  LocalWorkspace,
  RepositoryManifest,
  WorkspaceManifest,
} from '../domain/model.js';

const workspaceIdSchema = z.string().regex(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/);

const repositoryIdSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?\/[^\s/?#]+(?:\/[^\s/?#]+)*$/,
  'Repository ID must be a normalized host/path string',
).refine((value) => !value.endsWith('.git'), {
  message: 'Repository ID must not include a .git suffix',
});

const absolutePathSchema = z.string().refine(path.isAbsolute, {
  message: 'Path must be absolute',
});

const sharedRemoteSchema = z.string().trim().min(1).refine(
  (value) => !/^file:/i.test(value)
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value),
  { message: 'Shared remote must not be an absolute local path' },
);

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

export function parseLocalWorkspace(value: unknown): LocalWorkspace {
  return localWorkspaceSchema.parse(value);
}
