import { cp, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/adapters/claude/discover.js';
import type { DiscoveryInput } from '../../src/adapters/adapter.js';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('ClaudeAdapter', () => {
  it('does not claim full coverage when managed and additional-directory inputs are unsupplied', async () => {
    const report = await new ClaudeAdapter().discover({
      repositoryRoot,
      cwd: repositoryRoot,
      homeDir,
    });
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-managed-inputs', status: 'unknown' }),
      expect.objectContaining({ id: 'claude-additional-directory-inputs', status: 'unknown' }),
      expect.objectContaining({ id: 'claude-known-sources', status: 'partial' }),
    ]));
  });
  let root: string;
  let homeDir: string;
  let repositoryRoot: string;
  let input: DiscoveryInput;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'acs-claude-'));
    homeDir = join(root, 'claude-home');
    repositoryRoot = join(root, 'claude-repo');
    await cp(join(fixtures, 'claude-home'), homeDir, { recursive: true });
    await cp(join(fixtures, 'claude-repo'), repositoryRoot, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), '# Parent workspace instructions\n');

    const projectSettings = join(repositoryRoot, '.claude/settings.json');
    await writeFile(
      projectSettings,
      (await readFile(projectSettings, 'utf8')).replace(
        '__FIXTURE_MEMORY__',
        join(homeDir, 'custom-memory'),
      ),
    );

    input = {
      repositoryRoot,
      cwd: join(repositoryRoot, 'packages/api'),
      homeDir,
      managedSettingsPaths: [join(homeDir, 'managed/managed-settings.json')],
      managedInstructionPaths: [join(homeDir, 'managed/CLAUDE.md')],
      explicitSettingsPaths: [
        join(homeDir, 'explicit-settings.json'),
        join(homeDir, 'missing-settings.json'),
      ],
      additionalDirectories: [join(homeDir, 'additional-project')],
      includeAdditionalDirectoryInstructions: true,
    };
  });

  it('discovers distinct Claude instruction, rule, import, and memory sources', async () => {
    const report = await new ClaudeAdapter().discover(input);

    expect(report.sources.map((source) => source.sourceType)).toEqual(expect.arrayContaining([
      'managed-instructions',
      'user-instructions',
      'project-instructions',
      'local-instructions',
      'project-rule',
      'import',
      'auto-memory',
    ]));
    expect(report.sources.find((source) => source.sourceType === 'user-instructions')?.shareability)
      .toBe('personal');
    expect(report.sources.find((source) => source.sourceType === 'managed-instructions'))
      .toMatchObject({ shareability: 'managed', status: 'reported-only' });
    expect(report.sources.find((source) => source.sourceType === 'auto-memory'))
      .toMatchObject({ shareability: 'personal', locator: join(homeDir, 'custom-memory/MEMORY.md') });
    expect(report.coverage.every((item) => ['covered', 'partial', 'unknown', 'inaccessible'].includes(item.status)))
      .toBe(true);
  });

  it('orders ancestor instructions broadly to specifically and descendants on demand', async () => {
    const report = await new ClaudeAdapter().discover(input);
    const instructions = report.loadPlan.filter((item) =>
      ['project-instructions', 'local-instructions'].includes(item.sourceType),
    );

    expect(instructions.map((item) => [
      item.loading,
      relative(repositoryRoot, item.locator),
    ])).toEqual([
      ['eager', '../CLAUDE.md'],
      ['eager', 'CLAUDE.md'],
      ['eager', '.claude/CLAUDE.md'],
      ['eager', 'CLAUDE.local.md'],
      ['eager', 'packages/CLAUDE.md'],
      ['eager', 'packages/api/CLAUDE.md'],
      ['on-demand', 'packages/web/CLAUDE.md'],
    ]);
  });

  it('parses imports outside code, stops after four hops, and reports cycles', async () => {
    const report = await new ClaudeAdapter().discover(input);
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const imports = report.sources
      .filter((source) => source.sourceType === 'import')
      .map((source) => relative(canonicalRepositoryRoot, source.locator));

    expect(imports).toEqual(expect.arrayContaining([
      'docs/shared.md',
      'docs/deeper.md',
      'imports/one.md',
      'imports/two.md',
      'imports/three.md',
      'imports/four.md',
    ]));
    expect(imports).not.toContain('docs/inline-fake.md');
    expect(imports).not.toContain('docs/fenced-fake.md');
    expect(imports).not.toContain('imports/five.md');
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-import-cycle', status: 'partial' }),
      expect.objectContaining({ id: 'claude-import-depth', status: 'partial' }),
    ]));
  });

  it('reports excluded and inaccessible paths without failing discovery', async () => {
    const report = await new ClaudeAdapter().discover(input);

    expect(report.sources.map((source) => source.locator)).not.toContain(
      join(repositoryRoot, 'excluded/CLAUDE.md'),
    );
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-excluded', status: 'partial' }),
      expect.objectContaining({
        id: 'claude-settings-inaccessible',
        locator: join(homeDir, 'missing-settings.json'),
        status: 'inaccessible',
      }),
    ]));
  });

  it('never exposes malformed settings contents through diagnostics', async () => {
    const secret = 'settings-secret-must-not-leak';
    await writeFile(input.explicitSettingsPaths![0], `{"token":${secret}}`);

    const report = await new ClaudeAdapter().discover(input);

    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'claude-settings-invalid',
      status: 'unknown',
      detail: 'Settings JSON is invalid.',
    }));
  });

  it('does not follow repository symlinks outside the root and treats import escapes as personal', async () => {
    const external = join(root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'CLAUDE.md'), '# Must not be repository-discovered\n');
    await writeFile(join(external, 'imported.md'), '# External import\n');
    await symlink(external, join(repositoryRoot, 'linked'));
    await symlink(join(repositoryRoot, 'docs/shared.md'), join(repositoryRoot, 'docs/shared-alias.md'));
    await writeFile(
      join(repositoryRoot, 'CLAUDE.md'),
      `${await readFile(join(repositoryRoot, 'CLAUDE.md'), 'utf8')}\n@linked/imported.md\n@docs/shared-alias.md\n`,
    );

    const report = await new ClaudeAdapter().discover(input);
    const canonicalExternalImport = await realpath(join(external, 'imported.md'));

    expect(report.sources).not.toContainEqual(expect.objectContaining({
      locator: join(repositoryRoot, 'linked/CLAUDE.md'),
    }));
    expect(report.sources).toContainEqual(expect.objectContaining({
      sourceType: 'import',
      locator: canonicalExternalImport,
      shareability: 'personal',
    }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'claude-root-escape',
      status: 'partial',
      locator: join(repositoryRoot, 'linked'),
    }));
    const canonicalShared = await realpath(join(repositoryRoot, 'docs/shared.md'));
    expect(report.sources.filter((source) => source.locator === canonicalShared)).toHaveLength(1);
  });

  it('keeps unverifiable external imports coverage-only', async () => {
    const external = join(root, 'blocked.md');
    await writeFile(external, '# Inaccessible external import\n');
    const canonicalExternal = await realpath(external);
    await writeFile(
      join(repositoryRoot, 'CLAUDE.md'),
      `${await readFile(join(repositoryRoot, 'CLAUDE.md'), 'utf8')}\n@../blocked.md\n`,
    );
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const adapter = new ClaudeAdapter({
      readFile: async (path) => {
        if (path === canonicalExternal) throw denied;
        return readFile(path, 'utf8');
      },
    });

    const report = await adapter.discover(input);

    expect(report.sources).not.toContainEqual(expect.objectContaining({ locator: canonicalExternal }));
    expect(report.coverage).toContainEqual(expect.objectContaining({
      id: 'claude-import-inaccessible',
      locator: canonicalExternal,
      status: 'inaccessible',
    }));
  });

  it('reports injected inaccessible instruction, rule, and rule-root reads', async () => {
    const instruction = join(repositoryRoot, 'CLAUDE.md');
    const rule = join(repositoryRoot, '.claude/rules/api.md');
    const userRuleRoot = join(homeDir, '.claude/rules');
    const denied = (): NodeJS.ErrnoException => Object.assign(new Error('secret OS diagnostic'), { code: 'EACCES' });
    const adapter = new ClaudeAdapter({
      readFile: async (path) => {
        if (path === instruction || path === rule) throw denied();
        return readFile(path, 'utf8');
      },
      readdir: async (path, options) => {
        if (path === userRuleRoot) throw denied();
        return import('node:fs/promises').then((fs) => fs.readdir(path, options));
      },
    });

    const report = await adapter.discover(input);

    expect(report.sources).not.toContainEqual(expect.objectContaining({ locator: instruction }));
    expect(report.sources).not.toContainEqual(expect.objectContaining({ locator: rule }));
    expect(report.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'claude-instruction-inaccessible', locator: instruction, status: 'inaccessible' }),
      expect.objectContaining({ id: 'claude-rule-inaccessible', locator: rule, status: 'inaccessible' }),
      expect.objectContaining({ id: 'claude-rule-inaccessible', locator: userRuleRoot, status: 'inaccessible' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('secret OS diagnostic');
  });

  it('discovers enabled additional-directory instructions and rules distinctly', async () => {
    const report = await new ClaudeAdapter().discover(input);

    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: 'additional-instructions',
        locator: join(homeDir, 'additional-project/CLAUDE.md'),
        shareability: 'personal',
      }),
      expect.objectContaining({
        sourceType: 'additional-rule',
        locator: join(homeDir, 'additional-project/.claude/rules/shared.md'),
        shareability: 'personal',
      }),
    ]));
  });

  it('is read-only and returns deterministic ordering', async () => {
    const watched = join(repositoryRoot, 'CLAUDE.md');
    const before = { bytes: await readFile(watched), modified: (await stat(watched)).mtimeMs };
    const adapter = new ClaudeAdapter();

    const first = await adapter.discover(input);
    const second = await adapter.discover(input);

    expect(second).toEqual(first);
    expect(await readFile(watched)).toEqual(before.bytes);
    expect((await stat(watched)).mtimeMs).toBe(before.modified);
  });

  it('ignores imports inside code spans with arbitrary backtick delimiters', async () => {
    await writeFile(
      join(repositoryRoot, 'CLAUDE.md'),
      [
        '``@docs/multi-fake.md with ` embedded``',
        'Text ```@docs/triple-fake.md with `` embedded``` after.',
        '@docs/shared.md',
      ].join('\n'),
    );

    const report = await new ClaudeAdapter().discover(input);
    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    const imports = report.sources
      .filter((source) => source.sourceType === 'import')
      .map((source) => source.locator);

    expect(imports).toContain(join(canonicalRepositoryRoot, 'docs/shared.md'));
    expect(imports).not.toContain(join(canonicalRepositoryRoot, 'docs/multi-fake.md'));
    expect(imports).not.toContain(join(canonicalRepositoryRoot, 'docs/triple-fake.md'));
  });
});
