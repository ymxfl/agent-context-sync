import type { CoverageStatus } from '../domain/model.js';

export type AgentName = 'claude-code' | 'codex';
export const ADAPTER_CONTRACT_VERSION = 1;
export const COVERAGE_CONTRACT_VERSION = 1;
export type Shareability = 'team' | 'personal' | 'managed';
export type SourceStatus = 'available' | 'reported-only' | 'excluded-by-precedence' | 'unresolved-by-precedence';
export type LoadingMode = 'eager' | 'on-demand' | 'reported-only';

export interface ContextSource {
  agent: AgentName;
  sourceType: string;
  locator: string;
  shareability: Shareability;
  status: SourceStatus;
  pathScope?: readonly string[];
}

export interface CoverageItem {
  id: string;
  status: CoverageStatus;
  locator?: string;
  detail: string;
}

export interface LoadOrder {
  order: number;
  locator: string;
  sourceType: string;
  loading: LoadingMode;
}

export interface CoverageReport {
  agent: AgentName;
  sources: ContextSource[];
  coverage: CoverageItem[];
  loadPlan: LoadOrder[];
  limits?: {
    maxBytes?: number;
    truncated?: boolean;
  };
}

export interface DiscoveryInput {
  repositoryRoot: string;
  cwd: string;
  homeDir: string;
  managedSettingsPaths?: readonly string[];
  managedInstructionPaths?: readonly string[];
  explicitSettingsPaths?: readonly string[];
  additionalDirectories?: readonly string[];
  includeAdditionalDirectoryInstructions?: boolean;
}

export interface AdapterContractMetadata {
  readonly agent: AgentName;
  readonly contractVersion: number;
  readonly coverageVersion: number;
  readonly supported: boolean;
}

export interface AgentAdapter {
  readonly metadata: AdapterContractMetadata;
  discover(input: DiscoveryInput): Promise<CoverageReport>;
}
