import { parse, stringify } from 'yaml';
import type {
  KnowledgeEntry,
  KnowledgeParseContext,
  KnowledgeScope,
} from '../domain/model.js';
import { compareCodeUnits } from '../domain/compare.js';
import { parseKnowledgeEntry } from '../schema/knowledge.js';

function contextForScope(scope: unknown): KnowledgeParseContext | undefined {
  if (typeof scope !== 'string' || !scope.startsWith('repository:')) return undefined;
  return {
    registeredRepositoryIds: new Set([scope.slice('repository:'.length)]),
  };
}

function containsPrivateLocalPath(value: string): boolean {
  // Remove only narrowly identifiable web spans. Route targets intentionally stop
  // at prose punctuation so a later absolute path cannot hide inside the match.
  const withoutWebUrls = value.replace(
    /\bhttps?:\/\/(?!\/)[^\s<>`"'{},;!$()[\]]+/gi,
    (candidate) => {
      try {
        const parsed = new URL(candidate);
        if (/^https?:$/.test(parsed.protocol) && parsed.hostname.length > 0) return '';
      } catch {
        // Leave invalid URL-like text in place for the fail-closed path scan.
      }
      return candidate;
    },
  );
  const withoutExplicitRoutes = withoutWebUrls
    .replace(/\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)\s+\/(?!\/)[a-z0-9._~&+\-\/=:@%?]*/gi, '')
    .replace(/\b(?:URI|route|endpoint)\s*[:=]\s*\/(?!\/)[a-z0-9._~&+\-\/=:@%?]*/gi, '');
  return /(?:^|[^a-z0-9._*?+\-])\/{1,2}(?=[^\s/]|\/(?=[^\s/])|\s|$)/i
    .test(withoutExplicitRoutes)
    || /(?:^|[^a-z0-9])[a-z]:[\\/]/i.test(value)
    || /\\\\[^\\\s]+\\[^\\\s]+/.test(value)
    || /(?:^|[^a-z0-9])file:/i.test(value);
}

function assertNoPrivateLocalPaths(value: unknown): void {
  if (typeof value === 'string') {
    if (containsPrivateLocalPath(value)) {
      throw new Error('Knowledge contains a private local path');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateLocalPaths(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoPrivateLocalPaths(item);
  }
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
  assertNoPrivateLocalPaths(canonical);
  const yaml = stringify(canonical, {
    lineWidth: 0,
    sortMapEntries: true,
  }).replace(/\r\n?/g, '\n').trimEnd();
  return `---\n${yaml}\n---\n\n${canonical.statement}\n\n## Reason\n\n${canonical.reason}\n`;
}

export function parseKnowledgeMarkdown(
  text: string,
  context?: KnowledgeParseContext,
): KnowledgeEntry {
  const normalized = text.replace(/\r\n?/g, '\n');
  assertNoPrivateLocalPaths(normalized);
  if (!normalized.startsWith('---\n')) {
    throw new Error('Knowledge Markdown must begin with YAML frontmatter');
  }
  const frontmatterEnd = normalized.indexOf('\n---\n', 4);
  if (frontmatterEnd === -1) {
    throw new Error('Knowledge Markdown frontmatter is not terminated');
  }
  const raw = parse(normalized.slice(4, frontmatterEnd)) as Record<string, unknown>;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Knowledge Markdown frontmatter must be a mapping');
  }
  const scope = raw.scope as KnowledgeScope | undefined;
  const entry = parseKnowledgeEntry(raw, context ?? contextForScope(scope));
  assertNoPrivateLocalPaths(entry);
  return entry;
}
