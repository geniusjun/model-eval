import { describe, expect, it } from 'vitest';

import { checkLength } from '../../../src/checks/length.js';
import { parseCheck } from './parse-check.js';

describe('length check', () => {
  it('001 FR-017 fails outside the inclusive range, giving the measured length', () => {
    const check = parseCheck('length', { min: 2, max: 4, unit: 'chars' });
    expect(checkLength(check, 'ab')).toEqual({ outcome: 'pass' });
    expect(checkLength(check, 'abcd')).toEqual({ outcome: 'pass' });
    expect(checkLength(check, 'a')).toEqual({ outcome: 'fail', evidence: ['1'] });
    expect(checkLength(check, 'abcde')).toEqual({ outcome: 'fail', evidence: ['5'] });
  });

  it('001 FR-017 checks only the bound that is set', () => {
    expect(checkLength(parseCheck('length', { max: 3, unit: 'chars' }), '')).toEqual({
      outcome: 'pass',
    });
    expect(checkLength(parseCheck('length', { min: 1, unit: 'chars' }), 'a'.repeat(5000))).toEqual({
      outcome: 'pass',
    });
  });

  it('001 FR-017 chars counts code points', () => {
    const check = parseCheck('length', { max: 2, unit: 'chars' });
    expect(checkLength(check, '😀😀')).toEqual({ outcome: 'pass' });
    expect(checkLength(check, '한'.normalize('NFD'))).toEqual({ outcome: 'fail', evidence: ['3'] });
  });

  it('001 FR-017 graphemes counts extended grapheme clusters', () => {
    const check = parseCheck('length', { max: 1, unit: 'graphemes' });
    expect(checkLength(check, '👨‍👩‍👧')).toEqual({ outcome: 'pass' });
    expect(checkLength(check, '한'.normalize('NFD'))).toEqual({ outcome: 'pass' });
    expect(checkLength(check, '🇰🇷🇯🇵')).toEqual({ outcome: 'fail', evidence: ['2'] });
  });
});
