import { describe, expect, it } from 'vitest';

import {
  normalizeRemote,
  repositoryIdFromRemote,
} from '../../src/workspace/repository-id.js';

describe('repository identity', () => {
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
});
