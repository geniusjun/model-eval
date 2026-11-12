import { describe, expect, it } from 'vitest';

import { formatHash, parseHash, resolveView } from '../../../viewer/src/utils/hash.js';
import { loadComparison } from '../fixtures.js';

const SUMMARY = { kind: 'summary' } as const;

describe('002 location hash', () => {
  it('002 FR-004 FR-005 opens the summary for an empty hash and #/', () => {
    for (const hash of ['', '#', '#/']) {
      expect(parseHash(hash), hash).toEqual({ view: SUMMARY, lang: null });
    }
    expect(formatHash({ view: SUMMARY, lang: null })).toBe('#/');
  });

  it('002 FR-004 parses a cell hash and formats it back to the same string', () => {
    const hash = '#/cell/script-ja/ja/raw';
    const parsed = parseHash(hash);
    expect(parsed).toEqual({
      view: { kind: 'cell', ruleId: 'script-ja', lang: 'ja', surface: 'raw' },
      lang: null,
    });
    expect(formatHash(parsed)).toBe(hash);
  });

  it('002 FR-005 parses a side-by-side hash and formats it back to the same string', () => {
    const hash = '#/side/no-unprompted-self-state/mood-vague-ko/1';
    const parsed = parseHash(hash);
    expect(parsed).toEqual({
      view: {
        kind: 'side',
        ruleId: 'no-unprompted-self-state',
        caseId: 'mood-vague-ko',
        repeat: 1,
      },
      lang: null,
    });
    expect(formatHash(parsed)).toBe(hash);
  });

  it('002 FR-004 FR-005 encodes each segment, including IDs with / and non-ASCII text', () => {
    const cell = {
      view: { kind: 'cell', ruleId: 'tone/폴라이트', lang: 'ko', surface: 'final' },
      lang: null,
    } as const;
    const cellHash = formatHash(cell);
    expect(cellHash).toBe(`#/cell/${encodeURIComponent('tone/폴라이트')}/ko/final`);
    expect(parseHash(cellHash)).toEqual(cell);
    const side = {
      view: { kind: 'side', ruleId: 'a/b', caseId: '인사 ?#', repeat: 0 },
      lang: 'ko',
    } as const;
    const sideHash = formatHash(side);
    expect(sideHash).toBe(`#/side/a%2Fb/${encodeURIComponent('인사 ?#')}/0?lang=ko`);
    expect(parseHash(sideHash)).toEqual(side);
  });

  it('002 FR-013 reads ?lang=en and ?lang=ko after any hash and ignores other values', () => {
    expect(parseHash('#/?lang=ko')).toEqual({ view: SUMMARY, lang: 'ko' });
    expect(parseHash('#?lang=en')).toEqual({ view: SUMMARY, lang: 'en' });
    expect(parseHash('#/cell/script-ja/ja/raw?lang=ko')).toEqual({
      view: { kind: 'cell', ruleId: 'script-ja', lang: 'ja', surface: 'raw' },
      lang: 'ko',
    });
    expect(parseHash('#/side/r/c/0?lang=en')).toMatchObject({ lang: 'en' });
    for (const hash of ['#/?lang=fr', '#/?lang=', '#/?lang=KO', '#/?language=ko']) {
      expect(parseHash(hash).lang, hash).toBeNull();
    }
    expect(formatHash({ view: SUMMARY, lang: 'ko' })).toBe('#/?lang=ko');
  });

  it('002 FR-004 FR-005 opens the summary for a malformed hash', () => {
    for (const hash of [
      '#/cell/script-ja/ja',
      '#/cell/script-ja/ja/raw/extra',
      '#/side/r/c/one',
      '#/side/r/c/-1',
      '#/side/r/c/1.5',
      '#/side/r/c/01',
      '#/side/r/c/+1',
      '#/cell/%E0%A4%A/ja/raw',
      '#/other',
      '#cell/script-ja/ja/raw',
    ]) {
      expect(parseHash(hash).view, hash).toEqual(SUMMARY);
    }
  });

  it('002 FR-004 FR-005 resolves a view of the fixture and sends unknown names to the summary', () => {
    const comparison = loadComparison('block');
    const resolve = (hash: string) => resolveView(parseHash(hash).view, comparison);
    expect(resolve('#/cell/script-ja/ja/raw')).toMatchObject({
      kind: 'cell',
      cell: { ruleId: 'script-ja', lang: 'ja', surface: 'raw', verdict: 'regressed' },
    });
    expect(resolve('#/side/no-unprompted-self-state/mood-vague-ko/0')).toEqual({
      kind: 'side',
      ruleId: 'no-unprompted-self-state',
      caseId: 'mood-vague-ko',
      repeat: 0,
    });
    expect(resolve('#/side/script-ja/greet-ja/0')).toEqual({
      kind: 'side',
      ruleId: 'script-ja',
      caseId: 'greet-ja',
      repeat: 0,
    });
    for (const hash of [
      '#/',
      '#/cell/unknown-rule/ja/raw',
      '#/cell/script-ja/ko/raw',
      '#/cell/script-ja/ja/trial',
      '#/side/unknown-rule/mood-vague-ko/0',
      '#/side/no-unprompted-self-state/unknown-case/0',
      '#/side/no-unprompted-self-state/mood-vague-ko/1',
      '#/side/no-emoji/greet-ja/0',
    ]) {
      expect(resolve(hash), hash).toEqual(SUMMARY);
    }
  });
});
