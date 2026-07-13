import type { CompiledSection } from '../../compiler/compile.js';
import { compareCodeUnits } from '../../domain/compare.js';
import type { KnowledgeEntry } from '../../domain/model.js';
import type { RenderInput, RenderedFile } from '../adapter.js';
import {
  buildHeader,
  directoryForPathGlobs,
  formatEntryBlock,
  formatSection,
  groupPathEntries,
  knowledgeContentHash,
  sortRenderedFiles,
  toRenderedFile,
} from '../render-shared.js';

const ROOT = 'AGENTS.md';
const DEFAULT_MAX_BYTES = 32768;

function renderNestedAgents(
  directory: string,
  entries: readonly KnowledgeEntry[],
  header: string,
): { relativePath: string; text: string; sourceKnowledgeIds: string[] } {
  const body = [
    header,
    '',
    '# Path-specific',
    '',
    ...entries.map((entry) => formatEntryBlock(entry)),
  ].join('\n');
  return {
    relativePath: `${directory}/AGENTS.md`,
    text: body,
    sourceKnowledgeIds: entries.map((entry) => entry.id),
  };
}

function buildRootText(
  compiled: RenderInput['compiled'],
  sections: readonly CompiledSection[],
  pathNote: string | undefined,
  contentHashEntries: readonly KnowledgeEntry[],
): string {
  const header = buildHeader(compiled, knowledgeContentHash(contentHashEntries));
  const bodySections: string[] = [];
  for (const section of sections) {
    if (section.id === 'path') {
      if (pathNote !== undefined) {
        bodySections.push(['## Path-specific', '', pathNote].join('\n'));
      } else {
        bodySections.push(formatSection(section));
      }
      continue;
    }
    bodySections.push(formatSection(section));
  }
  return [
    header,
    '',
    '# Agent guidance',
    '',
    bodySections.join('\n\n'),
  ].join('\n');
}

function allEntries(sections: readonly CompiledSection[]): KnowledgeEntry[] {
  return sections.flatMap((section) => section.entries);
}

/**
 * Project compiled knowledge into Codex native AGENTS.md files.
 * When the root would exceed `limits.maxBytes` (default 32768), path-scoped
 * entries move into nested `AGENTS.md` files under derived directories.
 */
export function renderCodex(input: RenderInput): RenderedFile[] {
  const { compiled } = input;
  const maxBytes = input.limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const pathSection = compiled.sections.find((section) => section.id === 'path');
  const entries = allEntries(compiled.sections);

  const inlineRoot = toRenderedFile(
    ROOT,
    buildRootText(compiled, compiled.sections, undefined, entries),
    entries.map((entry) => entry.id),
  );

  if (inlineRoot.bytes.byteLength <= maxBytes || !pathSection || pathSection.entries.length === 0) {
    return sortRenderedFiles([inlineRoot], ROOT);
  }

  const pathGroups = groupPathEntries(pathSection);
  const nestedFiles: RenderedFile[] = [];
  const nestedPaths: string[] = [];

  for (const [key, groupEntries] of [...pathGroups.entries()].sort(([left], [right]) => (
    compareCodeUnits(left, right)
  ))) {
    const paths = key.length === 0 ? [] : key.split('\n');
    const directory = directoryForPathGlobs(paths);
    const header = buildHeader(compiled, knowledgeContentHash(groupEntries));
    const nested = renderNestedAgents(directory, groupEntries, header);
    nestedPaths.push(nested.relativePath);
    nestedFiles.push(toRenderedFile(nested.relativePath, nested.text, nested.sourceKnowledgeIds));
  }

  const rootEntries = compiled.sections
    .filter((section) => section.id !== 'path')
    .flatMap((section) => section.entries);
  const pathNote = [
    'Path-scoped guidance lives in nested AGENTS.md files nearest those paths.',
    ...nestedPaths.sort(compareCodeUnits).map((path) => `- ${path}`),
  ].join('\n');

  let root = toRenderedFile(
    ROOT,
    buildRootText(compiled, compiled.sections, pathNote, [
      ...rootEntries,
      ...pathSection.entries,
    ]),
    rootEntries.map((entry) => entry.id),
  );

  if (root.bytes.byteLength > maxBytes) {
    const header = buildHeader(
      compiled,
      knowledgeContentHash([...rootEntries, ...pathSection.entries]),
    );
    const compact = compiled.sections
      .filter((section) => section.id !== 'path')
      .map((section) => {
        const bullets = section.entries.map((entry) => `- ${entry.statement.trim()}`);
        return [`## ${section.title}`, '', ...bullets].join('\n');
      });
    root = toRenderedFile(
      ROOT,
      [
        header,
        '',
        '# Agent guidance',
        '',
        [...compact, ['## Path-specific', '', pathNote].join('\n')].join('\n\n'),
      ].join('\n'),
      rootEntries.map((entry) => entry.id),
    );
  }

  return sortRenderedFiles([root, ...nestedFiles], ROOT);
}
