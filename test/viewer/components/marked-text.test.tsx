import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MarkedText, markPieces } from '../../../viewer/src/components/MarkedText.js';

describe('002 MarkedText', () => {
  it('002 FR-009 marks every occurrence of the evidence, joins touching marks and keeps the rest as text', () => {
    expect(markPieces('ab 화이팅 c 화', ['화', '이', '팅'])).toEqual([
      { text: 'ab ', marked: false },
      { text: '화이팅', marked: true },
      { text: ' c ', marked: false },
      { text: '화', marked: true },
    ]);
    expect(markPieces('none here', ['x'])).toEqual([{ text: 'none here', marked: false }]);
  });

  it('002 FR-009 renders markup in the text and the evidence as text, never as elements', () => {
    const { container } = render(
      <MarkedText text={'<b>x</b> $& <img src=x>'} marks={['<b>']} markLabel="breaks the rule" />,
    );
    expect(container.querySelector('b, img')).toBeNull();
    expect(container.querySelector('mark')?.firstChild?.textContent).toBe('<b>');
    expect(container.querySelector('.text')?.textContent).toBe('<b>x</b> $& <img src=x>');
    expect(container.textContent).toBe('breaks the rule: <b>. <b>x</b> $& <img src=x>');
  });
});
