import { minimatch } from 'minimatch';
import type { KnowledgeEntry } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';

export interface SelectionInput {
  entries: KnowledgeEntry[];
  repoId: string;
  agent: string;
  relativePath?: string;
}

export const SECTION_ORDER = [
  'workspace',
  'repository',
  'path',
  'agent',
  'active-work',
] as const;

export type SectionId = (typeof SECTION_ORDER)[number];

const SECTION_RANK = new Map<SectionId, number>(
  SECTION_ORDER.map((id, index) => [id, index]),
);

/**
 * Assign each selected entry to exactly one section.
 * More specific wins: active-work → path → agent → repository/workspace.
 * Path-scoped knowledge with agent filters still lands in `path`.
 */
export function classifyKnowledgeSection(
  entry: KnowledgeEntry,
  repoId: string,
): SectionId {
  if (entry.kind === 'active-work') return 'active-work';
  if (entry.applies_to.paths.length > 0) return 'path';
  if (entry.applies_to.agents.length > 0) return 'agent';
  if (entry.scope === `repository:${repoId}`) return 'repository';
  return 'workspace';
}

function agentMatches(entry: KnowledgeEntry, agent: string): boolean {
  const agents = entry.applies_to.agents;
  return agents.length === 0 || agents.includes(agent);
}

function pathMatches(entry: KnowledgeEntry, relativePath: string | undefined): boolean {
  const paths = entry.applies_to.paths;
  if (paths.length === 0) return true;
  // Repo-level projections omit relativePath and must include all path-scoped
  // entries (still filtered by scope/agent/status). Path-level queries filter
  // with POSIX globs.
  if (relativePath === undefined) return true;
  return paths.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
}

function scopeMatches(entry: KnowledgeEntry, repoId: string): boolean {
  return entry.scope === 'workspace' || entry.scope === `repository:${repoId}`;
}

export function isKnowledgeApplicable(
  entry: KnowledgeEntry,
  input: Pick<SelectionInput, 'repoId' | 'agent' | 'relativePath'>,
): boolean {
  if (entry.status !== 'active') return false;
  if (!scopeMatches(entry, input.repoId)) return false;
  if (!agentMatches(entry, input.agent)) return false;
  if (!pathMatches(entry, input.relativePath)) return false;
  return true;
}

function compareSelected(
  left: KnowledgeEntry,
  right: KnowledgeEntry,
  repoId: string,
): number {
  const leftRank = SECTION_RANK.get(classifyKnowledgeSection(left, repoId)) ?? 0;
  const rightRank = SECTION_RANK.get(classifyKnowledgeSection(right, repoId)) ?? 0;
  return leftRank - rightRank || compareCodeUnits(left.id, right.id);
}

export function selectKnowledge(input: SelectionInput): KnowledgeEntry[] {
  return input.entries
    .filter((entry) => isKnowledgeApplicable(entry, input))
    .sort((left, right) => compareSelected(left, right, input.repoId));
}
