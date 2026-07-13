import type { AgentName, CoverageReport } from '../adapters/adapter.js';
import { defaultAdapterRegistry, type AdapterRegistry } from '../adapters/registry.js';
import { appError } from '../domain/errors.js';
import { classifyTrace, type TraceCandidate } from '../tracing/classify.js';
import {
  resolveTraceProvider,
  type TraceEvent,
  type TraceProvider,
} from '../tracing/provider.js';
import { inspect } from './inspect.js';

export interface TraceRunInput {
  workspaceId: string;
  agent: AgentName;
  home: string;
  homeDir: string;
  command: string;
  commandArgs?: readonly string[];
  experimental: boolean;
  consentPathMetadata: boolean;
  repositories?: readonly string[];
  cwd?: string;
  adapterRegistry?: AdapterRegistry;
  /** Test seam: inject a provider instead of resolving the platform default. */
  provider?: TraceProvider;
}

export interface TraceRunResult {
  provider: string;
  available: boolean;
  unavailable_reason?: string;
  events_captured: number;
  candidates: TraceCandidate[];
  /** Path metadata only; never includes file contents. */
  events?: TraceEvent[];
}

function mergeCoverageReports(reports: readonly CoverageReport[]): CoverageReport {
  if (reports.length === 0) {
    return {
      agent: 'claude-code',
      sources: [],
      coverage: [],
      loadPlan: [],
    };
  }
  const first = reports[0] as CoverageReport;
  if (reports.length === 1) return first;
  return {
    agent: first.agent,
    sources: reports.flatMap((report) => report.sources),
    coverage: reports.flatMap((report) => report.coverage),
    loadPlan: reports.flatMap((report) => report.loadPlan),
  };
}

/**
 * Opt-in experimental tracing of Agent file-path access.
 * Requires --experimental and --consent-path-metadata. Never reads file contents.
 */
export async function traceRun(input: TraceRunInput): Promise<TraceRunResult> {
  if (!input.experimental || !input.consentPathMetadata) {
    throw appError(
      'TRACE_CONSENT_REQUIRED',
      'Experimental tracing requires --experimental and --consent-path-metadata',
      {
        experimental: input.experimental,
        consent_path_metadata: input.consentPathMetadata,
      },
    );
  }

  const provider = input.provider ?? await resolveTraceProvider();
  if (provider === undefined) {
    return {
      provider: 'none',
      available: false,
      unavailable_reason: 'Runtime tracing is unavailable on this platform in v0.3 (Windows and unknown OS).',
      events_captured: 0,
      candidates: [],
    };
  }

  const available = await provider.isAvailable();
  if (!available) {
    return {
      provider: provider.name,
      available: false,
      unavailable_reason: provider.unavailableReason(),
      events_captured: 0,
      candidates: [],
    };
  }

  const inspected = await inspect({
    workspaceId: input.workspaceId,
    agent: input.agent,
    home: input.home,
    homeDir: input.homeDir,
    adapterRegistry: input.adapterRegistry ?? defaultAdapterRegistry,
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });
  const stableReport = mergeCoverageReports(inspected.reports.map((item) => item.report));

  await provider.start(input.command, input.commandArgs ?? []);
  let events: TraceEvent[];
  try {
    events = await provider.stop();
  } catch (error) {
    return {
      provider: provider.name,
      available: true,
      unavailable_reason: error instanceof Error ? error.message : 'Tracing failed during stop()',
      events_captured: 0,
      candidates: [],
    };
  }

  const candidates = classifyTrace(events, stableReport);
  return {
    provider: provider.name,
    available: true,
    events_captured: events.length,
    candidates,
  };
}
