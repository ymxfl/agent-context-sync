import { describe, expect, it } from 'vitest';

import { compareCodeUnits } from '../../src/domain/compare.js';

describe('compareCodeUnits', () => {
  it('orders non-ASCII strings by UTF-16 code units without locale rules', () => {
    const values = ['é', 'z', 'ä', 'Z', '中', 'a'];
    expect(values.sort(compareCodeUnits)).toEqual(['Z', 'a', 'z', 'ä', 'é', '中']);
  });
});
