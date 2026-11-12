import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { percent, percentInterval, points, pointsInterval } from '../../../src/report/format.js';
import { IntervalBar } from '../../../viewer/src/components/IntervalBar.js';

describe('002 IntervalBar', () => {
  it('002 FR-004 is an image whose title states the rate and its interval', () => {
    render(<IntervalBar label="next" value={0.7} low={0.629} high={0.808} />);
    const chart = screen.getByRole('img');
    expect(chart.tagName.toLowerCase()).toBe('svg');
    const title = chart.querySelector('title');
    expect(title?.textContent).toContain('next');
    expect(title?.textContent).toContain(percent(0.7));
    expect(title?.textContent).toContain(percentInterval(0.629, 0.808));
    expect(chart.children.length).toBeGreaterThan(1);
  });

  it('002 FR-004 draws no bar when the rate and its interval are null', () => {
    render(<IntervalBar label="current" value={null} low={null} high={null} />);
    const chart = screen.getByRole('img');
    expect(chart.querySelector('title')?.textContent).toContain(percent(null));
    expect([...chart.children].map((child) => child.tagName.toLowerCase())).toEqual(['title']);
  });

  it('002 FR-004 draws a difference from -100 to +100 points with a zero line, titled in points', () => {
    render(
      <IntervalBar
        kind="difference"
        label="Difference"
        value={-0.293}
        low={-0.371}
        high={-0.192}
      />,
    );
    const chart = screen.getByRole('img');
    expect(chart.querySelector('title')?.textContent).toBe(
      `Difference: ${points(-0.293)} ${pointsInterval(-0.371, -0.192)}`,
    );
    const width = Number(chart.getAttribute('viewBox')?.split(' ')[2]);
    const zero = chart.querySelector('line');
    expect(Number(zero?.getAttribute('x1'))).toBeCloseTo(width / 2);
    const interval = chart.querySelectorAll('rect')[1];
    expect(Number(interval?.getAttribute('x'))).toBeCloseTo(((1 - 0.371) / 2) * width);
    expect(Number(interval?.getAttribute('width'))).toBeCloseTo(((0.371 - 0.192) / 2) * width);
  });
});
