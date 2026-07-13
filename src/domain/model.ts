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

export interface KnowledgeParseContext {
  readonly registeredRepositoryIds: ReadonlySet<string>;
}

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

export type VerificationStatus = 'valid' | 'stale' | 'contradicted' | 'unverifiable';

export type EvidenceRef =
  | {
    type: 'file';
    repo_id: string;
    path: string;
    start_line: number;
    end_line: number;
    content_hash: string;
  }
  | {
    type: 'dependency';
    repo_id: string;
    manifest_path: string;
    name: string;
    version: string;
    content_hash: string;
  }
  | {
    type: 'config';
    repo_id: string;
    path: string;
    start_line: number;
    end_line: number;
    content_hash: string;
  }
  | {
    type: 'git-commit';
    repo_id: string;
    commit: string;
  };

export type ProposedVerificationAction =
  | { type: 'none' }
  | { type: 'update'; statement: string; reason: string }
  | { type: 'supersede'; statement: string; reason: string }
  | { type: 'archive'; reason: string };

export interface VerificationFinding {
  knowledge_id: string;
  status: VerificationStatus;
  explanation: string;
  evidence: EvidenceRef[];
  proposed_action: ProposedVerificationAction;
  attempted_checks?: string[];
}

export interface VerificationProposal {
  schema_version: 1;
  packet_id: string;
  packet_hash: string;
  findings: VerificationFinding[];
}
