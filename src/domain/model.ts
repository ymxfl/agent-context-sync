export type CoverageStatus = 'covered' | 'partial' | 'unknown' | 'inaccessible';

export interface RepositoryManifest {
  schema_version: 1;
  repo_id: string;
  name: string;
}

export interface WorkspaceManifest {
  schema_version: 1;
  workspace_id: string;
  name: string;
  context_remote: string;
  repositories: RepositoryManifest[];
}

export interface LocalWorkspace {
  schema_version: 1;
  workspace_id: string;
  context_path: string;
  repository_paths: Record<string, string>;
}
