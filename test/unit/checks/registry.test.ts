import { describe, expect, it } from 'vitest';

import { runCheck } from '../../../src/checks/registry.js';
import { gradingCheckSchema } from '../../../src/config/schema.js';

const CHECKS = [
  { type: 'script', allow: ['Hangul', 'Common'], ignoreFrom: 'input.nickname' },
  { type: 'emoji' },
  { type: 'pattern', regex: '요[.?!]*$', flags: 'm', mode: 'forbid' },
  { type: 'phrases', mode: 'forbid', anyFrom: 'params.words' },
  { type: 'overlap', with: ['조용한 부분부터 다시 들을래'], minChars: 6 },
  { type: 'length', max: 12, unit: 'graphemes' },
  { type: 'json', schema: { type: 'object' } },
  { type: 'all', checks: [{ type: 'emoji' }, { type: 'length', min: 1, unit: 'chars' }] },
  { type: 'any', checks: [{ type: 'emoji' }, { type: 'json' }] },
  { type: 'not', check: { type: 'emoji' } },
].map((check) => gradingCheckSchema.parse(check));

const TEXTS = [
  '안녕 Sky! 짜증 났어요?',
  '조용한 부분부터 다시 들을래 😀',
  '{"reply": "hi"}',
  '',
  '你好 Sky',
];

const values = { input: { nickname: 'Sky' }, params: { words: ['짜증'] } };

describe('check registry', () => {
  it('001 FR-017 dispatches every grading check type', () => {
    const types = new Set(CHECKS.map((check) => check.type));
    expect(types).toEqual(
      new Set([
        'script',
        'emoji',
        'pattern',
        'phrases',
        'overlap',
        'length',
        'json',
        'all',
        'any',
        'not',
      ]),
    );
    for (const check of CHECKS) {
      expect(['pass', 'fail']).toContain(runCheck(check, TEXTS[0] ?? '', values).outcome);
    }
  });

  it('001 FR-017 gives the same result for the same text and definition every time', () => {
    const first = CHECKS.map((check) => TEXTS.map((text) => runCheck(check, text, values)));
    // Interleave the calls differently, so state kept between calls would show.
    for (const text of [...TEXTS].reverse()) {
      for (const check of CHECKS) {
        runCheck(check, text, values);
      }
    }
    const second = CHECKS.map((check) => TEXTS.map((text) => runCheck(check, text, values)));
    expect(second).toEqual(first);
  });
});
