import { describe, expect, it } from 'vitest';

import { checkPhrases } from '../../../src/checks/phrases.js';
import { NO_VALUES, parseCheck } from './parse-check.js';

describe('phrases check', () => {
  it('001 FR-017 forbid fails when a listed phrase appears, naming the phrases as listed', () => {
    const check = parseCheck('phrases', { mode: 'forbid', any: ['짜증', '화남', 'Angry'] });
    expect(checkPhrases(check, '오늘 짜증 골랐더라. so ANGRY', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['짜증', 'Angry'],
    });
    expect(checkPhrases(check, '오늘 좀 그랬구나.', NO_VALUES)).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 require fails when no listed phrase appears', () => {
    const check = parseCheck('phrases', { mode: 'require', any: ['고마워', '감사'] });
    expect(checkPhrases(check, '정말 고마워!', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(checkPhrases(check, '그래.', NO_VALUES)).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 normalises both sides with NFKC and lower case by default', () => {
    const check = parseCheck('phrases', { mode: 'forbid', any: ['angry', '짜증'] });
    expect(checkPhrases(check, 'ＡＮＧＲＹ', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['angry'],
    });
    expect(checkPhrases(check, '짜증'.normalize('NFD'), NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['짜증'],
    });
  });

  it('001 FR-017 matches verbatim without normalize', () => {
    const check = parseCheck('phrases', { mode: 'forbid', any: ['angry'], normalize: false });
    expect(checkPhrases(check, 'ANGRY', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(checkPhrases(check, 'so angry', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['angry'],
    });
  });

  it('001 FR-017 reads anyFrom from the rule params and adds it to any', () => {
    const check = parseCheck('phrases', { mode: 'forbid', any: ['화남'], anyFrom: 'params.words' });
    const values = { input: {}, params: { words: ['짜증'] } };
    expect(checkPhrases(check, '짜증 났어?', values)).toEqual({
      outcome: 'fail',
      evidence: ['짜증'],
    });
    expect(checkPhrases(check, '화남', values)).toEqual({ outcome: 'fail', evidence: ['화남'] });
  });

  it('001 FR-017 reads a string anyFrom value as a one-item list', () => {
    const check = parseCheck('phrases', { mode: 'forbid', anyFrom: 'input.mood.label' });
    expect(checkPhrases(check, '짜증 골랐네', { input: { mood: { label: '짜증' } } })).toEqual({
      outcome: 'fail',
      evidence: ['짜증'],
    });
  });

  it('001 FR-017 cannot run when the anyFrom value is missing, since an empty forbid list checks nothing', () => {
    const check = parseCheck('phrases', { mode: 'forbid', anyFrom: 'params.words' });
    expect(checkPhrases(check, '짜증', NO_VALUES)).toEqual({
      outcome: 'error',
      problem: { code: 'unresolved-ref', path: 'params.words' },
    });
  });

  it('001 FR-017 drops empty strings from the anyFrom value', () => {
    const check = parseCheck('phrases', { mode: 'forbid', anyFrom: 'params.words' });
    const values = { input: {}, params: { words: ['', '짜증'] } };
    expect(checkPhrases(check, '오늘 좀 그랬구나', values)).toEqual({ outcome: 'pass' });
    expect(checkPhrases(check, '짜증 났어?', values)).toEqual({
      outcome: 'fail',
      evidence: ['짜증'],
    });
  });

  it('001 FR-017 cannot run when the anyFrom value has no phrase left', () => {
    const check = parseCheck('phrases', {
      mode: 'require',
      any: ['고마워'],
      anyFrom: 'params.words',
    });
    for (const words of [[], [''], ['', ''], '']) {
      expect(checkPhrases(check, '고마워', { input: {}, params: { words } })).toEqual({
        outcome: 'error',
        problem: { code: 'unresolved-ref', path: 'params.words' },
      });
    }
  });
});
