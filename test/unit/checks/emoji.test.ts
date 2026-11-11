import { describe, expect, it } from 'vitest';

import { checkEmoji } from '../../../src/checks/emoji.js';

describe('emoji check', () => {
  it('001 FR-017 passes text without pictographs', () => {
    expect(checkEmoji('오늘 어땠어? Fine.')).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 fails on Extended_Pictographic characters, each named once', () => {
    expect(checkEmoji('좋아 😀 정말 😀👍')).toEqual({ outcome: 'fail', evidence: ['😀', '👍'] });
  });

  it('001 FR-017 catches U+00A9, U+2122 and U+2665', () => {
    expect(checkEmoji('© ™ ♥')).toEqual({ outcome: 'fail', evidence: ['©', '™', '♥'] });
  });

  it('001 FR-017 does not catch kaomoji', () => {
    expect(checkEmoji('(╯°□°)╯ ^_^ (｡•̀ᴗ-)')).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 names the pictographs of a joined sequence', () => {
    expect(checkEmoji('가족 👨‍👩‍👧')).toEqual({ outcome: 'fail', evidence: ['👨', '👩', '👧'] });
  });
});
