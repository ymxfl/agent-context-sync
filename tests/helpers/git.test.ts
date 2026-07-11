import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBareRemote,
  fixtureGit,
  initFixtureRepository,
} from './git.js';

describe('Git fixture initialization', () => {
  let originalGlobalConfig: string | undefined;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-context-sync-git-'));
    const globalConfig = join(root, 'global.gitconfig');
    await writeFile(globalConfig, '[init]\n\tdefaultBranch = reviewer-default\n');
    originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  });

  afterEach(async () => {
    if (originalGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL;
    } else {
      process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('initializes fixture repositories on main', async () => {
    const repository = join(root, 'repository');

    await initFixtureRepository(repository);

    await expect(fixtureGit(repository, ['branch', '--show-current'])).resolves.toBe('main');
  });

  it('points bare remote HEAD at main', async () => {
    const remote = await createBareRemote(join(root, 'remote.git'));

    await expect(fixtureGit(remote, ['symbolic-ref', 'HEAD'])).resolves.toBe('refs/heads/main');
  });
});
