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

export type KnowledgeStatus = 'active' | 'superseded' | 'archived' | 'disputed';
export type KnowledgeScope = 'workspace' | `repository:${string}`;

export interface KnowledgeApplicability {
  paths: string[];
  agents: string[];
}

export interface SourceReference {
  agent: string;
  source_type: string;
  locator: string;
  content_hash: string;
  observed_at: string;
}

export interface ProposedKnowledge {
  kind: string;
  scope: KnowledgeScope;
  applies_to: KnowledgeApplicability;
  source: SourceReference;
  confidence: number;
  supersedes: string[];
  conflicts_with: string[];
  statement: string;
  reason: string;
}

export interface KnowledgeEntry extends ProposedKnowledge {
  schema_version: 1;
  id: string;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

export interface RejectedCandidate {
  source: SourceReference;
  reason: string;
}

export interface ExtractionProposal {
  schema_version: 1;
  packet_id: string;
  accepted: ProposedKnowledge[];
  rejected: RejectedCandidate[];
}
