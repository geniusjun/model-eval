import { describe, expect, it } from 'vitest';

import { CASE_PATH_PATTERN, lookupCasePath, textListAt } from '../../../src/config/paths.js';

const values = {
  input: { nickname: '하늘', state: { wearing: ['목도리'] }, count: 3 },
  params: { words: ['짜증', '화남'] },
};

describe('case path references', () => {
  it('001 FR-017 accepts input and params paths only', () => {
    expect(CASE_PATH_PATTERN.test('input.nickname')).toBe(true);
    expect(CASE_PATH_PATTERN.test('params.words')).toBe(true);
    expect(CASE_PATH_PATTERN.test('input.state.wearing')).toBe(true);
    expect(CASE_PATH_PATTERN.test('input')).toBe(false);
    expect(CASE_PATH_PATTERN.test('case.input.x')).toBe(false);
    expect(CASE_PATH_PATTERN.test('input..x')).toBe(false);
  });

  it('001 FR-017 follows nested keys into the case input and the rule params', () => {
    expect(lookupCasePath('input.state.wearing', values)).toEqual({
      found: true,
      value: ['목도리'],
    });
    expect(lookupCasePath('params.words', values)).toEqual({
      found: true,
      value: ['짜증', '화남'],
    });
    expect(lookupCasePath('input.missing', values)).toEqual({ found: false });
    expect(lookupCasePath('input.nickname.more', values)).toEqual({ found: false });
    expect(lookupCasePath('params.words', { input: {} })).toEqual({ found: false });
  });

  it('001 FR-002 reads a string as a one-item list and tells missing values apart', () => {
    expect(textListAt('input.nickname', values)).toEqual({ kind: 'list', values: ['하늘'] });
    expect(textListAt('params.words', values)).toEqual({ kind: 'list', values: ['짜증', '화남'] });
    expect(textListAt('input.missing', values)).toEqual({ kind: 'missing' });
    expect(textListAt('input.count', values)).toEqual({ kind: 'not-text', value: 3 });
  });
});
