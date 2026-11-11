import { describe, expect, it } from 'vitest';

import type { CallRecord } from '../../../src/adapter/protocol.js';
import type { Price } from '../../../src/config/schema.js';
import {
  createCapLedger,
  budgetOverrunWarning,
  fitsCap,
  overrunUsd,
  reestimate,
} from '../../../src/run/cap.js';
import {
  attemptCharge,
  attemptReservation,
  billedCallsOfAttempt,
  closingCharge,
  callReservationUsd,
  conservativeEstimate,
  costProfiles,
  estimateLowAccuracyWarning,
  expectedEstimate,
  initialReservationState,
  inputTokenEstimate,
  lateCostLineUsd,
  observeAttempt,
  p95,
  previousRun,
  priceFor,
  pricingWarnings,
  refusesUnpricedVariant,
  reservationTokens,
  usageCharge,
  type CasePlan,
  type KeyedCostLine,
} from '../../../src/run/cost.js';
import { manifestSchema, type CostProfile, type Manifest } from '../../../src/run/manifest.js';
import type { AttemptLine, SendLine, TrialLine } from '../../../src/run/records.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };

// Prices of research R4: model-a is the baseline, model-b the candidate.
const MODEL_A: Price = { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 };
const MODEL_B: Price = { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 };
const MODEL_C: Price = { input: 1, output: 4 };
const PRICING = { 'model-a': MODEL_A, 'model-b': MODEL_B, 'model-c': MODEL_C };

const TOKENS = { input: 2000, output: 300 };

function profile(overrides: Partial<CostProfile> = {}): CostProfile {
  return {
    repeat0MeanUsd: 0.0003,
    repeatNMeanUsd: 0.0001,
    inputTokensMean: 4500,
    outputTokensMean: 50,
    outputTokensP95: 100,
    cacheHitRatio: 0.8,
    callsPerTrialP95: 1,
    callsPerAttemptMax: 1,
    ...overrides,
  };
}

function plans(count: number, lang: string, inputTokens = 4500, maxOutputTokens?: number) {
  return Array.from({ length: count }, (): CasePlan => ({
    lang,
    inputTokens,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }));
}

describe('price lookup', () => {
  it('001 FR-012 looks a model up by name, then by the name without a trailing date', () => {
    expect(priceFor(PRICING, 'model-a')).toEqual({ kind: 'priced', price: MODEL_A });
    expect(priceFor(PRICING, 'model-a-2026-10-01')).toEqual({ kind: 'priced', price: MODEL_A });
    expect(priceFor(PRICING, 'model-a-20261001')).toEqual({ kind: 'priced', price: MODEL_A });
    expect(priceFor(PRICING, 'model-a-2026').kind).toBe('unpriced');
    const dated = { ...PRICING, 'model-a-2026-10-01': MODEL_C };
    expect(priceFor(dated, 'model-a-2026-10-01')).toEqual({ kind: 'priced', price: MODEL_C });
  });

  it('001 FR-012 prices an unpriced model at the most expensive configured price per bucket', () => {
    expect(priceFor(PRICING, 'model-x')).toEqual({
      kind: 'unpriced',
      price: { input: 1, cachedInput: 0.02, cacheWrite: 0.25, output: 4 },
    });
    expect(priceFor({}, 'model-x')).toEqual({ kind: 'none' });
  });
});

describe('call cost', () => {
  it('001 FR-011 sums tokens times price per bucket, with reasoning inside output', () => {
    const usage = { input: 1000, cachedInput: 4000, cacheWrite: 500, output: 200 };
    const charge = usageCharge(usage, 'model-a', PRICING);
    expect(charge.costUsd).toBeCloseTo(0.0003025, 12);
    expect(charge.estimated).toBe(false);
    const withReasoning = usageCharge({ ...usage, reasoning: 150 }, 'model-a', PRICING);
    expect(withReasoning.costUsd).toBeCloseTo(0.0003025, 12);
  });

  it('001 FR-011 charges cache hits at input without a cachedInput price, raising cached-input-unpriced', () => {
    const charge = usageCharge({ input: 100, cachedInput: 1000, output: 10 }, 'model-c', PRICING);
    expect(charge.costUsd).toBeCloseTo(0.00114, 12);
    expect(charge.cachedInputUnpricedModels).toEqual(['model-c']);
    expect(
      usageCharge({ input: 100, output: 10 }, 'model-c', PRICING).cachedInputUnpricedModels,
    ).toEqual([]);
    expect(
      pricingWarnings({
        variantId: 'next',
        maxCostUsd: 1,
        unpricedModels: [],
        cachedInputUnpricedModels: ['model-c'],
      }),
    ).toEqual([
      { code: 'cached-input-unpriced', params: { models: ['model-c'] }, variants: ['next'] },
    ]);
  });

  it('001 FR-011 charges every non-hit input token at cacheWrite when the write amount is absent', () => {
    const charge = usageCharge({ input: 1000, cachedInput: 2000, output: 100 }, 'model-a', PRICING);
    expect(charge.costUsd).toBeCloseTo(0.000195, 12);
    const written = usageCharge(
      { input: 1000, cachedInput: 2000, cacheWrite: 0, output: 100 },
      'model-a',
      PRICING,
    );
    expect(written.costUsd).toBeCloseTo(0.00017, 12);
  });

  it('001 FR-012 without a cap charges unpriced calls at the most expensive price with unpriced-model', () => {
    const charge = usageCharge(
      { input: 1000, cachedInput: 1000, cacheWrite: 0, output: 100 },
      'model-x',
      PRICING,
    );
    expect(charge.costUsd).toBeCloseTo(0.00142, 12);
    expect(charge.estimated).toBe(true);
    expect(charge.unpricedModels).toEqual(['model-x']);
    const facts = {
      variantId: 'next',
      unpricedModels: ['model-x'],
      cachedInputUnpricedModels: [],
    };
    expect(pricingWarnings({ ...facts, maxCostUsd: null })).toEqual([
      { code: 'unpriced-model', params: { models: ['model-x'] }, variants: ['next'] },
    ]);
    // With a cap the call stops the run as a configuration error instead of warning.
    expect(pricingWarnings({ ...facts, maxCostUsd: 1 })).toEqual([]);
  });

  it('001 FR-012 refuses an unpriced variant model before the start only when a cap is set', () => {
    expect(refusesUnpricedVariant(PRICING, 'model-x', 1)).toBe(true);
    expect(refusesUnpricedVariant(PRICING, 'model-x', null)).toBe(false);
    expect(refusesUnpricedVariant(PRICING, 'model-a-2026-10-01', 1)).toBe(false);
  });

  it('001 FR-012 reserves null, never 0, without a cap and without any configured price', () => {
    const context = { pricing: {}, variantModel: 'model-x', tokens: TOKENS, billedCalls: 1 };
    expect(attemptReservation(context)).toEqual({
      costUsd: null,
      estimated: true,
      unpricedModels: [],
      cachedInputUnpricedModels: [],
    });
    const send: SendLine = {
      caseId: 'a',
      repeat: 0,
      attempt: 1,
      segment: 1,
      reservedUsd: null,
      sending: true,
    };
    expect(closingCharge(send)).toEqual({
      costUsd: null,
      estimated: true,
      unpricedModels: [],
      cachedInputUnpricedModels: [],
    });
    expect(closingCharge({ ...send, reservedUsd: 0.0016 }).costUsd).toBe(0.0016);
  });

  it('001 FR-012 gives a null cost, never 0, when no price is configured at all', () => {
    expect(usageCharge({ input: 10, output: 1 }, 'model-x', {}).costUsd).toBeNull();
    expect(
      attemptCharge(
        { answered: true, calls: [] },
        { pricing: {}, variantModel: 'model-x', tokens: TOKENS, billedCalls: 1 },
      ).costUsd,
    ).toBe(0);
  });
});

describe('attempt cost', () => {
  const context = { pricing: PRICING, variantModel: 'model-b', tokens: TOKENS, billedCalls: 2 };

  it('001 FR-011 prices each call by its own model and charges unknown amounts their reservation', () => {
    const calls: CallRecord[] = [
      {
        model: 'model-a',
        outcome: 'ok',
        usage: { input: 1000, cachedInput: 0, cacheWrite: 0, output: 100 },
      },
      { model: 'model-b', outcome: 'failed', errorKind: 'transient' },
      {
        model: 'model-b',
        outcome: 'failed',
        usage: { input: 500, cachedInput: 0, cacheWrite: 0, output: 0 },
      },
      { model: 'model-a', outcome: 'unanswered', errorKind: 'timeout' },
    ];
    const charge = attemptCharge({ answered: true, calls }, context);
    expect(charge.costUsd).toBeCloseTo(0.00065, 12);
    expect(charge.estimated).toBe(true);
    const okWithoutUsage = attemptCharge(
      { answered: true, calls: [{ model: 'model-a', outcome: 'ok' }] },
      context,
    );
    expect(okWithoutUsage.costUsd).toBeCloseTo(0.0004, 12);
    expect(okWithoutUsage.estimated).toBe(true);
  });

  it('001 FR-011 costs 0 for an empty calls array and prices usage without calls at the variant model', () => {
    expect(attemptCharge({ answered: true, calls: [] }, context)).toEqual({
      costUsd: 0,
      estimated: false,
      unpricedModels: [],
      cachedInputUnpricedModels: [],
    });
    const usage = { input: 1000, cachedInput: 0, cacheWrite: 0, output: 100 };
    expect(attemptCharge({ answered: true, usage }, context).costUsd).toBeCloseTo(0.00032, 12);
  });

  it('001 FR-011 charges the attempt reservation without usage and calls, and without an answer', () => {
    const reservation = attemptReservation(context);
    expect(reservation.costUsd).toBeCloseTo(0.00172, 12);
    expect(reservation.estimated).toBe(true);
    expect(attemptCharge({ answered: true }, context)).toEqual(reservation);
    expect(attemptCharge({ answered: false }, context)).toEqual(reservation);
  });

  it('001 FR-011 corrects an abandoned attempt to the larger of its late cost and the reservation', () => {
    const late = usageCharge(
      { input: 300, output: 900, cachedInput: 0, cacheWrite: 0 },
      'model-b',
      PRICING,
    );
    expect(lateCostLineUsd(late, 0.001)).toBeCloseTo(0.00014, 12);
    expect(lateCostLineUsd(late, 0.002)).toBe(0);
  });
});

describe('reservation', () => {
  it('001 FR-011 reserves input at max(input, cacheWrite) and output at the output limit (research R4)', () => {
    expect(callReservationUsd(MODEL_A, { input: 4500, output: 1024 })).toBeCloseTo(0.0010745, 12);
    expect(callReservationUsd(MODEL_B, { input: 4500, output: 1024 })).toBeCloseTo(0.0023538, 12);
    expect(callReservationUsd(MODEL_C, { input: 1000, output: 100 })).toBeCloseTo(0.0014, 12);
  });

  it('001 FR-011 takes the larger of the case estimate and the largest input per call seen', () => {
    const state = { ...initialReservationState(), maxInputPerCall: 3000, maxOutputPerCall: 800 };
    expect(reservationTokens(state, { inputTokens: 2500, maxOutputTokens: 1024 }, 600)).toEqual({
      input: 3000,
      output: 1024,
    });
    expect(reservationTokens(state, { inputTokens: 3500 }, 600)).toEqual({
      input: 3500,
      output: 800,
    });
    expect(reservationTokens(initialReservationState(), { inputTokens: 3500 }, 600)).toEqual({
      input: 3500,
      output: 600,
    });
  });

  const attemptBase = { caseId: 'a', repeat: 0, attempt: 1, segment: 1, seed: 1, costUsd: 0 };
  const okLine = (calls?: CallRecord[]): AttemptLine => ({
    ...attemptBase,
    status: 'ok',
    raw: 'x',
    answers: 1,
    finalKind: 'model',
    final: 'x',
    latencyMs: 1,
    finishReason: 'stop',
    ...(calls === undefined ? {} : { calls }),
  });
  const abandoned: AttemptLine = {
    ...attemptBase,
    status: 'error',
    error: { kind: 'adapter', message: 'no response', abandoned: 'timeout' },
  };
  const costLine = (source: 'late' | 'calls', calls: CallRecord[]): KeyedCostLine => ({
    caseId: 'a',
    repeat: 0,
    attempt: 1,
    segment: 1,
    source,
    costUsd: 0,
    calls,
    costCorrection: true,
  });
  const usage = { input: 10, output: 1 };

  it('001 FR-011 counts billed calls per attempt: ok, unanswered and failed with usage, cost lines included', () => {
    const calls: CallRecord[] = [
      { model: 'model-a', outcome: 'ok', usage },
      { model: 'model-a', outcome: 'unanswered' },
      { model: 'model-a', outcome: 'failed' },
      { model: 'model-a', outcome: 'failed', usage },
    ];
    expect(billedCallsOfAttempt(okLine(calls), [])).toBe(3);
    const side = costLine('calls', [{ model: 'model-a', outcome: 'ok', branch: 'side' }]);
    expect(billedCallsOfAttempt(okLine(calls), [side])).toBe(4);
    expect(billedCallsOfAttempt(okLine(), [])).toBe(1);
    expect(billedCallsOfAttempt(abandoned, [])).toBe(1);
    const late = costLine('late', [
      { model: 'model-a', outcome: 'ok', usage },
      { model: 'model-a', outcome: 'ok', usage },
    ]);
    expect(billedCallsOfAttempt(abandoned, [late])).toBe(2);
  });

  it('001 FR-011 counts no billed call for a stopped attempt that never reached the adapter', () => {
    const neverSent: AttemptLine = { ...attemptBase, status: 'stopped', costUsd: 0, calls: [] };
    const closed: AttemptLine = { ...attemptBase, status: 'stopped', costEstimated: true };
    expect(billedCallsOfAttempt(neverSent, [])).toBe(0);
    expect(billedCallsOfAttempt(closed, [])).toBe(1);
  });

  it('001 FR-011 keeps the largest billed calls per attempt per language, from the previous run, never below 1', () => {
    const start = initialReservationState({ ko: profile({ callsPerAttemptMax: 3 }) });
    expect(start.maxBilledCalls).toEqual({ ko: 3 });
    const unbilled = okLine([
      { model: 'model-a', outcome: 'failed' },
      { model: 'model-a', outcome: 'failed' },
    ]);
    const afterUnbilled = observeAttempt(initialReservationState(), 'en', unbilled, []);
    expect(afterUnbilled.maxBilledCalls).toEqual({ en: 1 });
    const many = okLine([
      { model: 'model-a', outcome: 'ok', usage: { input: 100, cachedInput: 4000, output: 60 } },
      { model: 'model-a', outcome: 'ok', usage: { input: 10, output: 900 } },
    ]);
    const grown = observeAttempt(start, 'ko', many, []);
    expect(grown.maxBilledCalls).toEqual({ ko: 3 });
    expect(grown.maxInputPerCall).toBe(4100);
    expect(grown.maxOutputPerCall).toBe(900);
    const more = observeAttempt(
      grown,
      'ko',
      okLine([...(many.calls ?? []), ...(many.calls ?? [])]),
      [],
    );
    expect(more.maxBilledCalls).toEqual({ ko: 4 });
  });
});

describe('input token estimate', () => {
  it('001 SC-005 uses the render inputTokens when given', () => {
    const render = { messages: [{ role: 'user', content: 'hi' }], inputTokens: 4120 };
    expect(inputTokenEstimate(render, undefined)).toEqual({
      ok: true,
      tokens: 4120,
      lowAccuracy: false,
    });
  });

  it('001 SC-005 counts Hangul, kana and Han as 1 token and every other character as 0.3', () => {
    const render = {
      messages: [
        { role: 'system', content: 'Hello world' },
        { role: 'user', content: '안녕하세요こんにちは漢字' },
      ],
    };
    // 11 × 0.3 + 12 = 15.3, rounded up.
    expect(inputTokenEstimate(render, undefined)).toEqual({
      ok: true,
      tokens: 16,
      lowAccuracy: false,
    });
    expect(
      inputTokenEstimate({ messages: [{ role: 'user', content: 'abcdefghij' }] }, undefined),
    ).toEqual({ ok: true, tokens: 3, lowAccuracy: false });
  });

  it('001 SC-005 uses estimate.inputTokens without a render, marked low accuracy', () => {
    expect(inputTokenEstimate(undefined, 3000)).toEqual({
      ok: true,
      tokens: 3000,
      lowAccuracy: true,
    });
    expect(estimateLowAccuracyWarning('next', 3000)).toEqual({
      code: 'estimate-low-accuracy',
      params: { inputTokens: 3000 },
      variants: ['next'],
    });
  });

  it('001 SC-005 takes the larger of the count and estimate.inputTokens for a stored-prompt reference', () => {
    const render = {
      messages: [
        { role: 'prompt', content: '{"id":"pmpt_1"}' },
        { role: 'user', content: 'hello there' },
      ],
    };
    expect(inputTokenEstimate(render, 3000)).toEqual({ ok: true, tokens: 3000, lowAccuracy: true });
    // 26 characters × 0.3 = 7.8, rounded up.
    expect(inputTokenEstimate(render, 2)).toEqual({ ok: true, tokens: 8, lowAccuracy: true });
  });

  it('001 FR-011 cannot estimate without estimate.inputTokens when the render gives no count', () => {
    expect(inputTokenEstimate(undefined, undefined)).toEqual({ ok: false });
    const stored = { messages: [{ role: 'prompt', content: '{"id":"pmpt_1"}' }] };
    expect(inputTokenEstimate(stored, undefined)).toEqual({ ok: false });
  });
});

describe('estimates', () => {
  it('001 SC-007 gives the research R4 expected estimate of a first run (structure basis)', () => {
    const baseline = expectedEstimate({
      cases: plans(90, 'ko'),
      repeats: 5,
      outputTokens: 600,
      price: MODEL_A,
    });
    expect(baseline.usd).toBeCloseTo(0.201825, 9);
    expect(baseline.basis).toEqual({ ko: 'structure' });
    expect(baseline.perTrial.ko?.repeat0).toBeCloseTo(0.0008625, 12);
    expect(baseline.perTrial.ko?.repeatN).toBeCloseTo(0.000345, 12);
    const candidate = expectedEstimate({
      cases: plans(90, 'ko'),
      repeats: 5,
      outputTokens: 600,
      price: MODEL_B,
    });
    expect(candidate.usd).toBeCloseTo(0.45765, 9);
  });

  it('001 SC-007 uses the render output limit when it is smaller than estimate.outputTokens', () => {
    const estimate = expectedEstimate({
      cases: plans(90, 'ko', 4500, 150),
      repeats: 5,
      outputTokens: 600,
      price: MODEL_B,
    });
    expect(estimate.usd).toBeCloseTo(0.21465, 9);
  });

  it('001 SC-005 multiplies the previous run cost profile by the trial counts (history basis)', () => {
    const estimate = expectedEstimate({
      cases: [...plans(10, 'ko'), ...plans(2, 'en')],
      repeats: 5,
      outputTokens: 600,
      price: MODEL_A,
      previous: { ko: profile() },
    });
    expect(estimate.basis).toEqual({ ko: 'history', en: 'structure' });
    // ko: 10 × (0.0003 + 4 × 0.0001); en: 2 × (0.0008625 + 4 × 0.000345).
    expect(estimate.usd).toBeCloseTo(0.007 + 0.004485, 9);
  });

  it('001 FR-011 gives a null expected estimate when no price is configured', () => {
    expect(
      expectedEstimate({ cases: plans(1, 'ko'), repeats: 1, outputTokens: 600, price: undefined })
        .usd,
    ).toBeNull();
  });

  it('001 FR-011 gives the research R4 conservative estimates', () => {
    const input = { cases: plans(90, 'ko'), repeats: 5, outputTokens: 600 };
    expect(conservativeEstimate({ ...input, price: MODEL_A })).toBeCloseTo(0.388125, 9);
    expect(conservativeEstimate({ ...input, price: MODEL_B })).toBeCloseTo(0.83025, 9);
    const previous = { ko: profile({ outputTokensP95: 100 }) };
    expect(conservativeEstimate({ ...input, price: MODEL_A, previous })).toBeCloseTo(0.275625, 9);
    const twoCalls = { ko: profile({ outputTokensP95: 100, callsPerTrialP95: 2 }) };
    expect(conservativeEstimate({ ...input, price: MODEL_A, previous: twoCalls })).toBeCloseTo(
      0.52875,
      9,
    );
  });

  it('001 SC-005 takes the latest complete run of the same variant with 2+ repeats and no case filter', () => {
    const base: Manifest = manifestSchema.parse(manifestFixture);
    const run = (startedAt: string, overrides: Partial<Manifest> = {}): Manifest => ({
      ...base,
      status: 'complete',
      tool: { ...base.tool, startedAt },
      ...overrides,
    });
    const older = run('2026-11-01T10:00:00.000Z');
    const latest = run('2026-11-03T10:00:00.000Z');
    const candidates = [
      older,
      latest,
      run('2026-11-04T10:00:00.000Z', { status: 'partial' }),
      run('2026-11-05T10:00:00.000Z', { sampling: { ...base.sampling, repeats: 1 } }),
      run('2026-11-06T10:00:00.000Z', { sampling: { ...base.sampling, cases: 'greet-*' } }),
      run('2026-11-07T10:00:00.000Z', {
        variant: { ...base.variant, fingerprint: `sha256:${'0'.repeat(64)}` },
      }),
    ];
    expect(previousRun(candidates, base.variant.fingerprint)).toBe(latest);
    expect(previousRun([], base.variant.fingerprint)).toBeUndefined();
  });
});

describe('p95', () => {
  it('001 SC-007 takes the nearest-rank 95th percentile', () => {
    expect(p95([3, 1, 2])).toBe(3);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(p95(twenty)).toBe(19);
    expect(p95([...twenty, 21])).toBe(20);
    expect(p95([])).toBe(0);
  });
});

describe('cost profile', () => {
  const ok = (
    caseId: string,
    repeat: number,
    attempt: number,
    costUsd: number,
    usage: AttemptLine['usage'],
  ): AttemptLine => ({
    caseId,
    repeat,
    attempt,
    segment: 1,
    seed: 1,
    costUsd,
    ...(usage === undefined ? {} : { usage }),
    calls: [{ model: 'model-b', outcome: 'ok' }],
    status: 'ok',
    raw: 'x',
    answers: 1,
    finalKind: 'model',
    final: 'x',
    latencyMs: 1,
    finishReason: 'stop',
  });
  const transient = (caseId: string, repeat: number, attempt: number): AttemptLine => ({
    caseId,
    repeat,
    attempt,
    segment: 1,
    seed: 1,
    costUsd: 0,
    calls: [{ model: 'model-b', outcome: 'failed', errorKind: 'transient' }],
    status: 'error',
    error: { kind: 'transient', message: '429' },
  });
  const lines: TrialLine[] = [
    { caseId: 'a', repeat: 0, attempt: 1, segment: 1, reservedUsd: 0.002, sending: true },
    ok('a', 0, 1, 0.0004, { input: 100, cachedInput: 0, cacheWrite: 4000, output: 50 }),
    ok('a', 1, 1, 0.0001, { input: 100, cachedInput: 4000, cacheWrite: 0, output: 30 }),
    {
      caseId: 'a',
      repeat: 1,
      attempt: 1,
      segment: 1,
      source: 'calls',
      costUsd: 0.00002,
      usage: { input: 900, output: 40 },
      calls: [{ model: 'model-b', outcome: 'ok', branch: 'side' }],
      costCorrection: true,
    },
    transient('b', 0, 1),
    ok('b', 0, 2, 0.0005, { input: 200, cachedInput: 0, cacheWrite: 4000, output: 70 }),
    transient('b', 1, 1),
    {
      segment: 1,
      source: 'calls',
      costUsd: 0.00003,
      usage: { input: 300, output: 0 },
      calls: [{ model: 'model-b', outcome: 'ok', branch: 'side' }],
      costCorrection: true,
    },
  ];

  it('001 SC-007 averages finished keys per language and repeat group, spreading unkeyed calls', () => {
    const profiles = costProfiles(lines, () => 'ko', 2);
    const ko = profiles.ko;
    if (ko === undefined) {
      throw new Error('expected a ko profile');
    }
    expect(Object.keys(profiles)).toEqual(['ko']);
    // Key b:1 still has retries left, so it is not finished and stays out.
    expect(ko.repeat0MeanUsd).toBeCloseTo((0.00041 + 0.00051) / 2, 12);
    expect(ko.repeatNMeanUsd).toBeCloseTo(0.00013, 12);
    expect(ko.inputTokensMean).toBeCloseTo((4200 + 5100 + 4300) / 3, 9);
    expect(ko.outputTokensMean).toBeCloseTo(190 / 3, 9);
    expect(ko.outputTokensP95).toBe(70);
    expect(ko.cacheHitRatio).toBeCloseTo(4000 / 13300, 12);
    expect(ko.callsPerTrialP95).toBeCloseTo(2 + 1 / 3, 12);
    expect(ko.callsPerAttemptMax).toBe(2);
  });

  it('001 SC-007 keeps call counts at least 1 and the cache hit ratio null without input tokens', () => {
    const unbilled: AttemptLine = {
      caseId: 'c',
      repeat: 0,
      attempt: 1,
      segment: 1,
      seed: 1,
      costUsd: 0,
      calls: [{ model: 'model-b', outcome: 'failed' }],
      status: 'error',
      error: { kind: 'permanent', message: '400' },
    };
    const profiles = costProfiles([unbilled], () => 'en', 2);
    expect(profiles.en).toMatchObject({
      repeat0MeanUsd: 0,
      repeatNMeanUsd: null,
      cacheHitRatio: null,
      callsPerTrialP95: 1,
      callsPerAttemptMax: 1,
    });
  });
});

describe('cap check', () => {
  it('001 FR-011 sends only if spent + in-flight reservations + this reservation stay within the cap', () => {
    const check = { spentUsd: 0.5, inFlightUsd: 0.25, maxCostUsd: 1 };
    expect(fitsCap({ ...check, reservationUsd: 0.25 })).toBe(true);
    expect(fitsCap({ ...check, reservationUsd: 0.375 })).toBe(false);
    expect(fitsCap({ ...check, reservationUsd: 10, maxCostUsd: null })).toBe(true);
  });

  it('001 FR-011 checks before every attempt, tool retries included, over earlier spend', () => {
    const ledger = createCapLedger(1, 0.5);
    const first = ledger.trySend(0.25);
    const second = ledger.trySend(0.25);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(ledger.inFlightUsd).toBe(0.5);
    expect(ledger.trySend(0.125)).toBeUndefined();
    first?.settle(0.125);
    expect(ledger.spentUsd).toBe(0.625);
    expect(ledger.inFlightUsd).toBe(0.25);
    // The retry of the first attempt needs its own reservation.
    const retry = ledger.trySend(0.125);
    expect(retry).toBeDefined();
    expect(ledger.trySend(0.125)).toBeUndefined();
    // An attempt that ended without an answer is in spent at its reservation, once.
    second?.settle(0.25);
    expect(ledger.spentUsd).toBe(0.875);
    expect(ledger.inFlightUsd).toBe(0.125);
    ledger.charge(0.0625);
    expect(ledger.spentUsd).toBe(0.9375);
  });

  it('001 FR-011 never refuses without a cap, also a null reservation of unknown price', () => {
    const ledger = createCapLedger(null, 0);
    expect(ledger.trySend(1000)).toBeDefined();
    const unknown = ledger.trySend(null);
    expect(unknown?.reservedUsd).toBeNull();
    unknown?.settle(null);
    expect(ledger.spentUsd).toBeNull();
  });

  it('001 FR-011 refuses a null reservation under a cap, since it cannot be checked', () => {
    expect(createCapLedger(1, 0).trySend(null)).toBeUndefined();
  });

  it('001 FR-011 re-estimates spent + remaining trials × measured mean, expected per trial before the first batch', () => {
    const total = reestimate(0.1, [
      {
        firstBatchFinished: true,
        measured: { ko: { repeat0MeanUsd: 0.001, repeatNMeanUsd: 0.0004 } },
        expected: { ko: { repeat0: 0.5, repeatN: 0.5 } },
        remaining: { ko: { repeat0: 10, repeatN: 40 } },
      },
      {
        firstBatchFinished: false,
        measured: { ko: { repeat0MeanUsd: 0.5, repeatNMeanUsd: 0.5 } },
        expected: { ko: { repeat0: 0.002, repeatN: 0.001 } },
        remaining: { ko: { repeat0: 20, repeatN: 80 } },
      },
    ]);
    expect(total).toBeCloseTo(0.246, 12);
  });

  it('001 FR-011 falls back to the expected value per trial for a group nothing measured yet', () => {
    const total = reestimate(0, [
      {
        firstBatchFinished: true,
        measured: { ko: { repeat0MeanUsd: 0.001, repeatNMeanUsd: null } },
        expected: { ko: { repeat0: 0.002, repeatN: 0.0005 } },
        remaining: { ko: { repeat0: 0, repeatN: 10 } },
      },
    ]);
    expect(total).toBeCloseTo(0.005, 12);
  });

  it('001 FR-011 records spend above reservations as overrun and raises budget-overrun', () => {
    const send = (
      caseId: string,
      repeat: number,
      reservedUsd: number | null = 0.001,
    ): TrialLine => ({
      caseId,
      repeat,
      attempt: 1,
      segment: 1,
      reservedUsd,
      sending: true,
    });
    const attempt = (caseId: string, repeat: number, costUsd: number | null): TrialLine => ({
      caseId,
      repeat,
      attempt: 1,
      segment: 1,
      seed: 1,
      costUsd,
      status: 'stopped',
    });
    const overrun = overrunUsd([
      send('a', 0),
      attempt('a', 0, 0.0012),
      send('a', 1),
      attempt('a', 1, 0.0004),
      send('b', 0),
      attempt('b', 0, 0.001),
      {
        caseId: 'b',
        repeat: 0,
        attempt: 1,
        segment: 1,
        source: 'late',
        costUsd: 0.0003,
        costCorrection: true,
      },
      { segment: 1, source: 'calls', costUsd: 0.00005, calls: [], costCorrection: true },
    ]);
    const unpriced = overrunUsd([send('c', 0, null), attempt('c', 0, null)]);
    expect(unpriced).toBe(0);
    expect(overrun).toBeCloseTo(0.00055, 12);
    expect(budgetOverrunWarning('next', overrun)).toEqual({
      code: 'budget-overrun',
      params: { overrunUsd: { next: overrun } },
      variants: ['next'],
    });
    expect(budgetOverrunWarning('next', 0)).toBeUndefined();
  });
});
