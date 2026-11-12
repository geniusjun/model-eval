import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Comparison } from '../../../src/report/schema.js';
import {
  samplePositions,
  sampleCursor,
  useSampleCursor,
} from '../../../viewer/src/domains/side-by-side/useSampleCursor.js';
import { useHashParam } from '../../../viewer/src/hooks/useHashParam.js';
import { resolveView } from '../../../viewer/src/utils/hash.js';
import { answer, derivedComparison, FAILING_RULE, REVIEW_RULE } from './payload.js';

afterEach(() => {
  window.location.hash = '';
});

describe('002 samplePositions', () => {
  it('002 FR-005 a review rule steps through the (case, repeat) pairs of its review keys, by case then repeat', () => {
    expect(samplePositions(derivedComparison().samples, REVIEW_RULE)).toEqual([
      { caseId: 'mood-busy-ko', repeat: 0 },
      { caseId: 'mood-busy-ko', repeat: 1 },
      { caseId: 'mood-vague-ko', repeat: 0 },
      { caseId: 'mood-vague-ko', repeat: 1 },
    ]);
  });

  it('002 FR-005 a rule with failing examples steps through its failing pairs merged across its cells, each once', () => {
    expect(samplePositions(derivedComparison().samples, FAILING_RULE)).toEqual([
      { caseId: 'ask-ja', repeat: 0 },
      { caseId: 'ask-ja', repeat: 1 },
      { caseId: 'greet-ja', repeat: 0 },
      { caseId: 'greet-ja', repeat: 1 },
    ]);
  });

  it('002 FR-005 a rule without samples has no position', () => {
    expect(samplePositions(derivedComparison().samples, 'no-emoji')).toEqual([]);
  });
});

describe('002 sampleCursor', () => {
  it('002 FR-015 pairs each failing example with the baseline text of the same case and repeat', () => {
    const { samples } = derivedComparison();
    const positions = samplePositions(samples, FAILING_RULE);
    expect(positions).toHaveLength(4);
    for (const { caseId, repeat } of positions) {
      const cursor = sampleCursor(samples, { kind: 'side', ruleId: FAILING_RULE, caseId, repeat });
      expect(cursor?.baseline).toEqual(answer({ variant: 'baseline', caseId, repeat }));
      expect(cursor?.candidate).toEqual(answer({ variant: 'candidate', caseId, repeat }));
    }
  });

  it('002 FR-005 next and previous case and repeat stop at the ends', () => {
    const { samples } = derivedComparison();
    const first = sampleCursor(samples, {
      kind: 'side',
      ruleId: REVIEW_RULE,
      caseId: 'mood-busy-ko',
      repeat: 0,
    });
    expect(first).toMatchObject({
      caseNumber: 1,
      caseCount: 2,
      repeatNumber: 1,
      repeatCount: 2,
      previousCase: undefined,
      previousRepeat: undefined,
      nextRepeat: { caseId: 'mood-busy-ko', repeat: 1 },
      nextCase: { caseId: 'mood-vague-ko', repeat: 0 },
    });
    const last = sampleCursor(samples, {
      kind: 'side',
      ruleId: REVIEW_RULE,
      caseId: 'mood-vague-ko',
      repeat: 1,
    });
    expect(last).toMatchObject({
      caseNumber: 2,
      repeatNumber: 2,
      previousCase: { caseId: 'mood-busy-ko', repeat: 0 },
      previousRepeat: { caseId: 'mood-vague-ko', repeat: 0 },
      nextRepeat: undefined,
      nextCase: undefined,
    });
  });

  it('002 FR-005 repeats stop at the first and last repeat of each case, not only of the rule', () => {
    const { samples } = derivedComparison();
    const at = (caseId: string, repeat: number) =>
      sampleCursor(samples, { kind: 'side', ruleId: REVIEW_RULE, caseId, repeat });
    expect(at('mood-vague-ko', 0)).toMatchObject({
      previousRepeat: undefined,
      nextRepeat: { caseId: 'mood-vague-ko', repeat: 1 },
      previousCase: { caseId: 'mood-busy-ko', repeat: 0 },
    });
    expect(at('mood-busy-ko', 1)).toMatchObject({
      previousRepeat: { caseId: 'mood-busy-ko', repeat: 0 },
      nextRepeat: undefined,
      nextCase: { caseId: 'mood-vague-ko', repeat: 0 },
    });
  });

  it('002 FR-005 has no cursor for a position the rule does not have', () => {
    const { samples } = derivedComparison();
    expect(
      sampleCursor(samples, { kind: 'side', ruleId: REVIEW_RULE, caseId: 'greet-ja', repeat: 0 }),
    ).toBeUndefined();
  });
});

describe('002 useSampleCursor', () => {
  function renderCursor(comparison: Comparison) {
    return renderHook(() => {
      const [hash] = useHashParam();
      const view = resolveView(hash.view, comparison);
      return useSampleCursor(comparison.samples, view.kind === 'side' ? view : undefined);
    });
  }

  it('002 FR-005 #/side/<ruleId>/<caseId>/<repeat> selects the position', () => {
    window.location.hash = `#/side/${REVIEW_RULE}/mood-vague-ko/1`;
    const { result } = renderCursor(derivedComparison());
    expect(result.current.cursor?.ruleId).toBe(REVIEW_RULE);
    expect(result.current.cursor?.position).toEqual({ caseId: 'mood-vague-ko', repeat: 1 });
  });

  it('002 FR-005 an unknown position resolves to the summary, with no cursor', () => {
    window.location.hash = `#/side/${REVIEW_RULE}/mood-vague-ko/7`;
    const { result } = renderCursor(derivedComparison());
    expect(result.current.cursor).toBeUndefined();
  });

  it('002 FR-005 moving writes the position into the hash, keeping ?lang=', () => {
    window.location.hash = `#/side/${REVIEW_RULE}/mood-busy-ko/0?lang=ko`;
    const { result } = renderCursor(derivedComparison());
    const next = result.current.cursor?.nextCase;
    if (next === undefined) {
      throw new Error('the first case has no next case');
    }
    act(() => {
      result.current.go(next);
    });
    expect(window.location.hash).toBe(`#/side/${REVIEW_RULE}/mood-vague-ko/0?lang=ko`);
  });

  it('002 FR-005 choosing a rule opens its first position', () => {
    const { result } = renderCursor(derivedComparison());
    expect(result.current.cursor).toBeUndefined();
    act(() => {
      result.current.chooseRule(FAILING_RULE);
    });
    expect(window.location.hash).toBe(`#/side/${FAILING_RULE}/ask-ja/0`);
  });
});
