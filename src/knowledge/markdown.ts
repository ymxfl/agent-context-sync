import { parse, stringify } from 'yaml';
import type {
  KnowledgeEntry,
  KnowledgeParseContext,
  KnowledgeScope,
} from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';
import { parseKnowledgeEntry } from '../schema/knowledge.js';

type KnowledgeFrontmatter = Omit<KnowledgeEntry, 'statement' | 'reason'>;

function contextForScope(scope: unknown): KnowledgeParseContext | undefined {
  if (typeof scope !== 'string' || !scope.startsWith('repository:')) return undefined;
  return {
    registeredRepositoryIds: new Set([scope.slice('repository:'.length)]),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function canonicalEntry(entry: KnowledgeEntry): KnowledgeEntry {
  const validated = parseKnowledgeEntry(entry, contextForScope(entry.scope));
  return {
    ...validated,
    applies_to: {
      paths: [...validated.applies_to.paths].sort(compareCodeUnits),
      agents: [...validated.applies_to.agents].sort(compareCodeUnits),
    },
    supersedes: [...validated.supersedes].sort(compareCodeUnits),
    conflicts_with: [...validated.conflicts_with].sort(compareCodeUnits),
    statement: normalizeText(validated.statement),
    reason: normalizeText(validated.reason),
  };
}

export function serializeKnowledge(entry: KnowledgeEntry): string {
  const canonical = canonicalEntry(entry);
  const { statement, reason, ...frontmatter } = canonical;
  const yaml = stringify(frontmatter, {
    lineWidth: 0,
    sortMapEntries: true,
  }).replace(/\r\n?/g, '\n').trimEnd();
  return `---\n${yaml}\n---\n\n${statement}\n\n## Reason\n\n${reason}\n`;
}

export function parseKnowledgeMarkdown(
  text: string,
  context?: KnowledgeParseContext,
): KnowledgeEntry {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('Knowledge Markdown must begin with YAML frontmatter');
  }
  const frontmatterEnd = normalized.indexOf('\n---\n', 4);
  if (frontmatterEnd === -1) {
    throw new Error('Knowledge Markdown frontmatter is not terminated');
  }
  const body = normalized.slice(frontmatterEnd + 5).replace(/\n+$/, '');
  const reasonMarker = '\n\n## Reason\n\n';
  const reasonIndex = body.indexOf(reasonMarker);
  if (reasonIndex === -1 || body.indexOf(reasonMarker, reasonIndex + 1) !== -1) {
    throw new Error('Knowledge Markdown must contain one Reason section');
  }

  const raw = parse(normalized.slice(4, frontmatterEnd)) as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Knowledge Markdown frontmatter must be a mapping');
  }
  const scope = raw.scope as KnowledgeScope | undefined;
  return parseKnowledgeEntry({
    ...raw,
    statement: body.slice(0, reasonIndex),
    reason: body.slice(reasonIndex + reasonMarker.length),
  }, context ?? contextForScope(scope));
}
