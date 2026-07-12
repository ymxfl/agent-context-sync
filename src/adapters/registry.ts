import {
  ADAPTER_CONTRACT_VERSION,
  COVERAGE_CONTRACT_VERSION,
  type AdapterContractMetadata,
  type AgentAdapter,
  type AgentName,
} from './adapter.js';
import { ClaudeAdapter } from './claude/discover.js';
import { CodexAdapter } from './codex/discover.js';

export const AGENT_NAMES = ['claude-code', 'codex'] as const;

export interface AdapterRegistry {
  adapterFor(name: AgentName): AgentAdapter;
  contracts(): readonly (AdapterContractMetadata | undefined)[];
}

export interface AdapterContractAssessment {
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

function createAdapter(name: AgentName): AgentAdapter {
  return name === 'claude-code' ? new ClaudeAdapter() : new CodexAdapter();
}

export const defaultAdapterRegistry: AdapterRegistry = {
  adapterFor: createAdapter,
  contracts: () => AGENT_NAMES.map((name) => createAdapter(name).metadata),
};

export function adapterFor(name: AgentName): AgentAdapter {
  return defaultAdapterRegistry.adapterFor(name);
}

export function adapterContracts(): readonly (AdapterContractMetadata | undefined)[] {
  return defaultAdapterRegistry.contracts();
}

export function assessAdapterContracts(
  contracts: readonly (AdapterContractMetadata | undefined)[],
): AdapterContractAssessment {
  const byAgent = new Map<AgentName, AdapterContractMetadata>();
  let duplicate = false;
  for (const metadata of contracts) {
    if (metadata === undefined || !AGENT_NAMES.includes(metadata.agent)) continue;
    if (byAgent.has(metadata.agent)) duplicate = true;
    byAgent.set(metadata.agent, metadata);
  }
  const present = AGENT_NAMES.map((agent) => byAgent.get(agent));
  if (present.some((metadata) => metadata !== undefined && (
    !metadata.supported
    || metadata.contractVersion !== ADAPTER_CONTRACT_VERSION
    || metadata.coverageVersion !== COVERAGE_CONTRACT_VERSION
  ))) {
    return {
      status: 'fail',
      detail: 'One or more Adapter contracts do not support coverage contract version 1.',
    };
  }
  if (duplicate || contracts.length !== AGENT_NAMES.length || present.some((metadata) => metadata === undefined)) {
    return {
      status: 'warn',
      detail: 'Adapter contract metadata is incomplete for Claude Code and Codex.',
    };
  }
  return {
    status: 'pass',
    detail: 'Claude Code and Codex Adapters declare support for Adapter and coverage contract version 1.',
  };
}
