import type { CoverageReport } from '../adapters/adapter.js';
import type { TraceEvent } from './provider.js';

export interface TraceCandidate {
  path: string;
  operation: string;
  reason: string;
  pid: number;
  timestamp: string;
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.swift', '.m', '.mm',
  '.cs', '.fs', '.php', '.sh', '.bash', '.zsh',
  '.wasm', '.so', '.dylib', '.dll', '.o', '.a',
  '.class', '.jar',
]);

const CONTEXT_BASENAMES = new Set([
  'agents.md',
  'claude.md',
  'claude.local.md',
  'codex.md',
  '.cursorrules',
  'rules.md',
  'rule.md',
  'instructions.md',
]);

const CONTEXT_SUFFIXES = [
  '.rules',
  '.mdc',
  'agents.md',
  'claude.md',
];

function explainedPaths(report: CoverageReport): Set<string> {
  const paths = new Set<string>();
  for (const source of report.sources) {
    paths.add(source.locator);
  }
  for (const item of report.coverage) {
    if (item.locator !== undefined) paths.add(item.locator);
  }
  for (const step of report.loadPlan) {
    paths.add(step.locator);
  }
  return paths;
}

function extensionOf(filePath: string): string {
  const base = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

function basenameOf(filePath: string): string {
  const parts = filePath.split('/');
  return (parts[parts.length - 1] ?? filePath).toLowerCase();
}

function isSystemLibraryPath(filePath: string): boolean {
  return filePath.startsWith('/usr/')
    || filePath.startsWith('/lib/')
    || filePath.startsWith('/lib64/')
    || filePath.startsWith('/System/')
    || filePath.startsWith('/Applications/')
    || filePath.includes('/node_modules/')
    || filePath.includes('/.node/')
    || basenameOf(filePath) === 'hosts';
}

function looksLikeCodePath(filePath: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(filePath));
}

function looksLikeContextPath(filePath: string): boolean {
  const base = basenameOf(filePath);
  if (CONTEXT_BASENAMES.has(base)) return true;
  if (CONTEXT_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  if (filePath.includes('/.claude/') || filePath.includes('/.codex/') || filePath.includes('/.cursor/')) {
    return true;
  }
  if (base.endsWith('.md') && !looksLikeCodePath(filePath)) return true;
  if (base.endsWith('.rules') || base.endsWith('.rule')) return true;
  return false;
}

/**
 * Filter traced path events into unknown context candidates.
 * Does not read file contents — path metadata only.
 */
export function classifyTrace(
  events: readonly TraceEvent[],
  stableReport: CoverageReport,
): TraceCandidate[] {
  const explained = explainedPaths(stableReport);
  const seen = new Set<string>();
  const candidates: TraceCandidate[] = [];

  for (const event of events) {
    const filePath = event.path;
    if (filePath.length === 0) continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (explained.has(filePath)) continue;
    if (isSystemLibraryPath(filePath)) continue;
    if (looksLikeCodePath(filePath)) continue;
    if (!looksLikeContextPath(filePath)) continue;

    candidates.push({
      path: filePath,
      operation: event.operation,
      reason: 'unknown-context-path',
      pid: event.pid,
      timestamp: event.timestamp,
    });
  }

  return candidates;
}
