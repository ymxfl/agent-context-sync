import type { Dirent } from 'node:fs';
import {
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type {
  AgentAdapter,
  ContextSource,
  CoverageItem,
  CoverageReport,
  DiscoveryInput,
  LoadOrder,
  Shareability,
} from '../adapter.js';

const AGENT = 'codex' as const;
const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_FALLBACK_FILENAMES: readonly string[] = [];

interface CodexSettings {
  project_doc_max_bytes?: unknown;
  project_doc_fallback_filenames?: unknown;
}

interface DiscoverySettings {
  maxBytes: number;
  fallbackFilenames: readonly string[];
}

interface InstructionCandidate {
  locator: string;
  sourceType: string;
  shareability: Shareability;
  text: string;
}

export interface CodexFileSystem {
  readFile(path: string): Promise<string>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  realpath(path: string): Promise<string>;
}

export interface CodexAdapterOptions extends Partial<CodexFileSystem> {
  env?: NodeJS.ProcessEnv;
}

const defaultFileSystem: CodexFileSystem = {
  readFile: (path) => nodeReadFile(path, 'utf8'),
  readdir: (path, options) => nodeReaddir(path, options),
  realpath: (path) => nodeRealpath(path),
};

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === '' || (
    !pathFromParent.startsWith(`..${sep}`)
    && pathFromParent !== '..'
    && !isAbsolute(pathFromParent)
  );
}

function coverage(
  id: string,
  status: CoverageItem['status'],
  detail: string,
  locator?: string,
): CoverageItem {
  return { id, status, detail, ...(locator === undefined ? {} : { locator }) };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isSettingsShape(value: unknown): value is CodexSettings {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function validSettings(settings: CodexSettings): boolean {
  const maxBytes = settings.project_doc_max_bytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 0)) return false;
  const fallback = settings.project_doc_fallback_filenames;
  return fallback === undefined || (
    Array.isArray(fallback)
    && fallback.every((item) => typeof item === 'string' && item.length > 0 && !item.includes('/') && !item.includes('\\'))
  );
}

function applySettings(current: DiscoverySettings, layer: CodexSettings): DiscoverySettings {
  return {
    maxBytes: typeof layer.project_doc_max_bytes === 'number'
      ? layer.project_doc_max_bytes
      : current.maxBytes,
    fallbackFilenames: Array.isArray(layer.project_doc_fallback_filenames)
      ? [...layer.project_doc_fallback_filenames] as string[]
      : current.fallbackFilenames,
  };
}

function directoryChain(repositoryRoot: string, cwd: string): string[] {
  if (!isInside(repositoryRoot, cwd)) return [repositoryRoot];
  const suffix = relative(repositoryRoot, cwd);
  if (suffix === '') return [repositoryRoot];
  const directories = [repositoryRoot];
  let cursor = repositoryRoot;
  for (const segment of suffix.split(sep)) {
    cursor = join(cursor, segment);
    directories.push(cursor);
  }
  return directories;
}

export class CodexAdapter implements AgentAdapter {
  private readonly fs: CodexFileSystem;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CodexAdapterOptions = {}) {
    const { env, ...fs } = options;
    this.fs = { ...defaultFileSystem, ...fs };
    this.env = env ?? process.env;
  }

  async discover(input: DiscoveryInput): Promise<CoverageReport> {
    const repositoryRoot = resolve(input.repositoryRoot);
    const cwd = resolve(input.cwd);
    const codexHome = resolve(this.env.CODEX_HOME ?? join(resolve(input.homeDir), '.codex'));
    const sources: ContextSource[] = [];
    const coverageItems: CoverageItem[] = [];
    const selected: InstructionCandidate[] = [];
    let canonicalRepositoryRoot = repositoryRoot;

    try {
      canonicalRepositoryRoot = await this.fs.realpath(repositoryRoot);
    } catch {
      coverageItems.push(coverage(
        'codex-repository-root-inaccessible',
        'inaccessible',
        'The repository root could not be canonicalized.',
        repositoryRoot,
      ));
    }

    let canonicalCwd: string | undefined;
    try {
      canonicalCwd = await this.fs.realpath(cwd);
    } catch {
      coverageItems.push(coverage(
        'codex-cwd-inaccessible',
        'inaccessible',
        'The working directory could not be canonicalized.',
        cwd,
      ));
    }
    if (canonicalCwd !== undefined && !isInside(canonicalRepositoryRoot, canonicalCwd)) {
      coverageItems.push(coverage(
        'codex-cwd-outside-repository',
        'unknown',
        'The working directory is outside the repository root; ancestor loading cannot be confirmed.',
        cwd,
      ));
    }

    let settings: DiscoverySettings = {
      maxBytes: DEFAULT_MAX_BYTES,
      fallbackFilenames: DEFAULT_FALLBACK_FILENAMES,
    };
    for (const locator of [join(codexHome, 'config.toml'), join(repositoryRoot, '.codex/config.toml')]) {
      let text: string;
      try {
        text = await this.fs.readFile(locator);
      } catch (error) {
        if (isMissing(error)) continue;
        coverageItems.push(coverage(
          'codex-settings-inaccessible',
          'inaccessible',
          'Codex settings are unreadable.',
          locator,
        ));
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseToml(text);
      } catch {
        coverageItems.push(coverage(
          'codex-settings-invalid',
          'unknown',
          'Codex settings TOML is invalid.',
          locator,
        ));
        continue;
      }
      if (!isSettingsShape(parsed) || !validSettings(parsed)) {
        coverageItems.push(coverage(
          'codex-settings-invalid',
          'unknown',
          'Codex discovery settings have invalid values.',
          locator,
        ));
        continue;
      }
      settings = applySettings(settings, parsed);
      coverageItems.push(coverage('codex-settings', 'covered', 'Codex settings parsed.', locator));
    }

    const inspectScope = async (
      paths: ReadonlyArray<{ locator: string; sourceType: string; shareability: Shareability }>,
      enforceRepositoryContainment: boolean,
    ): Promise<void> => {
      const available: InstructionCandidate[] = [];
      for (const candidate of paths) {
        if (enforceRepositoryContainment) {
          try {
            const canonical = await this.fs.realpath(candidate.locator);
            if (!isInside(canonicalRepositoryRoot, canonical)) {
              coverageItems.push(coverage(
                'codex-root-escape',
                'partial',
                'A repository instruction candidate resolves outside the repository root.',
                candidate.locator,
              ));
              continue;
            }
          } catch (error) {
            if (isMissing(error)) continue;
            coverageItems.push(coverage(
              'codex-instruction-inaccessible',
              'inaccessible',
              'Codex instruction file is unreadable.',
              candidate.locator,
            ));
            continue;
          }
        }
        let text: string;
        try {
          text = await this.fs.readFile(candidate.locator);
        } catch (error) {
          if (isMissing(error)) continue;
          coverageItems.push(coverage(
            'codex-instruction-inaccessible',
            'inaccessible',
            'Codex instruction file is unreadable.',
            candidate.locator,
          ));
          continue;
        }
        if (text.trim().length === 0) continue;
        available.push({ ...candidate, text });
      }
      const winner = available[0];
      if (winner !== undefined) selected.push(winner);
      for (const candidate of available) {
        sources.push({
          agent: AGENT,
          sourceType: candidate.sourceType,
          locator: candidate.locator,
          shareability: candidate.shareability,
          status: candidate === winner ? 'available' : 'excluded-by-precedence',
        });
      }
    };

    await inspectScope([
      { locator: join(codexHome, 'AGENTS.override.md'), sourceType: 'global-instructions', shareability: 'personal' },
      { locator: join(codexHome, 'AGENTS.md'), sourceType: 'global-instructions', shareability: 'personal' },
    ], false);

    for (const directory of directoryChain(repositoryRoot, cwd)) {
      const candidates: Array<{ locator: string; sourceType: string; shareability: Shareability }> = [
        { locator: join(directory, 'AGENTS.override.md'), sourceType: 'project-instructions', shareability: 'team' as const },
        { locator: join(directory, 'AGENTS.md'), sourceType: 'project-instructions', shareability: 'team' as const },
        ...settings.fallbackFilenames.map((filename) => ({
          locator: join(directory, filename),
          sourceType: 'fallback-instructions',
          shareability: 'team' as const,
        })),
      ].filter((candidate, index, all) => (
        all.findIndex((item) => item.locator === candidate.locator) === index
      ));
      await inspectScope(candidates, true);
    }

    const memoriesRoot = join(codexHome, 'memories');
    let memoryEntries: Dirent[] = [];
    try {
      memoryEntries = await this.fs.readdir(memoriesRoot, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        coverageItems.push(coverage(
          'codex-memory-inaccessible',
          'inaccessible',
          'Codex local memories are unreadable.',
          memoriesRoot,
        ));
      }
    }
    memoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of memoryEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
      const locator = join(memoriesRoot, entry.name);
      let text: string;
      try {
        text = await this.fs.readFile(locator);
      } catch (error) {
        if (!isMissing(error)) {
          coverageItems.push(coverage(
            'codex-memory-metadata-inaccessible',
            'inaccessible',
            'Codex local memory metadata is unreadable.',
            locator,
          ));
        }
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parseToml(text);
      } catch {
        coverageItems.push(coverage(
          'codex-memory-metadata-invalid',
          'unknown',
          'Codex local memory metadata TOML is invalid.',
          locator,
        ));
        continue;
      }
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') continue;
      const repository = (parsed as { repository?: unknown }).repository;
      if (typeof repository !== 'string' || !isAbsolute(repository)) continue;
      let canonicalMemoryRepository: string;
      try {
        canonicalMemoryRepository = await this.fs.realpath(repository);
      } catch {
        coverageItems.push(coverage(
          'codex-memory-repository-inaccessible',
          'inaccessible',
          'The repository attributed by local memory metadata is inaccessible.',
          locator,
        ));
        continue;
      }
      if (canonicalMemoryRepository !== canonicalRepositoryRoot) continue;
      sources.push({
        agent: AGENT,
        sourceType: 'local-memory',
        locator,
        shareability: 'personal',
        status: 'reported-only',
      });
    }

    let remainingProjectBytes = settings.maxBytes;
    let truncated = false;
    const loadPlan: LoadOrder[] = [];
    for (const candidate of selected) {
      const isProjectDoc = candidate.sourceType !== 'global-instructions';
      if (isProjectDoc && remainingProjectBytes === 0) {
        truncated = true;
        continue;
      }
      loadPlan.push({
        order: loadPlan.length,
        locator: candidate.locator,
        sourceType: candidate.sourceType,
        loading: 'eager',
      });
      if (isProjectDoc) {
        const bytes = Buffer.byteLength(candidate.text, 'utf8');
        if (bytes > remainingProjectBytes) truncated = true;
        remainingProjectBytes = Math.max(0, remainingProjectBytes - bytes);
      }
    }
    sources.sort((left, right) => {
      const leftSelected = selected.findIndex((item) => item.locator === left.locator);
      const rightSelected = selected.findIndex((item) => item.locator === right.locator);
      const leftRank = leftSelected === -1 ? Number.MAX_SAFE_INTEGER : leftSelected;
      const rightRank = rightSelected === -1 ? Number.MAX_SAFE_INTEGER : rightSelected;
      return leftRank - rightRank || left.locator.localeCompare(right.locator);
    });
    coverageItems.push(coverage(
      'codex-known-sources',
      'covered',
      'Known stable Codex source locations were inspected.',
    ));
    if (truncated) {
      coverageItems.push(coverage(
        'codex-project-doc-limit',
        'partial',
        'Codex instruction content exceeds the configured UTF-8 byte limit.',
      ));
    }
    coverageItems.sort((left, right) => left.id.localeCompare(right.id) || (left.locator ?? '').localeCompare(right.locator ?? ''));

    return {
      agent: AGENT,
      sources,
      coverage: coverageItems,
      loadPlan,
      limits: { maxBytes: settings.maxBytes, truncated },
    };
  }
}
