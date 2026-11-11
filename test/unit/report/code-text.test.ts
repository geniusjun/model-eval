import { describe, expect, it } from 'vitest';

import { message } from '../../../src/messages/index.js';
import { neededText, warningText } from '../../../src/report/code-text.js';

describe('trials-needed text', () => {
  it('001 FR-024 states the repeats, the cell trials now and after, and the whole run', () => {
    const needed = {
      kind: 'repeats',
      repeats: 20,
      cellTrials: 600,
      trialsPerVariant: 800,
      nearMargin: false,
    } as const;
    expect(neededText('en', needed, 150)).toBe(
      'a new run with 20 repeats gives this cell 600 trials per variant (now 150) and the whole run 800 trials per variant; about 80% chance of a verdict (estimate)',
    );
    expect(neededText('ko', needed, 150)).toBe(
      '반복 20회로 다시 돌리면 이 셀은 변형마다 trial 600개(지금 150개), 전체 실행은 변형마다 800개가 됩니다. 판정이 날 확률은 약 80%입니다(추정)',
    );
  });

  it('001 FR-024 adds the near-margin text and has one text for cases and on-margin', () => {
    expect(
      neededText(
        'en',
        { kind: 'repeats', repeats: 60, cellTrials: 360, trialsPerVariant: 600, nearMargin: true },
        24,
      ),
    ).toBe(
      'a new run with 60 repeats gives this cell 360 trials per variant (now 24) and the whole run 600 trials per variant; about 80% chance of a verdict (estimate); near the margin, repeats are unlikely to settle it',
    );
    expect(neededText('en', { kind: 'cases', cases: 455 }, 150)).toBe(
      'repeats cannot settle it; about 455 cases are needed',
    );
    expect(neededText('en', { kind: 'on-margin' }, 150)).toBe(
      'exactly on the margin, repeats are unlikely to settle it',
    );
  });
});

describe('warning text', () => {
  const quote = (text: string): string => JSON.stringify(text);
  const abandoned = (
    trials: Readonly<Record<string, { timeout: number; restart: number }>>,
    lateFailures: Readonly<
      Record<string, Record<string, { trials: number; maxRetryAfterMs: number | null }>>
    >,
  ) =>
    ({
      code: 'abandoned-trials',
      variants: Object.keys(trials),
      params: {
        trials,
        timeoutMs: Object.fromEntries(Object.keys(trials).map((id) => [id, 120000])),
        lateFailures,
      },
    }) as const;

  it('001 FR-008 states only the restarts when no trial was abandoned at the time limit', () => {
    const text = warningText(
      'en',
      abandoned({ next: { timeout: 0, restart: 2 } }, { next: {} }),
      quote,
    );
    expect(text).toBe(
      message('en', 'warning.abandoned-trials.restarts', { trials: 'next (timeout 0, restart 2)' }),
    );
    expect(text).not.toContain('120000');
    expect(text).not.toContain('—');
  });

  it('001 FR-008 leaves variants without late failures out of the late failures', () => {
    const text = warningText(
      'en',
      abandoned(
        { current: { timeout: 1, restart: 0 }, next: { timeout: 2, restart: 0 } },
        { current: {}, next: { transient: { trials: 1, maxRetryAfterMs: 2000 } } },
      ),
      quote,
    );
    expect(text).not.toContain('(—)');
    expect(text).toContain(
      'Failed calls in late responses: next (transient (trials 1, maxRetryAfterMs 2000)).',
    );
  });

  it('001 FR-023 keeps empty per-variant values in other warnings', () => {
    const text = warningText(
      'en',
      {
        code: 'response-model-changed',
        variants: ['current'],
        params: { models: { current: [], next: ['m-1'] } },
      },
      quote,
    );
    expect(text).toContain('current (—), next ("m-1")');
  });
});
