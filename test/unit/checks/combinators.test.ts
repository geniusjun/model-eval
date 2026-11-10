import { describe, expect, it } from 'vitest';

import { runCheck } from '../../../src/checks/registry.js';
import { checkSchema, gradingCheckSchema } from '../../../src/config/schema.js';
import { NO_VALUES, parseCheck } from './parse-check.js';

const emoji = { type: 'emoji' };
const polite = { type: 'pattern', regex: '요$', mode: 'forbid' };
const question = { type: 'pattern', regex: '\\?$', mode: 'require' };

describe('all, any and not', () => {
  it('001 FR-017 all fails when a child fails, with the evidence of every failing child', () => {
    const check = parseCheck('all', { checks: [emoji, polite] });
    expect(runCheck(check, '좋아', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(runCheck(check, '좋아요', NO_VALUES)).toEqual({ outcome: 'fail', evidence: ['요'] });
    expect(runCheck(check, '😀 좋아요', NO_VALUES)).toEqual({
      outcome: 'fail',
      evidence: ['😀', '요'],
    });
  });

  it('001 FR-017 any passes when one child passes and fails when every child fails', () => {
    const check = parseCheck('any', { checks: [question, polite] });
    expect(runCheck(check, '뭐 했어?', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(runCheck(check, '좋아', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(runCheck(check, '좋아요', NO_VALUES)).toEqual({ outcome: 'fail', evidence: ['요'] });
  });

  it('001 FR-017 not passes when its child fails and fails when it passes', () => {
    const check = parseCheck('not', { check: emoji });
    expect(runCheck(check, '😀', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(runCheck(check, '좋아', NO_VALUES)).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 nests', () => {
    const exclaims = { type: 'pattern', regex: '!$', mode: 'require' };
    const check = parseCheck('all', {
      checks: [
        { type: 'not', check: exclaims },
        { type: 'any', checks: [question, polite] },
      ],
    });
    expect(runCheck(check, '뭐 했어?', NO_VALUES)).toEqual({ outcome: 'pass' });
    expect(runCheck(check, '좋아요', NO_VALUES)).toEqual({ outcome: 'fail', evidence: ['요'] });
    expect(runCheck(check, '뭐 했어!', NO_VALUES)).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 cannot run when a child cannot, whatever the other children give', () => {
    const unresolved = { type: 'phrases', mode: 'forbid', anyFrom: 'params.words' };
    const problem = { code: 'unresolved-ref', path: 'params.words' };
    for (const type of ['all', 'any'] as const) {
      const check = parseCheck(type, { checks: [emoji, unresolved] });
      expect(runCheck(check, '😀', NO_VALUES)).toEqual({ outcome: 'error', problem });
      expect(runCheck(check, '좋아', NO_VALUES)).toEqual({ outcome: 'error', problem });
    }
    expect(runCheck(parseCheck('not', { check: unresolved }), '좋아', NO_VALUES)).toEqual({
      outcome: 'error',
      problem,
    });
  });

  it('001 FR-017 cannot contain completed or review', () => {
    for (const child of [{ type: 'completed' }, { type: 'review' }]) {
      expect(gradingCheckSchema.safeParse({ type: 'all', checks: [emoji, child] }).success).toBe(
        false,
      );
      expect(gradingCheckSchema.safeParse({ type: 'any', checks: [child] }).success).toBe(false);
      expect(gradingCheckSchema.safeParse({ type: 'not', check: child }).success).toBe(false);
      expect(
        checkSchema.safeParse({ type: 'not', check: { type: 'all', checks: [child] } }).success,
      ).toBe(false);
      expect(checkSchema.safeParse(child).success).toBe(true);
    }
  });
});
