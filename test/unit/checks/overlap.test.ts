import { describe, expect, it } from 'vitest';

import { checkOverlap } from '../../../src/checks/overlap.js';
import { NO_VALUES, parseCheck } from './parse-check.js';

const exampleLine = parseCheck('overlap', {
  with: ['나라면 조용한 부분부터 다시 들을래'],
  minChars: 10,
});

describe('overlap check', () => {
  it('001 FR-017 fails when the longest shared run reaches minChars, naming the run', () => {
    expect(checkOverlap(exampleLine, '그래, 나라면 조용한 부분부터 할래', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['나라면조용한부분부터'],
    });
  });

  it('001 FR-017 passes a shared run one code point short of minChars', () => {
    expect(checkOverlap(exampleLine, '나라면 조용한 부분부', NO_VALUES)).toEqual({
      outcome: 'pass',
    });
  });

  it('001 FR-017 removes all whitespace and applies NFKC on both sides', () => {
    const check = parseCheck('overlap', { with: ['Never use emoji'], minChars: 13 });
    expect(checkOverlap(check, 'Never  use\nemoji　ok', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['Neveruseemoji'],
    });
    expect(checkOverlap(check, 'Ｎｅｖｅｒ ｕｓｅ ｅｍｏｊｉ', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['Neveruseemoji'],
    });
  });

  it('001 FR-017 counts code points, not UTF-16 units', () => {
    const check = parseCheck('overlap', { with: ['😀😀'], minChars: 3 });
    expect(checkOverlap(check, '😀😀', NO_VALUES)).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 compares each given text on its own', () => {
    const check = parseCheck('overlap', { with: ['abcde', 'fghij'], minChars: 6 });
    expect(checkOverlap(check, 'abcdefghij', NO_VALUES)).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 reads withFrom from the case and treats a missing value as an empty list', () => {
    const check = parseCheck('overlap', { withFrom: 'input.example', minChars: 4 });
    expect(checkOverlap(check, '오늘은 비가 온다', { input: { example: '비가 온다' } })).toEqual({
      outcome: 'fail',
      evidence: ['비가온다'],
    });
    expect(checkOverlap(check, '오늘은 비가 온다', NO_VALUES)).toEqual({ outcome: 'pass' });
  });
});
