import type { CompiledContext } from '../compiler/compile.js';
import type { CoverageStatus } from '../domain/model.js';

export type AgentName = 'claude-code' | 'codex';
export const ADAPTER_CONTRACT_VERSION = 1;
export const COVERAGE_CONTRACT_VERSION = 1;
export type Shareability = 'team' | 'personal' | 'managed';
export type SourceStatus = 'available' | 'reported-only' | 'excluded-by-precedence' | 'unresolved-by-precedence';
export type LoadingMode = 'eager' | 'on-demand' | 'reported-only';

/** SHA-256 digest formatted as `sha256:<hex>` (same as knowledge content hashes). */
export type ContentDigest = `sha256:${string}`;

export interface RenderLimits {
  /** Codex root AGENTS.md byte budget. Defaults to 32768. */
  maxBytes?: number;
  /** Soft cap for Claude root CLAUDE.md line count. Defaults to 200. */
  maxRootLines?: number;
}

export interface RenderInput {
  compiled: CompiledContext;
  limits?: RenderLimits;
}

export interface RenderedFile {
  relativePath: string;
  bytes: Uint8Array;
  /** Content digest of `bytes`, formatted as `sha256:<hex>`. */
  sha256: ContentDigest;
  sourceKnowledgeIds: string[];
}

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
  /** Optional native projection of compiled knowledge into Agent files. */
  render?(input: RenderInput): RenderedFile[];
}
