import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffChart, scaleX, type DiffScale } from '../../../viewer/src/components/DiffChart.js';

const SCALE: DiffScale = { low: -0.4, high: 0.1, ticks: [-0.4, -0.3, -0.2, -0.1, 0, 0.1] };

function renderChart(tone: 'regressed' | 'improved' | 'neutral' = 'regressed') {
  render(
    <DiffChart
      title="script-ja (ja, raw): difference -29.3pp [-37.1, -19.2], margin -10pp"
      estimate={-0.293}
      low={-0.371}
      high={-0.192}
      margin={0.1}
      scale={SCALE}
      tone={tone}
    />,
  );
  return screen.getByRole('img');
}

describe('002 DiffChart', () => {
  it('002 FR-002 is an SVG image whose title states the difference, its interval and the margin', () => {
    const chart = renderChart();
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(chart.querySelector('title')?.textContent).toBe(
      'script-ja (ja, raw): difference -29.3pp [-37.1, -19.2], margin -10pp',
    );
  });

  it('002 FR-002 places the interval, the estimate, zero and the margin on the shared scale', () => {
    const chart = renderChart();
    const width = 100;
    const at = (value: number) => ((value - SCALE.low) / (SCALE.high - SCALE.low)) * width;
    expect(scaleX(0, SCALE)).toBeCloseTo(at(0));
    expect(scaleX(-1, SCALE)).toBe(0);
    expect(scaleX(1, SCALE)).toBe(width);
    const interval = chart.querySelector('rect');
    expect(Number(interval?.getAttribute('x'))).toBeCloseTo(at(-0.371));
    expect(Number(interval?.getAttribute('width'))).toBeCloseTo(at(-0.192) - at(-0.371));
    const [margin, zero, estimate] = [...chart.querySelectorAll('line')].map((line) =>
      Number(line.getAttribute('x1')),
    );
    expect(margin).toBeCloseTo(at(-0.1));
    expect(zero).toBeCloseTo(at(0));
    expect(estimate).toBeCloseTo(at(-0.293));
  });

  it('002 FR-002 leaves the zero and margin lines to a table that draws them down its column', () => {
    render(
      <DiffChart
        title="t"
        estimate={-0.293}
        low={-0.371}
        high={-0.192}
        margin={0.1}
        scale={SCALE}
        tone="regressed"
        guides={false}
      />,
    );
    // Only the estimate is left: its line and the ring of page colour behind it.
    const lines = [...screen.getByRole('img').querySelectorAll('line')];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Number(line.getAttribute('x1'))).toBeCloseTo(scaleX(-0.293, SCALE));
    }
  });

  it('002 FR-002 colours the interval by verdict: red for regressed, green for improved, grey otherwise', () => {
    const classes = (['regressed', 'improved', 'neutral'] as const).map((tone) => {
      const { unmount } = render(
        <DiffChart
          title={tone}
          estimate={0}
          low={-0.1}
          high={0.1}
          margin={0.1}
          scale={SCALE}
          tone={tone}
        />,
      );
      const name = screen.getByRole('img').querySelector('rect')?.getAttribute('class') ?? '';
      unmount();
      return name;
    });
    expect(classes[0]).toContain('regressed');
    expect(classes[1]).toContain('improved');
    expect(classes[2]).toContain('neutral');
  });
});
