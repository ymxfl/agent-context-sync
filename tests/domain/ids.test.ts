import { describe, expect, it } from 'vitest';
import { appError } from '../../src/domain/errors.js';
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
});
