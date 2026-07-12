import type { KnowledgeEntry } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';

export type GraphIssueCode =
  | 'DUPLICATE_ID'
  | 'MISSING_RELATION_TARGET'
  | 'SELF_RELATION'
  | 'RELATION_OVERLAP'
  | 'SUPERSEDES_CYCLE'
  | 'SUPERSEDED_WITHOUT_REPLACEMENT';

export interface GraphIssue {
  code: GraphIssueCode;
  entry_id: string;
  target_id?: string;
  relation?: 'supersedes' | 'conflicts_with';
  message: string;
}

function issueOrder(left: GraphIssue, right: GraphIssue): number {
  return compareCodeUnits(left.entry_id, right.entry_id)
    || compareCodeUnits(left.code, right.code)
    || compareCodeUnits(left.relation ?? '', right.relation ?? '')
    || compareCodeUnits(left.target_id ?? '', right.target_id ?? '');
}

export function validateKnowledgeGraph(entries: KnowledgeEntry[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      issues.push({
        code: 'DUPLICATE_ID',
        entry_id: id,
        message: `Knowledge ID ${id} occurs ${count} times`,
      });
    }
  }

  const byId = new Map<string, KnowledgeEntry>();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const incomingSupersedes = new Set<string>();

  for (const entry of entries) {
    const supersedes = new Set(entry.supersedes);
    for (const relation of ['supersedes', 'conflicts_with'] as const) {
      for (const target of entry[relation]) {
        if (target === entry.id) {
          issues.push({
            code: 'SELF_RELATION',
            entry_id: entry.id,
            target_id: target,
            relation,
            message: `${relation} must not reference the entry itself`,
          });
        }
        if (!byId.has(target)) {
          issues.push({
            code: 'MISSING_RELATION_TARGET',
            entry_id: entry.id,
            target_id: target,
            relation,
            message: `${relation} target ${target} is missing`,
          });
        }
        if (relation === 'supersedes' && target !== entry.id && byId.has(target)) {
          incomingSupersedes.add(target);
        }
      }
    }
    for (const target of entry.conflicts_with) {
      if (supersedes.has(target)) {
        issues.push({
          code: 'RELATION_OVERLAP',
          entry_id: entry.id,
          target_id: target,
          message: `Target ${target} appears in supersedes and conflicts_with`,
        });
      }
    }
  }

  for (const entry of entries) {
    if (entry.status === 'superseded' && !incomingSupersedes.has(entry.id)) {
      issues.push({
        code: 'SUPERSEDED_WITHOUT_REPLACEMENT',
        entry_id: entry.id,
        message: `Superseded knowledge ${entry.id} has no replacement`,
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleMembers = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      for (const member of stack.slice(start)) cycleMembers.add(member);
      return;
    }
    visiting.add(id);
    stack.push(id);
    const targets = [...(byId.get(id)?.supersedes ?? [])].sort(compareCodeUnits);
    for (const target of targets) if (target !== id && byId.has(target)) visit(target);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of [...byId.keys()].sort(compareCodeUnits)) visit(id);
  for (const id of cycleMembers) {
    issues.push({
      code: 'SUPERSEDES_CYCLE',
      entry_id: id,
      message: `Knowledge ${id} participates in a supersedes cycle`,
    });
  }

  return issues.sort(issueOrder);
}
