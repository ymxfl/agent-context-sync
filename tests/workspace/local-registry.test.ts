import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { LocalWorkspace } from '../../src/domain/model.js';
import {
  atomicWriteFile,
  nodeAtomicWriteAdapter,
} from '../../src/fs/atomic-write.js';
import {
  bindRepositoryPath,
  readLocalWorkspace,
  registryPath,
  writeLocalWorkspace,
} from '../../src/workspace/local-registry.js';

const workspaceId = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const otherWorkspaceId = 'ws_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const repoId = 'github.com/acme/api';

describe('local workspace registry', () => {
  it('stores private local mappings as mode 0600 YAML', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-registry-'));
    const repository = await fs.mkdtemp(path.join(home, 'repo-'));
    const realRepo = await fs.realpath(repository);
    const contextPath = await fs.mkdtemp(path.join(home, 'context-'));
    const contextRemote = 'git@github.com:acme/context.git';
    const local: LocalWorkspace = bindRepositoryPath({
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: contextPath,
      repository_paths: {},
    }, repoId, realRepo);

    try {
      await writeLocalWorkspace(home, local);

      const registryFile = registryPath(home, workspaceId);
      const loaded = await readLocalWorkspace(home, workspaceId);
      const serialized = await fs.readFile(registryFile, 'utf8');

      expect(registryFile).toBe(path.join(home, 'workspaces', `${workspaceId}.yaml`));
      expect(loaded.repository_paths[repoId]).toBe(realRepo);
      expect(serialized).not.toContain(contextRemote);
      expect((await fs.stat(registryFile)).mode & 0o077).toBe(0);
      expect(await fs.readdir(path.dirname(registryFile))).toEqual([
        `${workspaceId}.yaml`,
      ]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the original registry byte-identical when rename fails', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-registry-'));
    const contextPath = await fs.mkdtemp(path.join(home, 'context-'));
    const local: LocalWorkspace = {
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: contextPath,
      repository_paths: {},
    };

    try {
      await writeLocalWorkspace(home, local);
      const registryFile = registryPath(home, workspaceId);
      const original = await fs.readFile(registryFile);
      const failingWriter = (file: string, contents: string) => atomicWriteFile(
        file,
        contents,
        {
          ...nodeAtomicWriteAdapter,
          rename: async () => {
            throw new Error('injected failure before rename');
          },
        },
      );

      await expect(writeLocalWorkspace(home, {
        ...local,
        repository_paths: { [repoId]: contextPath },
      }, failingWriter)).rejects.toThrow('injected failure before rename');

      expect(await fs.readFile(registryFile)).toEqual(original);
      expect(await fs.readdir(path.dirname(registryFile))).toEqual([
        `${workspaceId}.yaml`,
      ]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('rejects workspace IDs that could escape the registry directory', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-registry-'));

    try {
      expect(() => registryPath(home, '../../outside')).toThrow(/workspace id/i);
      await expect(readLocalWorkspace(home, '../../outside')).rejects.toThrow(
        /workspace id/i,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('rejects registry content for a different workspace ID', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-registry-'));
    const contextPath = await fs.mkdtemp(path.join(home, 'context-'));

    try {
      await writeLocalWorkspace(home, {
        schema_version: 1,
        workspace_id: otherWorkspaceId,
        context_path: contextPath,
        repository_paths: {},
      });
      await fs.copyFile(
        registryPath(home, otherWorkspaceId),
        registryPath(home, workspaceId),
      );

      await expect(readLocalWorkspace(home, workspaceId)).rejects.toThrow(
        /does not match/i,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('forces exact mode 0600 even under a restrictive umask', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'acs-registry-'));
    const contextPath = await fs.mkdtemp(path.join(home, 'context-'));
    const local: LocalWorkspace = {
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: contextPath,
      repository_paths: {},
    };
    const previousUmask = process.umask(0o777);

    try {
      await writeLocalWorkspace(home, local);
    } finally {
      process.umask(previousUmask);
    }

    try {
      const registryFile = registryPath(home, workspaceId);
      expect((await fs.stat(registryFile)).mode & 0o777).toBe(0o600);
      await expect(fs.readFile(registryFile, 'utf8')).resolves.toContain(
        workspaceId,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('binds the canonical repository path without mutating the input', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'acs-bind-'));
    const repository = await fs.mkdtemp(path.join(root, 'repository-'));
    const alias = path.join(root, 'alias');
    await fs.symlink(repository, alias, 'dir');
    const local: LocalWorkspace = {
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: root,
      repository_paths: {},
    };

    try {
      const bound = bindRepositoryPath(local, repoId, alias);

      expect(bound.repository_paths[repoId]).toBe(await fs.realpath(repository));
      expect(local.repository_paths).toEqual({});
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects relative and non-existent repository paths', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'acs-bind-'));
    const local: LocalWorkspace = {
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: root,
      repository_paths: {},
    };

    try {
      expect(() => bindRepositoryPath(local, repoId, 'relative/repo')).toThrow(
        /absolute/i,
      );
      expect(() => bindRepositoryPath(
        local,
        repoId,
        path.join(root, 'missing'),
      )).toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
