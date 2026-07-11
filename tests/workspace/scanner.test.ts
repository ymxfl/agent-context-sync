import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanRepositories } from '../../src/workspace/scanner.js';
import { initFixtureRepository } from '../helpers/git.js';

const fixtureParent = path.resolve('tests', 'fixtures', 'workspace-scan');

function isWindowsSymlinkPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

describe('scanRepositories', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    await mkdir(fixtureParent, { recursive: true });
    fixtureRoot = await mkdtemp(path.join(fixtureParent, 'case-'));
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('follows a directory symlink and records the canonical repository path once', async ({
    skip,
  }) => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), 'acs-scanner-'));
    const repository = path.join(externalRoot, 'API');
    const repositoryLink = path.join(fixtureRoot, 'linked-api');

    try {
      await initFixtureRepository(repository, 'git@GitHub.com:Acme/API.git');
      try {
        await symlink(repository, repositoryLink, 'dir');
      } catch (error) {
        if (isWindowsSymlinkPermissionError(error)) {
          skip('Creating directory symlinks is not permitted on this Windows host');
        }
        throw error;
      }

      const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });
      const realRepositoryPath = await realpath(repository);

      expect(result.map((item) => item.realPath)).toEqual([realRepositoryPath]);
      expect(result[0]?.localPath).toBe(repositoryLink);
      expect(result[0]?.encounteredViaSymlink).toBe(true);
      expect(result[0]?.repositoryId).toBe('github.com/Acme/API');
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('de-duplicates repositories by real path', async ({ skip }) => {
    const repository = path.join(fixtureRoot, 'API');
    await initFixtureRepository(repository, 'https://github.com/Acme/API.git');
    try {
      await symlink(repository, path.join(fixtureRoot, 'API-link'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 1 });

    expect(result).toHaveLength(1);
    expect(result[0]?.realPath).toBe(await realpath(repository));
  });

  it('ignores dangling symlinks without aborting the scan', async ({ skip }) => {
    const repository = path.join(fixtureRoot, 'repository');
    await initFixtureRepository(repository);
    try {
      await symlink(
        path.join(fixtureRoot, 'missing-target'),
        path.join(fixtureRoot, 'dangling'),
        'dir',
      );
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 1 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });

  it('ignores mutually cyclic symlinks without aborting the scan', async ({ skip }) => {
    const repository = path.join(fixtureRoot, 'repository');
    const firstLink = path.join(fixtureRoot, 'first-link');
    const secondLink = path.join(fixtureRoot, 'second-link');
    await initFixtureRepository(repository);
    try {
      await symlink(secondLink, firstLink, 'dir');
      await symlink(firstLink, secondLink, 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 1 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });

  it('ignores symlink loops without aborting the scan', async ({ skip }) => {
    const repository = path.join(fixtureRoot, 'repository');
    await initFixtureRepository(repository);
    try {
      await symlink(path.join(fixtureRoot, 'loop'), path.join(fixtureRoot, 'loop'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 1 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });

  it('does not descend beyond maxDepth', async () => {
    const shallowRepository = path.join(fixtureRoot, 'group', 'shallow');
    const deepRepository = path.join(fixtureRoot, 'group', 'nested', 'deep');
    await initFixtureRepository(shallowRepository);
    await initFixtureRepository(deepRepository);

    const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(shallowRepository)]);
  });

  it('revisits a canonical directory reached later at a shallower depth', async ({ skip }) => {
    const group = path.join(fixtureRoot, 'z-group');
    const repository = path.join(group, 'repository');
    await initFixtureRepository(repository);
    await mkdir(path.join(fixtureRoot, 'a-aliases'));
    try {
      await symlink(group, path.join(fixtureRoot, 'a-aliases', 'deep-group'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });

  it('does not descend into ignored directories or discovered repositories', async () => {
    const repository = path.join(fixtureRoot, 'repository');
    const nestedRepository = path.join(repository, 'nested');
    const ignoredRepository = path.join(fixtureRoot, 'node_modules', 'ignored');
    await initFixtureRepository(repository);
    await initFixtureRepository(nestedRepository);
    await initFixtureRepository(ignoredRepository);

    const result = await scanRepositories(fixtureRoot, { maxDepth: 4 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
    await expect(lstat(path.join(repository, '.git'))).resolves.toBeDefined();
  });

  it('does not follow aliases into ignored directories', async ({ skip }) => {
    const ignoredDirectory = path.join(fixtureRoot, 'node_modules');
    await initFixtureRepository(path.join(ignoredDirectory, 'ignored'));
    try {
      await symlink(ignoredDirectory, path.join(fixtureRoot, 'visible-alias'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

    expect(result).toEqual([]);
  });

  it('does not follow an alias into a .git directory', async ({ skip }) => {
    const externalRoot = await mkdtemp(path.join(tmpdir(), 'acs-scanner-git-'));
    const metadataDirectory = path.join(externalRoot, '.git');
    const hiddenRepository = path.join(metadataDirectory, 'hidden-repository');
    try {
      await initFixtureRepository(hiddenRepository);
      try {
        await symlink(
          metadataDirectory,
          path.join(fixtureRoot, 'visible-git-alias'),
          'dir',
        );
      } catch (error) {
        if (isWindowsSymlinkPermissionError(error)) {
          skip('Creating directory symlinks is not permitted on this Windows host');
        }
        throw error;
      }

      const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

      expect(result).toEqual([]);
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('does not use an alias to descend inside another repository', async ({ skip }) => {
    const repository = path.join(fixtureRoot, 'z-repository');
    const nestedDirectory = path.join(repository, 'nested');
    await initFixtureRepository(repository);
    await initFixtureRepository(path.join(nestedDirectory, 'hidden-repository'));
    try {
      await symlink(nestedDirectory, path.join(fixtureRoot, 'a-visible-alias'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });

  it('does not follow a later alias into an already discovered repository', async ({
    skip,
  }) => {
    const repository = path.join(fixtureRoot, 'a-repository');
    const nestedDirectory = path.join(repository, 'nested');
    await initFixtureRepository(repository);
    await initFixtureRepository(path.join(nestedDirectory, 'hidden-repository'));
    try {
      await symlink(nestedDirectory, path.join(fixtureRoot, 'z-visible-alias'), 'dir');
    } catch (error) {
      if (isWindowsSymlinkPermissionError(error)) {
        skip('Creating directory symlinks is not permitted on this Windows host');
      }
      throw error;
    }

    const result = await scanRepositories(fixtureRoot, { maxDepth: 2 });

    expect(result.map((item) => item.realPath)).toEqual([await realpath(repository)]);
  });
});
