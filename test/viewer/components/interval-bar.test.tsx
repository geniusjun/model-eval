import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { percent, percentInterval } from '../../../src/report/format.js';
import { IntervalBar } from '../../../viewer/src/components/IntervalBar.js';

describe('002 IntervalBar', () => {
  it('002 FR-004 is an image whose title states the rate and its interval', () => {
    render(<IntervalBar label="next" rate={0.7} low={0.629} high={0.808} />);
    const chart = screen.getByRole('img');
    expect(chart.tagName.toLowerCase()).toBe('svg');
    const title = chart.querySelector('title');
    expect(title?.textContent).toContain('next');
    expect(title?.textContent).toContain(percent(0.7));
    expect(title?.textContent).toContain(percentInterval(0.629, 0.808));
    expect(chart.children.length).toBeGreaterThan(1);
  });

  it('002 FR-004 draws no bar when the rate and its interval are null', () => {
    render(<IntervalBar label="current" rate={null} low={null} high={null} />);
    const chart = screen.getByRole('img');
    expect(chart.querySelector('title')?.textContent).toContain(percent(null));
    expect([...chart.children].map((child) => child.tagName.toLowerCase())).toEqual(['title']);
  });
});
