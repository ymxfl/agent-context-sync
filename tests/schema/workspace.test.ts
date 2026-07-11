import { describe, expect, it } from 'vitest';
import {
  parseLocalWorkspace,
  parseWorkspaceManifest,
} from '../../src/schema/workspace.js';

const workspaceId = 'ws_01J00000000000000000000000';

describe('parseWorkspaceManifest', () => {
  it('rejects local paths in the shared manifest', () => {
    expect(() => parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: 'git@github.com:acme/platform-context.git',
      local_path: '/private/work',
      repositories: [],
    })).toThrow(/unrecognized/i);
  });

  it.each([
    '/private/platform-context',
    String.raw`C:\Users\alice\platform-context`,
  ])('rejects absolute local context remote %s', (contextRemote) => {
    expect(() => parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: contextRemote,
      repositories: [],
    })).toThrow();
  });

  it.each([
    'https://github.com/acme/platform-context.git',
    'git@github.com:acme/platform-context.git',
  ])('accepts Git context remote %s', (contextRemote) => {
    expect(parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: contextRemote,
      repositories: [],
    }).context_remote).toBe(contextRemote);
  });

  it('accepts normalized repository IDs', () => {
    const manifest = parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: 'git@github.com:acme/platform-context.git',
      repositories: [{
        schema_version: 1,
        repo_id: 'github.com/acme/backend',
        name: 'backend',
      }],
    });

    expect(manifest.repositories[0]?.repo_id).toBe('github.com/acme/backend');
  });

  it.each([
    'https://github.com/acme/backend',
    'GitHub.com/acme/backend',
    'github.com/acme/backend.git',
    'github.com/acme/backend/',
  ])('rejects non-normalized repository ID %s', (repoId) => {
    expect(() => parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: 'git@github.com:acme/platform-context.git',
      repositories: [{ schema_version: 1, repo_id: repoId, name: 'backend' }],
    })).toThrow();
  });

  it('rejects unknown repository fields', () => {
    expect(() => parseWorkspaceManifest({
      schema_version: 1,
      workspace_id: workspaceId,
      name: 'platform',
      context_remote: 'git@github.com:acme/platform-context.git',
      repositories: [{
        schema_version: 1,
        repo_id: 'github.com/acme/backend',
        name: 'backend',
        local_path: '/private/backend',
      }],
    })).toThrow(/unrecognized/i);
  });
});

describe('parseLocalWorkspace', () => {
  it('accepts absolute paths only in the local registry', () => {
    expect(parseLocalWorkspace({
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: '/tmp/context',
      repository_paths: { 'github.com/acme/backend': '/tmp/backend' },
    }).context_path).toBe('/tmp/context');
  });

  it('rejects relative local paths', () => {
    expect(() => parseLocalWorkspace({
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: './context',
      repository_paths: {},
    })).toThrow();

    expect(() => parseLocalWorkspace({
      schema_version: 1,
      workspace_id: workspaceId,
      context_path: '/tmp/context',
      repository_paths: { 'github.com/acme/backend': '../backend' },
    })).toThrow();
  });

  it('rejects invalid workspace IDs and schema versions', () => {
    expect(() => parseLocalWorkspace({
      schema_version: 2,
      workspace_id: 'ws_invalid',
      context_path: '/tmp/context',
      repository_paths: {},
    })).toThrow();
  });
});
