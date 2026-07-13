import type { KnowledgeEntry } from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';

export interface CompileConflict {
  left_id: string;
  right_id: string;
  reason: string;
}

function conflictKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}\0${rightId}` : `${rightId}\0${leftId}`;
}

function orderedPair(leftId: string, rightId: string): { left_id: string; right_id: string } {
  return compareCodeUnits(leftId, rightId) <= 0
    ? { left_id: leftId, right_id: rightId }
    : { left_id: rightId, right_id: leftId };
}

function isResolvedBySupersedes(left: KnowledgeEntry, right: KnowledgeEntry): boolean {
  return left.supersedes.includes(right.id) || right.supersedes.includes(left.id);
}

/**
 * Detect unresolved conflicts among the provided entries.
 * Active↔active without supersedes, or active→disputed, both fail compilation.
 */
export function detectActiveConflicts(entries: KnowledgeEntry[]): CompileConflict[] {
  const byId = new Map<string, KnowledgeEntry>();
  for (const entry of entries) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const conflicts: CompileConflict[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    for (const targetId of entry.conflicts_with) {
      const target = byId.get(targetId);
      if (target === undefined) continue;

      const key = conflictKey(entry.id, targetId);
      if (seen.has(key)) continue;

      if (target.status === 'disputed') {
        seen.add(key);
        conflicts.push({
          ...orderedPair(entry.id, targetId),
          reason: 'active knowledge conflicts with disputed knowledge',
        });
        continue;
      }

      if (target.status !== 'active') continue;
      if (isResolvedBySupersedes(entry, target)) continue;

      seen.add(key);
      conflicts.push({
        ...orderedPair(entry.id, targetId),
        reason: 'active knowledge conflict lacks a supersedes resolution',
      });
    }
  }

  return conflicts.sort((left, right) =>
    compareCodeUnits(left.left_id, right.left_id)
    || compareCodeUnits(left.right_id, right.right_id)
    || compareCodeUnits(left.reason, right.reason));
}
