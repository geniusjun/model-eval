import { describe, expect, it } from 'vitest';

import { checkScript } from '../../../src/checks/script.js';
import { NO_VALUES, parseCheck } from './parse-check.js';

const korean = parseCheck('script', { allow: ['Hangul', 'Latin', 'Common', 'Inherited'] });

describe('script check', () => {
  it('001 FR-017 passes text written only in allowed scripts', () => {
    expect(checkScript(korean, '안녕! Hi, 2026년이야.', NO_VALUES)).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 fails on characters of other scripts, each named once in order', () => {
    expect(checkScript(korean, '안녕 你好 你', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['你', '好'],
    });
  });

  it('001 FR-017 reads code points, so a character outside the BMP is one character', () => {
    expect(checkScript(korean, '안녕 𠀀', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['𠀀'],
    });
  });

  it('001 FR-017 uses the Script property, not Script_Extensions', () => {
    // U+3001 and U+30FC are Script=Common although their Script_Extensions list Hangul and Katakana.
    const hangulOnly = parseCheck('script', { allow: ['Hangul'] });
    expect(checkScript(hangulOnly, '안녕、', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['、'],
    });
    const katakanaOnly = parseCheck('script', { allow: ['Katakana'] });
    expect(checkScript(katakanaOnly, 'カー', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['ー'],
    });
  });

  it('001 FR-017 removes ignore strings before checking', () => {
    const hangul = parseCheck('script', { allow: ['Hangul', 'Common'] });
    expect(checkScript(hangul, '안녕 GPT', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['G', 'P', 'T'],
    });
    const ignoring = parseCheck('script', { allow: ['Hangul', 'Common'], ignore: ['GPT'] });
    expect(checkScript(ignoring, '안녕 GPT', NO_VALUES)).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 removes ignoreFrom values read from the case', () => {
    const check = parseCheck('script', {
      allow: ['Hangul', 'Common'],
      ignoreFrom: 'input.nickname',
    });
    expect(checkScript(check, '안녕 Sky', { input: { nickname: 'Sky' } })).toEqual({
      outcome: 'pass',
    });
    expect(checkScript(check, 'Sky와 Mo', { input: { nickname: ['Sky', 'Mo'] } })).toEqual({
      outcome: 'pass',
    });
  });

  it('001 FR-017 treats a missing ignoreFrom value as an empty list', () => {
    const check = parseCheck('script', {
      allow: ['Hangul', 'Common'],
      ignoreFrom: 'input.nickname',
    });
    expect(checkScript(check, '안녕 Sky', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['S', 'k', 'y'],
    });
  });

  it('001 FR-017 cannot run when ignoreFrom points at a value that is not text', () => {
    const check = parseCheck('script', { allow: ['Hangul'], ignoreFrom: 'input.count' });
    expect(checkScript(check, '안녕', { input: { count: 3 } })).toEqual({
      outcome: 'error',
      problem: { code: 'not-text', path: 'input.count' },
    });
  });

  it('001 FR-017 cannot run with a name that is not a Unicode script', () => {
    const check = parseCheck('script', { allow: ['Hangul', 'Klingon'] });
    expect(checkScript(check, '안녕', NO_VALUES)).toEqual({
      outcome: 'error',
      problem: { code: 'unknown-script', script: 'Klingon' },
    });
    const injected = parseCheck('script', { allow: ['Latin}\\p{L'] });
    expect(checkScript(injected, '안녕', NO_VALUES)).toEqual({
      outcome: 'error',
      problem: { code: 'unknown-script', script: 'Latin}\\p{L' },
    });
  });
});
