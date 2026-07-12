import { describe, expect, it } from 'vitest';
import { appError, sanitizedAppErrorDetails } from '../../src/domain/errors.js';
import { createId } from '../../src/domain/ids.js';

describe('createId', () => {
  it.each(['ws', 'preview', 'packet', 'kn'] as const)(
    'creates a Crockford Base32 %s ID',
    (prefix) => {
      expect(createId(prefix)).toMatch(
        new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`),
      );
    },
  );

  it('creates distinct IDs', () => {
    expect(new Set(Array.from({ length: 32 }, () => createId('ws'))).size).toBe(32);
  });
});

describe('appError', () => {
  it('returns a stable serializable error without a stack', () => {
    const error = appError('INVALID_MANIFEST', 'Manifest is invalid', {
      field: 'workspace_id',
    });

    expect(error).toEqual({
      code: 'INVALID_MANIFEST',
      message: 'Manifest is invalid',
      details: { field: 'workspace_id' },
    });
    expect(error).not.toHaveProperty('stack');
  });

  it('omits details when none are provided', () => {
    expect(appError('NOT_FOUND', 'Not found')).toEqual({
      code: 'NOT_FOUND',
      message: 'Not found',
    });
  });

  it('preserves stable remediation details while removing unsafe values', () => {
    const details = sanitizedAppErrorDetails(appError('STALE_PREVIEW', 'stale', {
      expected_head: 'abc123',
      actual_head: 'def456',
      nested: { repo_id: 'github.com/acme/api', secret: new Error('/private/token') },
    }));
    expect(details).toEqual({
      actual_head: 'def456',
      expected_head: 'abc123',
      nested: { repo_id: 'github.com/acme/api' },
    });
  });
});
