import type { Dirent, Stats } from 'node:fs';
import {
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { compareCodeUnits } from '../../domain/compare.js';
import { parse as parseYaml } from 'yaml';
import {
  ADAPTER_CONTRACT_VERSION,
  COVERAGE_CONTRACT_VERSION,
  type AdapterContractMetadata,
  type AgentAdapter,
  type ContextSource,
  type CoverageItem,
  type CoverageReport,
  type DiscoveryInput,
  type LoadOrder,
  type RenderInput,
  type RenderedFile,
  type Shareability,
} from '../adapter.js';
import { renderClaude } from './render.js';

interface ClaudeSettings {
  claudeMd?: unknown;
  claudeMdExcludes?: unknown;
  autoMemoryDirectory?: unknown;
}

interface SettingsLayer {
  kind: 'managed' | 'user' | 'project' | 'local' | 'explicit';
  locator: string;
  required: boolean;
}

interface FoundInstruction {
  locator: string;
  sourceType: string;
  shareability: Shareability;
  loading: 'eager' | 'on-demand' | 'reported-only';
}

export interface ClaudeFileSystem {
  readFile(path: string): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
}

const defaultFileSystem: ClaudeFileSystem = {
  readFile: (path) => nodeReadFile(path, 'utf8'),
  readdir: (path, options) => nodeReaddir(path, options),
  realpath: (path) => nodeRealpath(path),
  stat: (path) => nodeStat(path),
};

const AGENT = 'claude-code' as const;

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function coverage(
  id: string,
  status: CoverageItem['status'],
  detail: string,
  locator?: string,
): CoverageItem {
  return { id, status, detail, ...(locator === undefined ? {} : { locator }) };
}

async function readableFile(
  fs: ClaudeFileSystem,
  path: string,
): Promise<'file' | 'missing' | 'inaccessible'> {
  try {
    if (!(await fs.stat(path)).isFile()) return 'missing';
    await fs.readFile(path);
    return 'file';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'inaccessible';
  }
}

async function walkMarkdown(
  fs: ClaudeFileSystem,
  root: string,
): Promise<{ files: string[]; inaccessible: string[]; escapes: string[] }> {
  const files: string[] = [];
  const inaccessible: string[] = [];
  const escapes: string[] = [];
  const visited = new Set<string>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessible.push(root);
    return { files, inaccessible, escapes };
  }

  async function visit(directory: string): Promise<void> {
    let canonical: string;
    try {
      canonical = await fs.realpath(directory);
    } catch {
      inaccessible.push(directory);
      return;
    }
    if (!isInside(canonicalRoot, canonical)) {
      escapes.push(directory);
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      inaccessible.push(directory);
      return;
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        let target;
        try {
          target = await fs.stat(path);
        } catch {
          inaccessible.push(path);
          continue;
        }
        if (target.isDirectory()) await visit(path);
        else if (target.isFile() && entry.name.endsWith('.md')) {
          try {
            const canonicalFile = await fs.realpath(path);
            if (isInside(canonicalRoot, canonicalFile)) files.push(path);
            else escapes.push(path);
          } catch {
            inaccessible.push(path);
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path);
      }
    }
  }

  try {
    if ((await fs.stat(root)).isDirectory()) await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inaccessible.push(root);
  }
  return {
    files: uniqueSorted(files),
    inaccessible: uniqueSorted(inaccessible),
    escapes: uniqueSorted(escapes),
  };
}

function stripCode(markdown: string): string {
  const visible: string[] = [];
  let fence: { marker: string; size: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === undefined) fence = { marker, size: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.size) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    visible.push(line);
  }
  const withoutFences = visible.join('\n');
  let output = '';
  let index = 0;
  while (index < withoutFences.length) {
    if (withoutFences[index] !== '`') {
      output += withoutFences[index];
      index += 1;
      continue;
    }
    let openingEnd = index;
    while (withoutFences[openingEnd] === '`') openingEnd += 1;
    const delimiterLength = openingEnd - index;
    let search = openingEnd;
    let closingEnd = -1;
    while (search < withoutFences.length) {
      if (withoutFences[search] !== '`') {
        search += 1;
        continue;
      }
      let runEnd = search;
      while (withoutFences[runEnd] === '`') runEnd += 1;
      if (runEnd - search === delimiterLength) {
        closingEnd = runEnd;
        break;
      }
      search = runEnd;
    }
    if (closingEnd === -1) {
      output += withoutFences.slice(index, openingEnd);
      index = openingEnd;
    } else {
      output += ' '.repeat(closingEnd - index);
      index = closingEnd;
    }
  }
  return output;
}

function importedPaths(markdown: string): string[] {
  const imports: string[] = [];
  const pattern = /(?:^|\s)@([^\s`]+)/gm;
  for (const match of stripCode(markdown).matchAll(pattern)) {
    const value = match[1].replace(/[),.;:]+$/, '');
    if (value.length > 0) imports.push(value);
  }
  return imports;
}

function resolveTilde(path: string, homeDir: string): string {
  return path === '~' ? homeDir : path.startsWith(`~${sep}`) || path.startsWith('~/')
    ? join(homeDir, path.slice(2))
    : path;
}

function rulePaths(markdown: string): string[] | undefined {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  try {
    const parsed = parseYaml(match[1]) as { paths?: unknown } | null;
    if (typeof parsed?.paths === 'string') return [parsed.paths];
    if (Array.isArray(parsed?.paths) && parsed.paths.every((item) => typeof item === 'string')) {
      return parsed.paths;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly metadata: AdapterContractMetadata = {
    agent: AGENT,
    contractVersion: ADAPTER_CONTRACT_VERSION,
    coverageVersion: COVERAGE_CONTRACT_VERSION,
    supported: true,
  };

  private readonly fs: ClaudeFileSystem;

  constructor(fs: Partial<ClaudeFileSystem> = {}) {
    this.fs = { ...defaultFileSystem, ...fs };
  }

  render(input: RenderInput): RenderedFile[] {
    return renderClaude(input);
  }

  async discover(input: DiscoveryInput): Promise<CoverageReport> {
    const repositoryRoot = resolve(input.repositoryRoot);
    const cwd = resolve(input.cwd);
    const homeDir = resolve(input.homeDir || homedir());
    const sources: ContextSource[] = [];
    const coverageItems: CoverageItem[] = [];
    const foundInstructions: FoundInstruction[] = [];
    let canonicalRepositoryRoot = repositoryRoot;
    const managedInputsSupplied = input.managedSettingsPaths !== undefined
      && input.managedInstructionPaths !== undefined;
    const additionalInputsSupplied = input.additionalDirectories !== undefined;
    if (!managedInputsSupplied) {
      coverageItems.push(coverage(
        'claude-managed-inputs',
        'unknown',
        'Managed settings and instruction locations were not supplied, so managed coverage cannot be confirmed.',
      ));
    }
    if (!additionalInputsSupplied) {
      coverageItems.push(coverage(
        'claude-additional-directory-inputs',
        'unknown',
        'Additional-directory inputs were not supplied, so their coverage cannot be confirmed.',
      ));
    }
    try {
      canonicalRepositoryRoot = await this.fs.realpath(repositoryRoot);
    } catch {
      coverageItems.push(coverage(
        'claude-repository-root-inaccessible',
        'inaccessible',
        'The repository root could not be canonicalized.',
        repositoryRoot,
      ));
    }
    const safeShareability = async (path: string, intended: Shareability): Promise<Shareability> => {
      if (intended !== 'team') return intended;
      try {
        return isInside(canonicalRepositoryRoot, await this.fs.realpath(path)) ? 'team' : 'personal';
      } catch {
        return 'personal';
      }
    };

    if (!isInside(repositoryRoot, cwd)) {
      coverageItems.push(coverage(
        'claude-cwd-outside-repository',
        'unknown',
        'The working directory is outside the repository root; ancestor loading cannot be confirmed.',
        cwd,
      ));
    }

    const layers: SettingsLayer[] = [
      ...(input.managedSettingsPaths ?? []).map((locator) => ({ kind: 'managed' as const, locator, required: true })),
      { kind: 'user', locator: join(homeDir, '.claude/settings.json'), required: false },
      { kind: 'project', locator: join(repositoryRoot, '.claude/settings.json'), required: false },
      { kind: 'local', locator: join(repositoryRoot, '.claude/settings.local.json'), required: false },
      ...(input.explicitSettingsPaths ?? []).map((locator) => ({ kind: 'explicit' as const, locator, required: true })),
    ];
    const parsedLayers: Array<SettingsLayer & { settings: ClaudeSettings }> = [];
    for (const layer of layers) {
      try {
        const text = await this.fs.readFile(layer.locator);
        const settings = JSON.parse(text) as ClaudeSettings;
        if (settings === null || Array.isArray(settings) || typeof settings !== 'object') throw new Error('not an object');
        parsedLayers.push({ ...layer, settings });
        coverageItems.push(coverage('claude-settings', 'covered', `${layer.kind} settings parsed.`, layer.locator));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !layer.required) continue;
        coverageItems.push(coverage(
          code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
            ? 'claude-settings-inaccessible'
            : 'claude-settings-invalid',
          code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' ? 'inaccessible' : 'unknown',
          code === 'ENOENT'
            ? 'Configured settings path does not exist.'
            : code === 'EACCES' || code === 'EPERM'
              ? 'Configured settings path is unreadable.'
              : 'Settings JSON is invalid.',
          layer.locator,
        ));
      }
    }

    const excludes = uniqueSorted(parsedLayers.flatMap(({ settings }) =>
      Array.isArray(settings.claudeMdExcludes)
        ? settings.claudeMdExcludes.filter((item): item is string => typeof item === 'string')
        : [],
    ));
    const isExcluded = (path: string): boolean => excludes.some((pattern) =>
      minimatch(path, resolveTilde(pattern, homeDir), { dot: true }),
    );

    for (const path of uniqueSorted(input.managedInstructionPaths ?? [])) {
      const status = await readableFile(this.fs, path);
      if (status === 'file') {
        foundInstructions.push({
          locator: path,
          sourceType: 'managed-instructions',
          shareability: 'managed',
          loading: 'reported-only',
        });
      } else {
        coverageItems.push(coverage(
          'claude-managed-inaccessible',
          status === 'inaccessible' ? 'inaccessible' : 'unknown',
          status === 'inaccessible' ? 'Managed instructions are unreadable.' : 'Managed instructions do not exist.',
          path,
        ));
      }
    }
    for (const { locator, settings } of parsedLayers.filter((layer) => layer.kind === 'managed')) {
      if (typeof settings.claudeMd === 'string' && settings.claudeMd.length > 0) {
        foundInstructions.push({
          locator: `${locator}#claudeMd`,
          sourceType: 'managed-instructions',
          shareability: 'managed',
          loading: 'reported-only',
        });
      }
    }

    const userInstruction = join(homeDir, '.claude/CLAUDE.md');
    const userInstructionStatus = await readableFile(this.fs, userInstruction);
    if (userInstructionStatus === 'file') {
      foundInstructions.push({
        locator: userInstruction,
        sourceType: 'user-instructions',
        shareability: 'personal',
        loading: 'eager',
      });
    } else if (userInstructionStatus === 'inaccessible') {
      coverageItems.push(coverage('claude-instruction-inaccessible', 'inaccessible', 'User instructions are unreadable.', userInstruction));
    }

    const ancestorDirectories: string[] = [];
    let ancestor = cwd;
    while (true) {
      ancestorDirectories.push(ancestor);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    ancestorDirectories.reverse();

    const eager = new Set<string>();
    for (const directory of ancestorDirectories) {
      const candidates = [
        { path: join(directory, 'CLAUDE.md'), sourceType: 'project-instructions', shareability: 'team' as const },
        { path: join(directory, '.claude/CLAUDE.md'), sourceType: 'project-instructions', shareability: 'team' as const },
        { path: join(directory, 'CLAUDE.local.md'), sourceType: 'local-instructions', shareability: 'personal' as const },
      ];
      for (const candidate of candidates) {
        if (candidate.path === userInstruction) continue;
        const candidateStatus = await readableFile(this.fs, candidate.path);
        if (candidateStatus !== 'file') {
          if (candidateStatus === 'inaccessible') {
            coverageItems.push(coverage('claude-instruction-inaccessible', 'inaccessible', 'Instruction file is unreadable.', candidate.path));
          }
          continue;
        }
        eager.add(candidate.path);
        if (isExcluded(candidate.path)) {
          coverageItems.push(coverage('claude-excluded', 'partial', 'Instruction file matched claudeMdExcludes.', candidate.path));
          continue;
        }
        foundInstructions.push({
          ...candidate,
          locator: candidate.path,
          shareability: await safeShareability(candidate.path, candidate.shareability),
          loading: 'eager',
        });
      }
    }

    const descendants = await walkMarkdown(this.fs, repositoryRoot);
    for (const path of descendants.files) {
      const name = path.slice(path.lastIndexOf(sep) + 1);
      if (name !== 'CLAUDE.md' && name !== 'CLAUDE.local.md') continue;
      if (path.includes(`${sep}.claude${sep}rules${sep}`) || eager.has(path) || path === join(repositoryRoot, '.claude/CLAUDE.md')) continue;
      if (isExcluded(path)) {
        coverageItems.push(coverage('claude-excluded', 'partial', 'Instruction file matched claudeMdExcludes.', path));
        continue;
      }
      const descendantStatus = await readableFile(this.fs, path);
      if (descendantStatus !== 'file') {
        coverageItems.push(coverage('claude-instruction-inaccessible', 'inaccessible', 'Instruction file is unreadable.', path));
        continue;
      }
      foundInstructions.push({
        locator: path,
        sourceType: name === 'CLAUDE.local.md' ? 'local-instructions' : 'project-instructions',
        shareability: name === 'CLAUDE.local.md' ? 'personal' : 'team',
        loading: 'on-demand',
      });
    }
    for (const path of descendants.inaccessible) {
      coverageItems.push(coverage('claude-path-inaccessible', 'inaccessible', 'A repository path could not be inspected.', path));
    }
    for (const path of descendants.escapes) {
      coverageItems.push(coverage('claude-root-escape', 'partial', 'A repository symlink resolves outside the repository root.', path));
    }

    const additionalDirectories = uniqueSorted((input.additionalDirectories ?? []).map((path) => resolve(path)));
    if (additionalDirectories.length > 0 && !input.includeAdditionalDirectoryInstructions) {
      coverageItems.push(coverage(
        'claude-additional-directories-disabled',
        'partial',
        'Additional directories were provided, but their Claude instructions are not enabled for loading.',
      ));
    }
    if (input.includeAdditionalDirectoryInstructions) {
      for (const directory of additionalDirectories) {
        for (const candidate of [
          join(directory, 'CLAUDE.md'),
          join(directory, '.claude/CLAUDE.md'),
          join(directory, 'CLAUDE.local.md'),
        ]) {
          const candidateStatus = await readableFile(this.fs, candidate);
          if (candidateStatus !== 'file') {
            if (candidateStatus === 'inaccessible') {
              coverageItems.push(coverage('claude-instruction-inaccessible', 'inaccessible', 'Additional-directory instructions are unreadable.', candidate));
            }
            continue;
          }
          if (isExcluded(candidate)) {
            coverageItems.push(coverage('claude-excluded', 'partial', 'Additional-directory instruction matched claudeMdExcludes.', candidate));
            continue;
          }
          foundInstructions.push({
            locator: candidate,
            sourceType: 'additional-instructions',
            shareability: 'personal',
            loading: 'eager',
          });
        }
      }
    }

    const ruleRoots = [
      { path: join(homeDir, '.claude/rules'), sourceType: 'user-rule', shareability: 'personal' as const },
      { path: join(repositoryRoot, '.claude/rules'), sourceType: 'project-rule', shareability: 'team' as const },
      ...(input.includeAdditionalDirectoryInstructions
        ? additionalDirectories.map((directory) => ({
          path: join(directory, '.claude/rules'),
          sourceType: 'additional-rule',
          shareability: 'personal' as const,
        }))
        : []),
    ];
    for (const ruleRoot of ruleRoots) {
      const walked = await walkMarkdown(this.fs, ruleRoot.path);
      for (const path of walked.files) {
        if (isExcluded(path)) {
          coverageItems.push(coverage('claude-excluded', 'partial', 'Rule matched claudeMdExcludes.', path));
          continue;
        }
        let paths: string[] | undefined;
        try {
          paths = rulePaths(await this.fs.readFile(path));
        } catch {
          coverageItems.push(coverage('claude-rule-inaccessible', 'inaccessible', 'Rule could not be read.', path));
          continue;
        }
        sources.push({
          agent: AGENT,
          sourceType: ruleRoot.sourceType,
          locator: path,
          shareability: await safeShareability(path, ruleRoot.shareability),
          status: 'available',
          ...(paths === undefined ? {} : { pathScope: paths }),
        });
      }
      for (const path of walked.inaccessible) {
        coverageItems.push(coverage('claude-rule-inaccessible', 'inaccessible', 'Rule path could not be inspected.', path));
      }
      for (const path of walked.escapes) {
        coverageItems.push(coverage('claude-root-escape', 'partial', 'A rule symlink resolves outside its explicit rule root.', path));
      }
    }

    const instructionSourcePaths = foundInstructions
      .filter((item) => item.loading !== 'reported-only')
      .map((item) => item.locator);
    const importSources = new Map<string, ContextSource>();
    const visitImports = async (
      path: string,
      depth: number,
      ancestors: readonly string[],
      inheritedShareability: Shareability,
    ): Promise<void> => {
      let canonicalPath: string;
      try {
        canonicalPath = await this.fs.realpath(path);
      } catch (error) {
        coverageItems.push(coverage(
          'claude-import-inaccessible',
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unknown' : 'inaccessible',
          'Import source could not be canonicalized.',
          path,
        ));
        return;
      }
      let text: string;
      try {
        text = await this.fs.readFile(canonicalPath);
      } catch {
        coverageItems.push(coverage('claude-import-inaccessible', 'inaccessible', 'Imported file could not be read.', canonicalPath));
        return;
      }
      for (const imported of importedPaths(text)) {
        const candidate = resolve(dirname(path), resolveTilde(imported, homeDir));
        if (depth >= 4) {
          coverageItems.push(coverage('claude-import-depth', 'partial', 'Import exceeds the maximum depth of four hops.', candidate));
          continue;
        }
        if (isExcluded(candidate)) {
          coverageItems.push(coverage('claude-excluded', 'partial', 'Imported file matched claudeMdExcludes.', candidate));
          continue;
        }
        let canonicalCandidate: string;
        try {
          canonicalCandidate = await this.fs.realpath(candidate);
        } catch (error) {
          coverageItems.push(coverage(
            'claude-import-inaccessible',
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unknown' : 'inaccessible',
            'Imported path could not be canonicalized.',
            candidate,
          ));
          continue;
        }
        if (ancestors.includes(canonicalCandidate) || canonicalCandidate === canonicalPath) {
          coverageItems.push(coverage('claude-import-cycle', 'partial', 'Recursive import cycle detected.', canonicalCandidate));
          continue;
        }
        if (isExcluded(canonicalCandidate)) {
          coverageItems.push(coverage('claude-excluded', 'partial', 'Imported file matched claudeMdExcludes.', canonicalCandidate));
          continue;
        }
        const fileStatus = await readableFile(this.fs, canonicalCandidate);
        if (fileStatus !== 'file') {
          coverageItems.push(coverage(
            'claude-import-inaccessible',
            fileStatus === 'inaccessible' ? 'inaccessible' : 'unknown',
            fileStatus === 'inaccessible' ? 'Imported file is unreadable.' : 'Imported file does not exist.',
            canonicalCandidate,
          ));
          continue;
        }
        const candidateShareability = inheritedShareability === 'team'
          && isInside(canonicalRepositoryRoot, canonicalCandidate)
          ? 'team'
          : 'personal';
        const existing = importSources.get(canonicalCandidate);
        if (existing === undefined) {
          importSources.set(canonicalCandidate, {
            agent: AGENT,
            sourceType: 'import',
            locator: canonicalCandidate,
            shareability: candidateShareability,
            status: 'available',
          });
        } else if (candidateShareability === 'personal') {
          existing.shareability = 'personal';
        }
        await visitImports(candidate, depth + 1, [...ancestors, canonicalPath], candidateShareability);
      }
    };
    for (const instruction of foundInstructions.filter((item) => item.loading !== 'reported-only')) {
      await visitImports(instruction.locator, 0, [], instruction.shareability);
    }
    sources.push(...[...importSources.values()].sort((left, right) => compareCodeUnits(left.locator, right.locator)));

    const autoMemorySetting = parsedLayers.find(({ kind, settings }) =>
      kind === 'managed' && typeof settings.autoMemoryDirectory === 'string',
    ) ?? [...parsedLayers]
      .reverse()
      .find(({ kind, settings }) => kind !== 'managed' && typeof settings.autoMemoryDirectory === 'string');
    let memoryRoot: string | undefined;
    if (typeof autoMemorySetting?.settings.autoMemoryDirectory === 'string') {
      const configured = resolveTilde(autoMemorySetting.settings.autoMemoryDirectory, homeDir);
      if (isAbsolute(configured)) memoryRoot = configured;
      else coverageItems.push(coverage('claude-auto-memory-invalid', 'unknown', 'autoMemoryDirectory must be absolute or home-relative.', autoMemorySetting.locator));
    } else {
      const encodedRepository = repositoryRoot.replace(/[^A-Za-z0-9_-]/g, '-');
      const derived = join(homeDir, '.claude/projects', encodedRepository, 'memory');
      if ((await readableFile(this.fs, join(derived, 'MEMORY.md'))) === 'file') memoryRoot = derived;
      else coverageItems.push(coverage(
        'claude-auto-memory-layout',
        'partial',
        'No configured memory directory was found and the installed Claude project locator could not be confirmed.',
        derived,
      ));
    }
    if (memoryRoot !== undefined) {
      const memoryEntry = join(memoryRoot, 'MEMORY.md');
      const memoryStatus = await readableFile(this.fs, memoryEntry);
      if (memoryStatus === 'file') {
        sources.push({
          agent: AGENT,
          sourceType: 'auto-memory',
          locator: memoryEntry,
          shareability: 'personal',
          status: 'available',
        });
      } else {
        coverageItems.push(coverage(
          'claude-auto-memory-inaccessible',
          memoryStatus === 'inaccessible' ? 'inaccessible' : 'partial',
          memoryStatus === 'inaccessible' ? 'Auto-memory entrypoint is unreadable.' : 'Auto-memory entrypoint does not exist yet.',
          memoryEntry,
        ));
      }
    }

    for (const instruction of foundInstructions) {
      sources.push({
        agent: AGENT,
        sourceType: instruction.sourceType,
        locator: instruction.locator,
        shareability: instruction.shareability,
        status: instruction.loading === 'reported-only' ? 'reported-only' : 'available',
      });
    }

    const loadingRank = { 'reported-only': 0, eager: 1, 'on-demand': 2 } as const;
    const orderedInstructions = [...foundInstructions].sort((left, right) => {
      const rank = loadingRank[left.loading] - loadingRank[right.loading];
      if (rank !== 0) return rank;
      if (left.loading === 'eager' && right.loading === 'eager') {
        const leftIndex = instructionSourcePaths.indexOf(left.locator);
        const rightIndex = instructionSourcePaths.indexOf(right.locator);
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      }
      return compareCodeUnits(left.locator, right.locator);
    });
    const loadPlan: LoadOrder[] = orderedInstructions.map((item, order) => ({
      order,
      locator: item.locator,
      sourceType: item.sourceType,
      loading: item.loading,
    }));

    const sourceRank = (source: ContextSource): number => {
      if (source.sourceType === 'managed-instructions') return 0;
      if (source.sourceType.startsWith('user')) return 1;
      if (source.sourceType === 'project-instructions') return 2;
      if (source.sourceType === 'local-instructions') return 3;
      if (source.sourceType === 'project-rule') return 4;
      if (source.sourceType === 'import') return 5;
      if (source.sourceType === 'auto-memory') return 6;
      return 7;
    };
    sources.sort((left, right) => sourceRank(left) - sourceRank(right) || compareCodeUnits(left.locator, right.locator));
    coverageItems.push(coverage(
      'claude-known-sources',
      managedInputsSupplied && additionalInputsSupplied ? 'covered' : 'partial',
      managedInputsSupplied && additionalInputsSupplied
        ? 'Known stable Claude Code source locations and supplied external mechanisms were inspected.'
        : 'Known stable Claude Code source locations were inspected, but external mechanisms were not fully supplied.',
    ));
    coverageItems.sort((left, right) => compareCodeUnits(left.id, right.id) || compareCodeUnits(left.locator ?? '', right.locator ?? ''));

    return { agent: AGENT, sources, coverage: coverageItems, loadPlan };
  }
}
