import { describe, expect, it } from 'vitest';

import { checkPattern } from '../../../src/checks/pattern.js';
import { gradingCheckSchema } from '../../../src/config/schema.js';
import { parseCheck } from './parse-check.js';

const banmal = parseCheck('pattern', {
  regex: '((?<![필중])요|습니다|세요)[.?!]*$',
  flags: 'm',
  mode: 'forbid',
});

describe('pattern check', () => {
  it('001 FR-017 forbid fails when the regex matches, with the matched strings', () => {
    expect(checkPattern(banmal, '오늘 어땠어요?\n좋습니다.')).toEqual({
      outcome: 'fail',
      evidence: ['요?', '습니다.'],
    });
    expect(checkPattern(banmal, '오늘 어땠어?\n그건 필요.\n그게 중요.')).toEqual({
      outcome: 'pass',
    });
  });

  it('001 FR-017 names each matched string once', () => {
    const check = parseCheck('pattern', { regex: '요', mode: 'forbid' });
    expect(checkPattern(check, '좋아요. 그래요.')).toEqual({ outcome: 'fail', evidence: ['요'] });
  });

  it('001 FR-017 require fails when the regex does not match', () => {
    const check = parseCheck('pattern', { regex: '\\?$', mode: 'require' });
    expect(checkPattern(check, '뭐 했어?')).toEqual({ outcome: 'pass' });
    expect(checkPattern(check, '그랬구나.')).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 always applies the u flag', () => {
    const check = parseCheck('pattern', { regex: '^.$', mode: 'forbid' });
    expect(checkPattern(check, '😀')).toEqual({ outcome: 'fail', evidence: ['😀'] });
    const property = parseCheck('pattern', { regex: '\\p{Script=Han}', mode: 'forbid' });
    expect(checkPattern(property, '你')).toEqual({ outcome: 'fail', evidence: ['你'] });
  });

  it('001 FR-017 applies the i, m and s flags', () => {
    const caseless = parseCheck('pattern', { regex: 'as an ai', flags: 'i', mode: 'forbid' });
    expect(checkPattern(caseless, 'As an AI, I')).toEqual({
      outcome: 'fail',
      evidence: ['As an AI'],
    });
    const dotAll = parseCheck('pattern', { regex: 'a.b', flags: 's', mode: 'forbid' });
    expect(checkPattern(dotAll, 'a\nb')).toEqual({ outcome: 'fail', evidence: ['a\nb'] });
    const lineStart = parseCheck('pattern', { regex: '^b', mode: 'forbid' });
    expect(checkPattern(lineStart, 'a\nb')).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 gives the same result on every call, whatever was checked before', () => {
    const check = parseCheck('pattern', { regex: '요', mode: 'forbid' });
    const first = checkPattern(check, '좋아요');
    checkPattern(check, '요요요 요');
    checkPattern(check, '아니');
    expect(checkPattern(check, '좋아요')).toEqual(first);
  });

  it('001 FR-017 rejects the g and y flags, which make results depend on call order', () => {
    for (const flags of ['g', 'y', 'ig']) {
      const parsed = gradingCheckSchema.safeParse({
        type: 'pattern',
        regex: 'a',
        flags,
        mode: 'forbid',
      });
      expect(parsed.success).toBe(false);
    }
  });
});
