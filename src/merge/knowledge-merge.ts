import { createHash } from 'node:crypto';

import { compareCodeUnits } from '../domain/compare.js';
import type { KnowledgeEntry } from '../domain/model.js';
import { serializeKnowledge } from '../knowledge/markdown.js';

export type MergeConflictType =
  | 'SAME_ENTRY_EDIT'
  | 'STATUS_CHANGE'
  | 'SUPERSEDES_CONFLICT'
  | 'CONFLICTS_WITH'
  | 'SEMANTIC_CONTRADICTION';

/** One knowledge-level conflict requiring Agent resolution. */
export interface MergeConflict {
  conflict_id: string;
  type: MergeConflictType;
  knowledge_id: string;
  related_ids: string[];
  base?: KnowledgeEntry;
  local?: KnowledgeEntry;
  remote?: KnowledgeEntry;
  reason: string;
}

/** Result of classifying three Knowledge stores for reconcile. */
export interface MergeResult {
  automatic: string[];
  merged: KnowledgeEntry[];
  conflicts: MergeConflict[];
}

function fingerprint(entry: KnowledgeEntry | undefined): string {
  if (entry === undefined) return '';
  return createHash('sha256').update(serializeKnowledge(entry)).digest('hex');
}

function byId(entries: readonly KnowledgeEntry[]): Map<string, KnowledgeEntry> {
  const map = new Map<string, KnowledgeEntry>();
  for (const entry of entries) {
    if (!map.has(entry.id)) map.set(entry.id, entry);
  }
  return map;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function conflictId(type: MergeConflictType, ids: readonly string[]): string {
  const digest = createHash('sha256')
    .update(`${type}:${[...ids].sort(compareCodeUnits).join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return `conflict_${digest}`;
}

function classifySameEntry(
  id: string,
  base: KnowledgeEntry | undefined,
  local: KnowledgeEntry | undefined,
  remote: KnowledgeEntry | undefined,
): { automatic?: KnowledgeEntry; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const localFp = fingerprint(local);
  const remoteFp = fingerprint(remote);
  const baseFp = fingerprint(base);

  if (local === undefined && remote === undefined) {
    return { conflicts };
  }
  if (local !== undefined && remote === undefined) {
    // Deleted on remote while local kept/edited, or local-only add.
    if (base === undefined) return { automatic: local, conflicts };
    if (localFp === baseFp) {
      // Remote deleted unchanged entry — treat as remote deletion (omit).
      return { conflicts };
    }
    conflicts.push({
      conflict_id: conflictId('SAME_ENTRY_EDIT', [id]),
      type: 'SAME_ENTRY_EDIT',
      knowledge_id: id,
      related_ids: [id],
      ...(base === undefined ? {} : { base }),
      local,
      reason: 'Local edited an entry that remote deleted',
    });
    return { conflicts };
  }
  if (local === undefined && remote !== undefined) {
    if (base === undefined) return { automatic: remote, conflicts };
    if (remoteFp === baseFp) return { conflicts };
    conflicts.push({
      conflict_id: conflictId('SAME_ENTRY_EDIT', [id]),
      type: 'SAME_ENTRY_EDIT',
      knowledge_id: id,
      related_ids: [id],
      ...(base === undefined ? {} : { base }),
      remote,
      reason: 'Remote edited an entry that local deleted',
    });
    return { conflicts };
  }

  // Both present.
  const localEntry = local as KnowledgeEntry;
  const remoteEntry = remote as KnowledgeEntry;

  if (localFp === remoteFp) {
    return { automatic: localEntry, conflicts };
  }
  if (base !== undefined && localFp === baseFp) {
    return { automatic: remoteEntry, conflicts };
  }
  if (base !== undefined && remoteFp === baseFp) {
    return { automatic: localEntry, conflicts };
  }

  const statusDiverged = localEntry.status !== remoteEntry.status
    && (base === undefined
      || localEntry.status !== base.status
      || remoteEntry.status !== base.status);
  const supersedesDiverged = !sameStringSet(localEntry.supersedes, remoteEntry.supersedes)
    && (base === undefined
      || !sameStringSet(localEntry.supersedes, base.supersedes)
      || !sameStringSet(remoteEntry.supersedes, base.supersedes));
  const conflictsWithDiverged = !sameStringSet(localEntry.conflicts_with, remoteEntry.conflicts_with)
    && (base === undefined
      || !sameStringSet(localEntry.conflicts_with, base.conflicts_with)
      || !sameStringSet(remoteEntry.conflicts_with, base.conflicts_with));

  if (statusDiverged) {
    conflicts.push({
      conflict_id: conflictId('STATUS_CHANGE', [id]),
      type: 'STATUS_CHANGE',
      knowledge_id: id,
      related_ids: [id],
      ...(base === undefined ? {} : { base }),
      local: localEntry,
      remote: remoteEntry,
      reason: 'Local and remote changed status differently',
    });
  }
  if (supersedesDiverged) {
    conflicts.push({
      conflict_id: conflictId('SUPERSEDES_CONFLICT', [id]),
      type: 'SUPERSEDES_CONFLICT',
      knowledge_id: id,
      related_ids: sortedUnique([id, ...localEntry.supersedes, ...remoteEntry.supersedes]),
      ...(base === undefined ? {} : { base }),
      local: localEntry,
      remote: remoteEntry,
      reason: 'Local and remote declare competing supersedes relations',
    });
  }
  if (conflictsWithDiverged) {
    conflicts.push({
      conflict_id: conflictId('CONFLICTS_WITH', [id]),
      type: 'CONFLICTS_WITH',
      knowledge_id: id,
      related_ids: sortedUnique([
        id,
        ...localEntry.conflicts_with,
        ...remoteEntry.conflicts_with,
      ]),
      ...(base === undefined ? {} : { base }),
      local: localEntry,
      remote: remoteEntry,
      reason: 'Local and remote declare divergent conflicts_with relations',
    });
  }

  const payloadDiverged = localEntry.statement !== remoteEntry.statement
    || localEntry.reason !== remoteEntry.reason
    || localEntry.kind !== remoteEntry.kind
    || localEntry.scope !== remoteEntry.scope
    || localEntry.confidence !== remoteEntry.confidence
    || !sameStringSet(localEntry.applies_to.paths, remoteEntry.applies_to.paths)
    || !sameStringSet(localEntry.applies_to.agents, remoteEntry.applies_to.agents)
    || JSON.stringify(localEntry.source) !== JSON.stringify(remoteEntry.source);

  // Emit SAME_ENTRY_EDIT for payload divergence, or when no more-specific conflict covers
  // the byte-level difference (e.g. timestamp-only drift still needs Agent review).
  if (payloadDiverged || conflicts.length === 0) {
    conflicts.push({
      conflict_id: conflictId('SAME_ENTRY_EDIT', [id]),
      type: 'SAME_ENTRY_EDIT',
      knowledge_id: id,
      related_ids: [id],
      ...(base === undefined ? {} : { base }),
      local: localEntry,
      remote: remoteEntry,
      reason: 'Local and remote edited the same knowledge entry differently',
    });
  }

  const seen = new Set<string>();
  const unique = conflicts.filter((item) => {
    if (seen.has(item.conflict_id)) return false;
    seen.add(item.conflict_id);
    return true;
  });
  return { conflicts: unique };
}

function isSemanticPair(left: KnowledgeEntry, right: KnowledgeEntry): boolean {
  if (left.id === right.id) return false;
  if (left.conflicts_with.includes(right.id) || right.conflicts_with.includes(left.id)) {
    return true;
  }
  return left.supersedes.some((target) => right.supersedes.includes(target));
}

/**
 * Classify three Knowledge stores into automatic merges and Agent-facing conflicts.
 * Different IDs and byte-identical edits auto-merge; semantic contradictions never do silently.
 */
export function threeWayKnowledgeMerge(
  base: readonly KnowledgeEntry[],
  local: readonly KnowledgeEntry[],
  remote: readonly KnowledgeEntry[],
): MergeResult {
  const baseMap = byId(base);
  const localMap = byId(local);
  const remoteMap = byId(remote);
  const ids = sortedUnique([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);

  const automatic: string[] = [];
  const merged: KnowledgeEntry[] = [];
  const conflicts: MergeConflict[] = [];
  const conflictedIds = new Set<string>();

  for (const id of ids) {
    const classified = classifySameEntry(
      id,
      baseMap.get(id),
      localMap.get(id),
      remoteMap.get(id),
    );
    if (classified.conflicts.length > 0) {
      conflicts.push(...classified.conflicts);
      for (const item of classified.conflicts) {
        conflictedIds.add(item.knowledge_id);
        for (const related of item.related_ids) conflictedIds.add(related);
      }
      continue;
    }
    if (classified.automatic !== undefined) {
      automatic.push(id);
      merged.push(classified.automatic);
    }
  }

  // Cross-ID semantic contradictions among candidates that would otherwise auto-merge.
  const candidateEntries = merged.filter((entry) => !conflictedIds.has(entry.id));
  const localOnlyAdds = [...localMap.values()].filter(
    (entry) => !baseMap.has(entry.id) && !remoteMap.has(entry.id),
  );
  const remoteOnlyAdds = [...remoteMap.values()].filter(
    (entry) => !baseMap.has(entry.id) && !localMap.has(entry.id),
  );

  const semanticSeen = new Set<string>();
  for (const left of localOnlyAdds) {
    for (const right of remoteOnlyAdds) {
      if (!isSemanticPair(left, right)) continue;
      const key = [left.id, right.id].sort(compareCodeUnits).join(':');
      if (semanticSeen.has(key)) continue;
      semanticSeen.add(key);
      conflictedIds.add(left.id);
      conflictedIds.add(right.id);
      conflicts.push({
        conflict_id: conflictId('SEMANTIC_CONTRADICTION', [left.id, right.id]),
        type: 'SEMANTIC_CONTRADICTION',
        knowledge_id: compareCodeUnits(left.id, right.id) <= 0 ? left.id : right.id,
        related_ids: sortedUnique([left.id, right.id]),
        local: left,
        remote: right,
        reason: 'Local and remote added potentially contradictory knowledge under overlapping scope',
      });
    }
  }

  // Also check auto-merged pairs that include one-sided adds against unchanged base peers.
  for (let i = 0; i < candidateEntries.length; i += 1) {
    for (let j = i + 1; j < candidateEntries.length; j += 1) {
      const left = candidateEntries[i]!;
      const right = candidateEntries[j]!;
      const leftIsNew = !baseMap.has(left.id);
      const rightIsNew = !baseMap.has(right.id);
      if (!leftIsNew && !rightIsNew) continue;
      // Only flag when the two sides contributed different new IDs.
      const leftFromLocal = localMap.has(left.id) && !remoteMap.has(left.id);
      const leftFromRemote = remoteMap.has(left.id) && !localMap.has(left.id);
      const rightFromLocal = localMap.has(right.id) && !remoteMap.has(right.id);
      const rightFromRemote = remoteMap.has(right.id) && !localMap.has(right.id);
      const crossSide = (leftFromLocal && rightFromRemote) || (leftFromRemote && rightFromLocal);
      if (!crossSide) continue;
      if (!isSemanticPair(left, right)) continue;
      const key = [left.id, right.id].sort(compareCodeUnits).join(':');
      if (semanticSeen.has(key)) continue;
      semanticSeen.add(key);
      conflictedIds.add(left.id);
      conflictedIds.add(right.id);
      conflicts.push({
        conflict_id: conflictId('SEMANTIC_CONTRADICTION', [left.id, right.id]),
        type: 'SEMANTIC_CONTRADICTION',
        knowledge_id: compareCodeUnits(left.id, right.id) <= 0 ? left.id : right.id,
        related_ids: sortedUnique([left.id, right.id]),
        local: leftFromLocal ? left : rightFromLocal ? right : left,
        remote: leftFromRemote ? left : rightFromRemote ? right : right,
        reason: 'Local and remote added potentially contradictory knowledge under overlapping scope',
      });
    }
  }

  const filteredMerged = merged.filter((entry) => !conflictedIds.has(entry.id));
  const filteredAutomatic = automatic.filter((id) => !conflictedIds.has(id));

  conflicts.sort((left, right) =>
    compareCodeUnits(left.type, right.type)
    || compareCodeUnits(left.knowledge_id, right.knowledge_id)
    || compareCodeUnits(left.conflict_id, right.conflict_id));

  return {
    automatic: filteredAutomatic.sort(compareCodeUnits),
    merged: filteredMerged.sort((left, right) => compareCodeUnits(left.id, right.id)),
    conflicts,
  };
}
