import type { KnowledgeEntry } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';
import { appError } from '../domain/errors.js';
import { detectActiveConflicts } from './conflicts.js';
import {
  SECTION_ORDER,
  classifyKnowledgeSection,
  selectKnowledge,
  type SectionId,
  type SelectionInput,
} from './select.js';

export interface CompileTarget {
  repoId: string;
  agent: string;
  relativePath?: string;
  workspaceId?: string;
  contextHead?: string;
}

export interface CompileInput {
  entries: KnowledgeEntry[];
  target: CompileTarget;
}

export interface CompiledSection {
  id: SectionId;
  title: string;
  entries: KnowledgeEntry[];
}

export interface CompiledContext {
  workspace_id?: string;
  context_head?: string;
  agent: string;
  repo_id: string;
  relative_path?: string;
  sections: CompiledSection[];
}

const SECTION_TITLES: Record<SectionId, string> = {
  workspace: 'Workspace',
  repository: 'Repository',
  path: 'Path-specific',
  agent: 'Agent-specific',
  'active-work': 'Active work',
};

function selectionFromTarget(target: CompileTarget): Omit<SelectionInput, 'entries'> {
  return {
    repoId: target.repoId,
    agent: target.agent,
    relativePath: target.relativePath,
  };
}

function conflictCheckEntries(
  selected: KnowledgeEntry[],
  allEntries: KnowledgeEntry[],
): KnowledgeEntry[] {
  const byId = new Map<string, KnowledgeEntry>();
  for (const entry of selected) byId.set(entry.id, entry);
  for (const entry of allEntries) {
    if (entry.status === 'disputed' && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}

function groupIntoSections(
  selected: KnowledgeEntry[],
  repoId: string,
): CompiledSection[] {
  const buckets = new Map<SectionId, KnowledgeEntry[]>(
    SECTION_ORDER.map((id) => [id, []]),
  );

  for (const entry of selected) {
    const sectionId = classifyKnowledgeSection(entry, repoId);
    buckets.get(sectionId)!.push(entry);
  }

  const sections: CompiledSection[] = [];
  for (const id of SECTION_ORDER) {
    const entries = buckets.get(id)!;
    if (entries.length === 0) continue;
    entries.sort((left, right) => compareCodeUnits(left.id, right.id));
    sections.push({
      id,
      title: SECTION_TITLES[id],
      entries,
    });
  }
  return sections;
}

export function compileSections(input: CompileInput): CompiledContext {
  const selected = selectKnowledge({
    entries: input.entries,
    ...selectionFromTarget(input.target),
  });

  const conflicts = detectActiveConflicts(
    conflictCheckEntries(selected, input.entries),
  );
  if (conflicts.length > 0) {
    throw appError(
      'ACTIVE_KNOWLEDGE_CONFLICT',
      'Active knowledge contains unresolved conflicts',
      { conflicts },
    );
  }

  const context: CompiledContext = {
    agent: input.target.agent,
    repo_id: input.target.repoId,
    sections: groupIntoSections(selected, input.target.repoId),
  };
  if (input.target.workspaceId !== undefined) {
    context.workspace_id = input.target.workspaceId;
  }
  if (input.target.contextHead !== undefined) {
    context.context_head = input.target.contextHead;
  }
  if (input.target.relativePath !== undefined) {
    context.relative_path = input.target.relativePath;
  }
  return context;
}
