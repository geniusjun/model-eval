import { describe, expect, it } from 'vitest';

import { caseGlobMatcher } from '../../../src/run/case-glob.js';

function matches(glob: string, id: string): boolean {
  return caseGlobMatcher(glob)(id);
}

describe('--cases glob', () => {
  it('001 FR-010 matches literals, * and ?', () => {
    expect(matches('chat-ko-01', 'chat-ko-01')).toBe(true);
    expect(matches('chat-ko-01', 'chat-ko-010')).toBe(false);
    expect(matches('chat-*', 'chat-ja-02')).toBe(true);
    expect(matches('*-02', 'chat-ja-02')).toBe(true);
    expect(matches('**', 'chat-ja-02')).toBe(true);
    expect(matches('chat-??-01', 'chat-ko-01')).toBe(true);
    expect(matches('chat-?-01', 'chat-ko-01')).toBe(false);
  });

  it('001 FR-010 matches character classes, negated classes and braces', () => {
    expect(matches('chat-[kj]?-01', 'chat-ja-01')).toBe(true);
    expect(matches('chat-ko-0[1-3]', 'chat-ko-04')).toBe(false);
    expect(matches('chat-ko-0[!1]', 'chat-ko-01')).toBe(false);
    expect(matches('chat-ko-0[^1]', 'chat-ko-02')).toBe(true);
    expect(matches('chat-{ko,ja}-01', 'chat-ja-01')).toBe(true);
    expect(matches('chat-{ko,ja}-01', 'chat-en-01')).toBe(false);
    expect(matches('{chat-{ko,ja},faq}-*', 'faq-01')).toBe(true);
    expect(matches('chat-ko-0[9-1]', 'chat-ko-05')).toBe(false);
    expect(matches('{,a}b', 'b')).toBe(true);
    expect(matches('[]]', ']')).toBe(true);
    expect(matches('[!]]', ']')).toBe(false);
    expect(matches('[!]]', 'a')).toBe(true);
    expect(matches('[-a]', '-')).toBe(true);
    expect(matches('[a-]', '-')).toBe(true);
  });

  it('001 FR-010 escapes inside brackets the same way as outside', () => {
    expect(matches('[\\d]', 'd')).toBe(true);
    expect(matches('[\\d]', '1')).toBe(false);
    expect(matches('a[\\]]', 'a]')).toBe(true);
    expect(matches('a[x\\-z]', 'a-')).toBe(true);
    expect(matches('a[x\\-z]', 'ay')).toBe(false);
  });

  it('001 FR-010 answers in time linear in the pattern and the ID', () => {
    const id = 'a'.repeat(64);
    expect(matches(`${'*a'.repeat(32)}b`, id)).toBe(false);
    expect(matches('{a,*}'.repeat(32), id)).toBe(true);
    expect(matches('['.repeat(200_000), id)).toBe(false);
    expect(matches('{a,[b'.repeat(50_000), id)).toBe(false);
  });

  it('001 FR-010 reads braces nested deeper than 64 as literal characters', () => {
    const nested = (depth: number): string => `${'{x,'.repeat(depth)}a${'}'.repeat(depth)}`;
    expect(matches(nested(64), 'a')).toBe(true);
    expect(matches(nested(65), 'a')).toBe(false);
    expect(matches(nested(65), '{x,a}')).toBe(true);
    expect(matches(nested(20_000), 'x')).toBe(true);
  });

  it('001 FR-010 treats regular expression characters, escapes and unclosed brackets literally', () => {
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('a\\*', 'a*')).toBe(true);
    expect(matches('a\\*', 'ab')).toBe(false);
    expect(matches('a[b', 'a[b')).toBe(true);
    expect(matches('a{b', 'a{b')).toBe(true);
    expect(matches('a{b,c', 'a{b,c')).toBe(true);
    expect(matches('a+(b)', 'a+(b)')).toBe(true);
    expect(matches('{a}', '{a}')).toBe(true);
    expect(matches('a\\', 'a')).toBe(false);
    expect(matches('a\\', 'a\\')).toBe(true);
  });

  it('001 FR-010 is case-sensitive on every OS', () => {
    expect(matches('CHAT-KO-01', 'chat-ko-01')).toBe(false);
    expect(matches('C*', 'chat-ko-01')).toBe(false);
    expect(matches('chat-[A-Z]?-01', 'chat-ko-01')).toBe(false);
    expect(matches('chat-{KO,JA}-01', 'chat-ko-01')).toBe(false);
  });
});
