import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveryInput } from '../../src/adapters/adapter.js';
import { CodexAdapter } from '../../src/adapters/codex/discover.js';
import { adapterFor } from '../../src/adapters/registry.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('CodexAdapter', () => {
  let root: string;
  let codexHome: string;
  let repositoryRoot: string;
  let input: DiscoveryInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'acs-codex-'));
    codexHome = join(root, 'codex-home');
    repositoryRoot = join(root, 'repo');
    await cp(join(fixtures, 'codex-home'), codexHome, { recursive: true });
    await cp(join(fixtures, 'codex-repo'), repositoryRoot, { recursive: true });
    const memory = join(codexHome, 'memories/repository-memory.toml');
    await writeFile(memory, (await readFile(memory, 'utf8')).replace('__REPOSITORY__', repositoryRoot));
    await writeFile(join(repositoryRoot, 'packages/api/AGENTS.override.md'), `# API override\n${'界'.repeat(12_000)}\n`);
    input = {
      repositoryRoot,
      cwd: join(repositoryRoot, 'packages/api'),
      homeDir: root,
    };
  });

  it('applies global and root-to-cwd precedence and reports UTF-8 truncation', async () => {
    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.loadPlan.map((item) => relative(root, item.locator))).toEqual([
      'codex-home/AGENTS.override.md',
      'repo/AGENTS.md',
      'repo/packages/TEAM.md',
      'repo/packages/api/AGENTS.override.md',
    ]);
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ locator: join(codexHome, 'AGENTS.md'), status: 'excluded-by-precedence' }),
      expect.objectContaining({ locator: join(repositoryRoot, 'TEAM.md'), status: 'excluded-by-precedence' }),
      expect.objectContaining({ locator: join(repositoryRoot, 'packages/api/AGENTS.md'), status: 'excluded-by-precedence' }),
    ]));
    expect(report.limits).toEqual({ maxBytes: 32768, truncated: true });
    expect(report.sources.find((source) => source.sourceType === 'local-memory')).toMatchObject({
      locator: join(codexHome, 'memories/repository-memory.toml'),
      shareability: 'personal',
      status: 'reported-only',
    });
    expect(report.sources).not.toContainEqual(expect.objectContaining({
      locator: join(codexHome, 'memories/unrelated-memory.toml'),
    }));
  });

  it('selects the first non-empty candidate at global and directory scope', async () => {
    await writeFile(join(codexHome, 'AGENTS.override.md'), ' \n\t');
    await writeFile(join(repositoryRoot, 'AGENTS.override.md'), '\n');

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.loadPlan.slice(0, 2).map((item) => item.locator)).toEqual([
      join(codexHome, 'AGENTS.md'),
      join(repositoryRoot, 'AGENTS.md'),
    ]);
    expect(report.loadPlan.filter((item) => dirname(item.locator) === repositoryRoot)).toHaveLength(1);
  });

  it('deduplicates reserved and repeated fallback filenames at each directory', async () => {
    await writeFile(join(repositoryRoot, '.codex/config.toml'), [
      'project_doc_max_bytes = 32768',
      'project_doc_fallback_filenames = ["AGENTS.md", "TEAM.md", "TEAM.md"]',
    ].join('\n'));

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);
    const rootSources = report.sources.filter((source) => dirname(source.locator) === repositoryRoot);

    expect(rootSources.map((source) => source.locator)).toEqual([
      join(repositoryRoot, 'AGENTS.md'),
      join(repositoryRoot, 'TEAM.md'),
    ]);
  });

  it('uses project TOML settings and gives fixed diagnostics for invalid or unreadable settings', async () => {
    const projectConfig = join(repositoryRoot, '.codex/config.toml');
    await writeFile(projectConfig, 'project_doc_max_bytes = nope-secret\n');
    const globalConfig = join(codexHome, 'config.toml');
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('OS secret must not leak'), { code: 'EACCES' });
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        if (path === globalConfig) throw denied();
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'codex-settings-inaccessible',
        locator: globalConfig,
        status: 'inaccessible',
        detail: 'Codex settings are unreadable.',
      }),
      expect.objectContaining({
        id: 'codex-settings-invalid',
        locator: projectConfig,
        status: 'unknown',
        detail: 'Codex settings TOML is invalid.',
      }),
    ]));
    expect(JSON.stringify(report)).not.toMatch(/nope-secret|OS secret/);
  });

  it('does not read or apply a project config that resolves outside the repository', async () => {
    const projectConfig = join(repositoryRoot, '.codex/config.toml');
    const externalConfig = join(root, 'external-config.toml');
    await writeFile(externalConfig, [
      'project_doc_max_bytes = 1',
      'project_doc_fallback_filenames = ["PRIVATE.md"]',
    ].join('\n'));
    await rm(projectConfig);
    await symlink(externalConfig, projectConfig);
    const reads: string[] = [];
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        reads.push(path);
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.limits?.maxBytes).toBe(32768);
    expect(reads).not.toContain(projectConfig);
    expect(reads).not.toContain(externalConfig);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-settings-root-escape',
      locator: projectConfig,
      status: 'unknown',
      detail: 'Repository Codex settings resolve outside the repository root.',
    }));
  });

  it('rejects invalid discovery setting values with fixed diagnostics', async () => {
    const projectConfig = join(repositoryRoot, '.codex/config.toml');
    await writeFile(projectConfig, [
      'project_doc_max_bytes = -1',
      'project_doc_fallback_filenames = ["TEAM.md", 7]',
    ].join('\n'));

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-settings-invalid',
      locator: projectConfig,
      status: 'unknown',
      detail: 'Codex discovery settings have invalid values.',
    }));
    expect(report.limits?.maxBytes).toBe(32768);
  });

  it('applies the UTF-8 byte budget only to project docs and stops after truncation', async () => {
    await writeFile(join(codexHome, 'AGENTS.override.md'), '界'.repeat(20));
    await writeFile(join(codexHome, 'config.toml'), [
      'project_doc_max_bytes = 4',
      'project_doc_fallback_filenames = ["TEAM.md"]',
    ].join('\n'));

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.loadPlan.map((item) => item.locator)).toEqual([
      join(codexHome, 'AGENTS.override.md'),
      join(repositoryRoot, 'AGENTS.md'),
    ]);
    expect(report.limits).toEqual({ maxBytes: 4, truncated: true });
  });

  it('treats a zero-byte project-doc limit as disabling project instructions', async () => {
    await writeFile(join(codexHome, 'config.toml'), [
      'project_doc_max_bytes = 0',
      'project_doc_fallback_filenames = ["TEAM.md"]',
    ].join('\n'));

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.loadPlan.map((item) => item.locator)).toEqual([
      join(codexHome, 'AGENTS.override.md'),
    ]);
    expect(report.limits).toEqual({ maxBytes: 0, truncated: true });
  });

  it('does not treat symlink escapes or memories for other repositories as team sources', async () => {
    const external = join(root, 'external.md');
    await writeFile(external, '# External instructions\n');
    await writeFile(join(repositoryRoot, 'packages/AGENTS.override.md'), '');
    await symlink(external, join(repositoryRoot, 'packages/AGENTS.md'));
    await writeFile(
      join(codexHome, 'memories/other.toml'),
      `repository = ${JSON.stringify(join(root, 'other-repo'))}\ncontent = "other"\n`,
    );

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover(input);

    expect(report.sources).not.toContainEqual(expect.objectContaining({ locator: await realpath(external) }));
    expect(report.sources).not.toContainEqual(expect.objectContaining({ locator: join(codexHome, 'memories/other.toml') }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-root-escape',
      locator: join(repositoryRoot, 'packages/AGENTS.md'),
      status: 'partial',
    }));
  });

  it('does not select lower-precedence instructions when a higher candidate is unreadable', async () => {
    const blocked = join(codexHome, 'AGENTS.override.md');
    const lower = join(codexHome, 'AGENTS.md');
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('private override'), { code: 'EACCES' });
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        if (path === blocked) throw denied();
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.loadPlan).not.toContainEqual(expect.objectContaining({ locator: lower }));
    expect(report.sources).toContainEqual(expect.objectContaining({
      locator: lower,
      status: 'unresolved-by-precedence',
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-instruction-inaccessible',
      locator: blocked,
      status: 'inaccessible',
    }));
    expect(JSON.stringify(report)).not.toContain('private override');
  });

  it('reports the fallback that blocks resolution of a lower fallback', async () => {
    const blocked = join(repositoryRoot, 'packages/TEAM.md');
    const lower = join(repositoryRoot, 'packages/INSTRUCTIONS.md');
    await writeFile(lower, '# Lower fallback\n');
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('private fallback'), { code: 'EACCES' });
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        if (path === blocked) throw denied();
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.loadPlan).not.toContainEqual(expect.objectContaining({ locator: lower }));
    expect(report.sources).toContainEqual(expect.objectContaining({
      locator: lower,
      status: 'unresolved-by-precedence',
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-precedence-unresolved',
      locator: blocked,
      status: 'unknown',
    }));
  });

  it('builds the root-to-cwd chain from canonical paths across different aliases', async () => {
    const rootAlias = join(root, 'repo-alias');
    const cwdAlias = join(root, 'api-alias');
    await symlink(repositoryRoot, rootAlias);
    await symlink(join(repositoryRoot, 'packages/api'), cwdAlias);

    const report = await new CodexAdapter({ env: { CODEX_HOME: codexHome } }).discover({
      ...input,
      repositoryRoot: rootAlias,
      cwd: cwdAlias,
    });

    expect(report.loadPlan.map((item) => item.locator)).toEqual([
      join(codexHome, 'AGENTS.override.md'),
      join(rootAlias, 'AGENTS.md'),
      join(rootAlias, 'packages/TEAM.md'),
      join(rootAlias, 'packages/api/AGENTS.override.md'),
    ]);
    expect(report.coverage).not.toContainEqual(expect.objectContaining({ id: 'codex-cwd-outside-repository' }));
  });

  it('reports inaccessible candidates without throwing and returns deterministic, read-only results', async () => {
    const blocked = join(repositoryRoot, 'packages/TEAM.md');
    const before = { bytes: await readFile(blocked), modified: (await stat(blocked)).mtimeMs };
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('private error'), { code: 'EACCES' });
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        if (path === blocked) throw denied();
        return readFile(path, 'utf8');
      },
    });

    const first = await adapter.discover(input);
    const second = await adapter.discover(input);

    expect(second).toEqual(first);
    expect(first.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-instruction-inaccessible',
      locator: blocked,
      status: 'inaccessible',
      detail: 'Codex instruction file is unreadable.',
    }));
    expect(JSON.stringify(first)).not.toContain('private error');
    expect(await readFile(blocked)).toEqual(before.bytes);
    expect((await stat(blocked)).mtimeMs).toBe(before.modified);
  });

  it('reports unreadable memory metadata without leaking errors', async () => {
    const blocked = join(codexHome, 'memories/repository-memory.toml');
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('memory secret'), { code: 'EACCES' });
    const adapter = new CodexAdapter({
      env: { CODEX_HOME: codexHome },
      readFile: async (path) => {
        if (path === blocked) throw denied();
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'codex-memory-metadata-inaccessible',
      locator: blocked,
      status: 'inaccessible',
      detail: 'Codex local memory metadata is unreadable.',
    }));
    expect(JSON.stringify(report)).not.toContain('memory secret');
  });
});

describe('adapterFor', () => {
  it('returns the requested adapter', () => {
    expect(adapterFor('codex')).toBeInstanceOf(CodexAdapter);
    expect(adapterFor('claude-code').constructor.name).toBe('ClaudeAdapter');
  });
});
