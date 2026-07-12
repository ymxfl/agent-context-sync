import type { CompiledSection } from '../../compiler/compile.js';
import { compareCodeUnits } from '../../domain/compare.js';
import type { KnowledgeEntry } from '../../domain/model.js';
import type { RenderInput, RenderedFile } from '../adapter.js';
import {
  buildHeader,
  formatEntryBlock,
  formatSection,
  groupPathEntries,
  knowledgeContentHash,
  sortRenderedFiles,
  stableScopeId,
  toRenderedFile,
} from '../render-shared.js';

const ROOT = 'CLAUDE.md';
const DEFAULT_MAX_ROOT_LINES = 200;

function renderRuleFile(
  paths: readonly string[],
  entries: readonly KnowledgeEntry[],
  header: string,
): { relativePath: string; text: string; sourceKnowledgeIds: string[] } {
  const scopeId = stableScopeId(paths);
  const yamlPaths = [...paths]
    .sort(compareCodeUnits)
    .map((path) => `  - ${path}`)
    .join('\n');
  const body = [
    '---',
    'paths:',
    yamlPaths,
    '---',
    '',
    header,
    '',
    '# Path-specific',
    '',
    ...entries.map((entry) => formatEntryBlock(entry)),
  ].join('\n');
  return {
    relativePath: `.claude/rules/${scopeId}.md`,
    text: body,
    sourceKnowledgeIds: entries.map((entry) => entry.id),
  };
}

function rootSectionsWithoutPath(
  sections: readonly CompiledSection[],
  pathNote: string | undefined,
): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.id === 'path') {
      if (pathNote !== undefined) {
        parts.push(['## Path-specific', '', pathNote].join('\n'));
      }
      continue;
    }
    parts.push(formatSection(section));
  }
  return parts.join('\n\n');
}

/**
 * Project compiled knowledge into Claude Code native files.
 * Path-scoped entries become `.claude/rules/<stable-scope-id>.md`.
 * Root `CLAUDE.md` is a complete projection and never imports `AGENTS.md`.
 */
export function renderClaude(input: RenderInput): RenderedFile[] {
  const { compiled } = input;
  const maxRootLines = input.limits?.maxRootLines ?? DEFAULT_MAX_ROOT_LINES;
  const pathSection = compiled.sections.find((section) => section.id === 'path');
  const pathGroups = groupPathEntries(pathSection);
  const ruleFiles: RenderedFile[] = [];
  const rulePaths: string[] = [];

  for (const [key, entries] of [...pathGroups.entries()].sort(([left], [right]) => (
    compareCodeUnits(left, right)
  ))) {
    const paths = key.length === 0 ? [] : key.split('\n');
    const allEntriesForHash = entries;
    const contentHash = knowledgeContentHash(allEntriesForHash);
    const header = buildHeader(compiled, contentHash);
    const rule = renderRuleFile(paths, entries, header);
    rulePaths.push(rule.relativePath);
    ruleFiles.push(toRenderedFile(rule.relativePath, rule.text, rule.sourceKnowledgeIds));
  }

  const rootEntries = compiled.sections
    .filter((section) => section.id !== 'path')
    .flatMap((section) => section.entries);
  const rootHash = knowledgeContentHash([
    ...rootEntries,
    ...(pathSection?.entries ?? []),
  ]);
  const header = buildHeader(compiled, rootHash);

  let pathNote: string | undefined;
  if (rulePaths.length > 0) {
    pathNote = [
      'Path-scoped rules are loaded from `.claude/rules/` (complete projection; do not import AGENTS.md).',
      ...rulePaths.sort(compareCodeUnits).map((path) => `- ${path}`),
    ].join('\n');
  }

  let rootBody = [
    header,
    '',
    '# Agent guidance',
    '',
    rootSectionsWithoutPath(compiled.sections, pathNote),
  ].join('\n');

  // Soft line budget: if still over, drop per-entry reasons from root sections.
  if (rootBody.split('\n').length > maxRootLines) {
    const compactSections = compiled.sections
      .filter((section) => section.id !== 'path')
      .map((section) => {
        const bullets = section.entries.map((entry) => `- ${entry.statement.trim()}`);
        return [`## ${section.title}`, '', ...bullets].join('\n');
      });
    rootBody = [
      header,
      '',
      '# Agent guidance',
      '',
      [...compactSections, pathNote ? ['## Path-specific', '', pathNote].join('\n') : '']
        .filter((part) => part.length > 0)
        .join('\n\n'),
    ].join('\n');
  }

  const root = toRenderedFile(
    ROOT,
    rootBody,
    rootEntries.map((entry) => entry.id),
  );

  return sortRenderedFiles([root, ...ruleFiles], ROOT);
}
