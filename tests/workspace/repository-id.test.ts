import { describe, expect, it } from 'vitest';

import {
  canonicalRemote,
  normalizeRemote,
  repositoryIdFromRemote,
} from '../../src/workspace/repository-id.js';

describe('repository identity', () => {
  it('canonicalizes a credential-free stored Context remote', () => {
    expect(canonicalRemote('HTTPS://GitHub.com/Acme/Context.git/?token=ignored#fragment'))
      .toBe('https://github.com/Acme/Context.git');
    expect(canonicalRemote('git@GitHub.com:Acme/Context.git'))
      .toBe('git@github.com:Acme/Context.git');
  });

  it('normalizes SCP-like remotes without lowercasing the path', () => {
    expect(normalizeRemote('git@GitHub.com:Acme/API.git')).toBe('github.com/Acme/API');
  });

  it('normalizes URL remotes by removing credentials and trailing separators', () => {
    expect(normalizeRemote('https://user@github.com/Acme/API/')).toBe(
      'github.com/Acme/API',
    );
  });

  it('removes query strings and fragments from URL remotes', () => {
    expect(
      repositoryIdFromRemote('ssh://git@GitHub.com/Acme/API.git?ref=main#readme'),
    ).toBe('github.com/Acme/API');
  });

  it.each([
    'git@github.com:acme/../workspace.yaml',
    'git@github.com:acme/./api',
    String.raw`git@github.com:acme\..\workspace.yaml`,
  ])('rejects traversal-bearing SCP remotes: %s', (remote) => {
    expect(() => repositoryIdFromRemote(remote)).toThrow(/path segment/i);
  });
});
