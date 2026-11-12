import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CodeText } from '../../../viewer/src/components/CodeText.js';

const UNTRUSTED = [
  '</script>',
  '<!--',
  '$&',
  '<img src=x onerror=alert(1)>',
  '<b>bold</b>',
  'line one\nline two\n\n  indented',
];

describe('002 CodeText', () => {
  it('002 FR-009 renders markup and replacement patterns as text and adds no element', () => {
    for (const text of UNTRUSTED) {
      const { container, unmount } = render(<CodeText text={text} />);
      const element = container.firstElementChild;
      expect(container.childElementCount, text).toBe(1);
      expect(element?.childElementCount, text).toBe(0);
      expect(element?.textContent, text).toBe(text);
      expect(container.querySelector('img, b, script'), text).toBeNull();
      unmount();
    }
  });

  it('002 FR-009 keeps newlines with white-space: pre-wrap', () => {
    const { container } = render(<CodeText text={'a\nb'} />);
    const element = container.firstElementChild;
    expect(element).not.toBeNull();
    if (element !== null) {
      expect(getComputedStyle(element).whiteSpace).toBe('pre-wrap');
    }
  });
});
