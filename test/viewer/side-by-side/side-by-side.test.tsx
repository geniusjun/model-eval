import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { Comparison } from '../../../src/report/schema.js';
import { SideBySide } from '../../../viewer/src/domains/side-by-side/SideBySide.js';
import { useHashParam } from '../../../viewer/src/hooks/useHashParam.js';
import en from '../../../viewer/src/i18n/en.json';
import { ReportPage } from '../../../viewer/src/pages/ReportPage.js';
import { resolveView } from '../../../viewer/src/utils/hash.js';
import { loadComparison, loadComparisonPage } from '../fixtures.js';
import { derivedComparison, REVIEW_RULE } from './payload.js';

afterEach(() => {
  window.location.hash = '';
});

interface SideFromHashProps {
  readonly comparison: Comparison;
}

/** The side-by-side view at the position the location hash names, resolved as the page does. */
function SideFromHash({ comparison }: SideFromHashProps) {
  const [hash] = useHashParam();
  const view = resolveView(hash.view, comparison);
  return (
    <SideBySide
      rules={comparison.rules}
      samples={comparison.samples}
      view={view.kind === 'side' ? view : undefined}
      variants={{
        baseline: comparison.baseline.variant.id,
        candidate: comparison.candidate.variant.id,
      }}
      lang="en"
    />
  );
}

function renderSide(comparison: Comparison = loadComparison('block')) {
  return render(<SideFromHash comparison={comparison} />);
}

function column(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

/** The texts shown as code text in a column, in order. */
function codeTexts(element: HTMLElement): string[] {
  return [...element.querySelectorAll('.text')].map((text) => text.textContent);
}

function label(key: keyof typeof en, params: Readonly<Record<string, string>>): string {
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    en[key],
  );
}

describe('002 SideBySide', () => {
  it('002 FR-005 the rule chooser lists the review rules and the rules with failing examples', () => {
    renderSide();
    const chooser = screen.getByRole('list', { name: en['side.rules'] });
    const names = within(chooser)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names).toEqual(['script-ja', REVIEW_RULE]);
    expect(screen.getByText(en['side.choose'])).toBeDefined();
  });

  it('002 FR-005 shows baseline and candidate raw and final with finalKind, keeping newlines', () => {
    window.location.hash = '#/side/script-ja/greet-ja/0';
    const comparison = loadComparison('block');
    renderSide(comparison);
    const candidate = column('Candidate (next)');
    expect(codeTexts(candidate)).toEqual([
      'こんにちは </script><!-- $& <img src=x onerror=alert(1)> ```js\nalert(1)\n``` 안녕',
      'こんにちは <b>ok</b> `` x `` $1',
    ]);
    expect(
      within(candidate).getByText(label('sample.raw', { finishReason: 'stop' })),
    ).toBeDefined();
    expect(
      within(candidate).getByText(label('sample.final', { finalKind: 'model' })),
    ).toBeDefined();
    const baseline = column('Baseline (current)');
    expect(codeTexts(baseline)).toEqual(['こんにちは。', 'こんにちは。']);
    // The two columns sit side by side: baseline first.
    expect(baseline.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  it('002 FR-005 shows the kind and message of an error sample in place of its text', () => {
    window.location.hash = `#/side/${REVIEW_RULE}/mood-vague-ko/0`;
    renderSide();
    const candidate = column('Candidate (next)');
    expect(within(candidate).getByText(label('sample.error', { kind: 'transient' }))).toBeDefined();
    expect(codeTexts(candidate)).toEqual(['429 rate limited <!-- $& -->']);
    expect(codeTexts(column('Baseline (current)'))).toEqual([
      '오늘 좀 그랬구나. 무슨 일 있었어?',
      '오늘 좀 그랬구나. 무슨 일 있었어?',
    ]);
  });

  it('002 FR-011 previous and next case and repeat are labelled buttons that work with the keyboard', async () => {
    const user = userEvent.setup();
    window.location.hash = `#/side/${REVIEW_RULE}/mood-busy-ko/0`;
    renderSide(derivedComparison());
    const button = (key: keyof typeof en) => screen.getByRole('button', { name: en[key] });
    expect(button('side.previousCase').getAttribute('aria-disabled')).toBe('true');
    expect(button('side.previousRepeat').getAttribute('aria-disabled')).toBe('true');
    button('side.nextRepeat').focus();
    await user.keyboard('{Enter}');
    expect(window.location.hash).toBe(`#/side/${REVIEW_RULE}/mood-busy-ko/1`);
    await waitFor(() => {
      expect(button('side.nextRepeat').getAttribute('aria-disabled')).toBe('true');
    });
    expect(document.activeElement).toBe(button('side.nextRepeat'));
    // The progress line is a live region, so a screen reader announces the move.
    const progress = screen.getByText('Case 1 of 2 · sample 2 of 2');
    expect(progress.getAttribute('aria-live')).toBe('polite');
    button('side.nextCase').focus();
    await user.keyboard(' ');
    expect(window.location.hash).toBe(`#/side/${REVIEW_RULE}/mood-vague-ko/0`);
    await waitFor(() => {
      expect(button('side.nextCase').getAttribute('aria-disabled')).toBe('true');
    });
    // A disabled move does nothing.
    await user.keyboard(' ');
    expect(window.location.hash).toBe(`#/side/${REVIEW_RULE}/mood-vague-ko/0`);
    expect(codeTexts(column('Candidate (next)'))).toEqual([
      'candidate mood-vague-ko 0',
      'candidate mood-vague-ko 0 final',
    ]);
  });

  it('002 FR-005 choosing a rule opens its first position and focuses it', async () => {
    const user = userEvent.setup();
    renderSide();
    await user.click(screen.getByRole('button', { name: REVIEW_RULE }));
    expect(window.location.hash).toBe(`#/side/${REVIEW_RULE}/mood-vague-ko/0`);
    const heading = await waitFor(() =>
      screen.getByRole('heading', { level: 3, name: /mood-vague-ko/ }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.getByRole('button', { name: REVIEW_RULE }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('002 ReportPage side by side', () => {
  it('002 FR-005 a failing example in the cell detail links to its side-by-side position', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/cell/script-ja/ja/raw';
    render(
      <ReportPage page={{ ...loadComparisonPage('page-comparison-block.json'), lang: 'en' }} />,
    );
    const link = screen.getByRole('link', { name: en['side.link'] });
    expect(link.getAttribute('href')).toBe('#/side/script-ja/greet-ja/0');
    await user.click(link);
    const region = screen.getByRole('region', { name: en['side.heading'] });
    const heading = await waitFor(() =>
      within(region).getByRole('heading', { level: 3, name: /greet-ja/ }),
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(screen.queryByRole('heading', { name: 'script-ja (ja, raw)' })).toBeNull();
  });

  it('002 FR-005 links each failing example of a cell to its own case and repeat, keeping ?lang=', () => {
    const page = {
      ...loadComparisonPage('page-comparison-block.json'),
      comparison: derivedComparison(),
      lang: 'en' as const,
    };
    const hrefs = () => screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    window.location.hash = '#/cell/script-ja/ja/final';
    const { unmount } = render(<ReportPage page={page} />);
    expect(hrefs()).toEqual(['#/side/script-ja/ask-ja/1', '#/side/script-ja/greet-ja/1']);
    unmount();
    window.location.hash = '#/cell/script-ja/ja/final?lang=ko';
    render(<ReportPage page={page} />);
    expect(hrefs()).toEqual([
      '#/side/script-ja/ask-ja/1?lang=ko',
      '#/side/script-ja/greet-ja/1?lang=ko',
    ]);
  });

  it('002 FR-005 places the side-by-side region after the grid and before the metrics', () => {
    render(
      <ReportPage page={{ ...loadComparisonPage('page-comparison-block.json'), lang: 'en' }} />,
    );
    const regions = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-labelledby'))
      .map((id) => (id === null ? '' : (document.getElementById(id)?.textContent ?? '')));
    const at = (name: string) => regions.indexOf(name);
    expect(at(en['side.heading'])).toBeGreaterThan(at(en['grid.heading']));
    expect(at(en['side.heading'])).toBeLessThan(at(en['metrics.heading']));
  });
});
