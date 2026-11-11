import { describe, expect, it } from 'vitest';

import { finishedTrials } from '../../../src/compare/finished.js';
import { comparisonOps, metricRate, reviewOps, type OpsRun } from '../../../src/compare/ops.js';
import { createRedactor } from '../../../src/report/redact.js';
import { reportConfigSchema } from '../../../src/config/schema.js';
import { variantOpsSchema, type VariantOps } from '../../../src/report/schema.js';
import {
  keyedCostLineSchema,
  unkeyedCostLineSchema,
  type AttemptLine,
  type TrialLine,
} from '../../../src/run/records.js';
import { warningSchema } from '../../../src/run/warning.js';
import { zValues } from '../../../src/stats/interval.js';
import { wilson } from '../../../src/stats/wilson.js';
import { errorLine, okLine, stoppedLine } from '../grade/lines.js';

const Z_L = zValues(0.95, 0).zLower;
const WARN = reportConfigSchema.parse({}).warn;
const VARIANTS = { baseline: 'current', candidate: 'next' };

/** A run whose lines are all finished; systematic failures are given separately. */
function run(lines: readonly TrialLine[], systematic: readonly AttemptLine[] = []): OpsRun {
  const caseIds = new Set(lines.flatMap((line) => ('caseId' in line ? [line.caseId] : [])));
  return { lines, finished: finishedTrials(lines, 0, caseIds), systematic };
}

const at = (repeat: number) => ({ caseId: 'c', repeat });
const empty = run([]);

function opsOf(baseline: OpsRun, candidate: OpsRun = empty) {
  const ops = comparisonOps({ baseline, candidate }, Z_L, createRedactor([]));
  expect(variantOpsSchema.parse(ops.baseline)).toEqual(ops.baseline);
  expect(variantOpsSchema.parse(ops.candidate)).toEqual(ops.candidate);
  return ops;
}

describe('metric rates', () => {
  const lines = [
    okLine(at(0)),
    errorLine('permanent', at(1)),
    errorLine('timeout', at(2)),
    okLine({ ...at(3), finalKind: 'discarded', final: undefined, discardReason: 'Cut: mid' }),
    okLine({ ...at(4), finalKind: 'fallback', final: 'sorry', finishReason: 'length' }),
    okLine({ ...at(5), raw: ' ', answers: 1 }),
    okLine({ ...at(6), raw: '', answers: 2, final: 'hi' }),
    errorLine('transient', at(7)),
    errorLine('adapter', at(8)),
    errorLine('config', at(9)),
  ];

  it('001 FR-023 rejection, time-out, discard, fallback, empty and regeneration divide by trials graded on completed', () => {
    const { rates } = opsOf(run(lines)).baseline;
    const ofGraded = (count: number) => metricRate(count, 7, Z_L);
    expect(rates.rejection).toEqual(ofGraded(1));
    expect(rates.timeout).toEqual(ofGraded(1));
    expect(rates.discard).toEqual(ofGraded(1));
    expect(rates.fallback).toEqual(ofGraded(1));
    expect(rates.empty).toEqual(ofGraded(2));
    expect(rates.regeneration).toEqual(ofGraded(1));
  });

  it('001 FR-023 transient and adapter error rates divide by all finished trials', () => {
    const { rates } = opsOf(run(lines)).baseline;
    expect(rates.transient).toEqual(metricRate(1, 10, Z_L));
    expect(rates.adapter).toEqual(metricRate(1, 10, Z_L));
  });

  it('001 FR-009 systematic failures enter the completed denominators and stay in the error numerators', () => {
    const transient = lines[7];
    if (transient === undefined) {
      throw new Error('missing line');
    }
    const ops = opsOf(run(lines, [transient])).baseline;
    expect(ops.rates.rejection.total).toBe(8);
    expect(ops.rates.transient).toEqual(metricRate(1, 10, Z_L));
    expect(ops.systematic).toEqual({ trials: 1, cases: 1 });
  });

  it('001 FR-023 each rate carries the Wilson interval at z_L, and null statistics without trials', () => {
    const { low, high } = wilson(1, 7, Z_L);
    expect(metricRate(1, 7, Z_L)).toEqual({ count: 1, total: 7, rate: 1 / 7, low, high });
    expect(metricRate(0, 0, Z_L)).toEqual({
      count: 0,
      total: 0,
      rate: null,
      low: null,
      high: null,
    });
    expect(opsOf(empty).baseline.rates.discard.rate).toBeNull();
  });

  it('001 FR-023 finish reasons count the graded ok trials', () => {
    expect(opsOf(run(lines)).baseline.finishReasons).toEqual({
      stop: 4,
      length: 1,
      content_filter: 0,
      other: 0,
    });
  });
});

describe('metric details', () => {
  it('001 FR-023 discard reasons by frequency', () => {
    const discarded = (repeat: number, discardReason?: string) =>
      okLine({ ...at(repeat), finalKind: 'discarded', final: undefined, discardReason });
    const ops = opsOf(run([discarded(0, 'B'), discarded(1, 'A'), discarded(2, 'A'), discarded(3)]));
    expect(ops.baseline.discardReasons).toEqual([
      { discardReason: 'A', count: 2 },
      { discardReason: 'B', count: 1 },
    ]);
  });

  it('001 FR-023 the top 3 messages per error kind by frequency', () => {
    const failed = (repeat: number, kind: 'transient' | 'timeout', message: string) =>
      errorLine(kind, { ...at(repeat), attempt: 3, error: { kind, message } });
    const ops = opsOf(
      run([
        failed(0, 'transient', 'd'),
        failed(1, 'transient', 'a'),
        failed(2, 'transient', 'b'),
        failed(3, 'transient', 'a'),
        failed(4, 'transient', 'c'),
        failed(5, 'timeout', 'slow'),
      ]),
    );
    expect(ops.baseline.topMessages).toEqual([
      { kind: 'transient', message: 'a', count: 2 },
      { kind: 'transient', message: 'b', count: 1 },
      { kind: 'transient', message: 'c', count: 1 },
      { kind: 'timeout', message: 'slow', count: 1 },
    ]);
  });

  it('001 FR-023 side-call failures per kind, abandoned trials per cause and response snapshots', () => {
    const calls = [
      { model: 'm', outcome: 'ok', branch: 'answer' },
      { model: 'm', outcome: 'failed', errorKind: 'transient', branch: 'side' },
      { model: 'm', outcome: 'unanswered', errorKind: 'timeout', branch: 'side' },
      { model: 'm', outcome: 'failed', errorKind: 'transient' },
    ];
    const abandoned = (repeat: number, cause: 'timeout' | 'restart') =>
      errorLine('adapter', {
        ...at(repeat),
        error: { kind: 'adapter', message: 'no answer', abandoned: cause },
      });
    const ops = opsOf(
      run([
        okLine({ ...at(0), calls, modelSnapshot: 'm-2' }),
        okLine({ ...at(1), modelSnapshot: 'm-1' }),
        okLine({ ...at(2), modelSnapshot: 'm-1' }),
        abandoned(3, 'timeout'),
        abandoned(4, 'timeout'),
        abandoned(5, 'restart'),
      ]),
    ).baseline;
    expect(ops.sideCallFailures).toEqual([
      { kind: 'transient', count: 1 },
      { kind: 'timeout', count: 1 },
    ]);
    expect(ops.abandoned).toEqual({ timeout: 2, restart: 1 });
    expect(ops.responseModels).toEqual([
      { model: 'm-1', trials: 2 },
      { model: 'm-2', trials: 1 },
    ]);
  });

  it('001 FR-023 latency uses the ok trials among keys finished in both runs, with nearest-rank p50 and p95', () => {
    const baseline = run([
      okLine({ ...at(0), latencyMs: 100 }),
      okLine({ ...at(1), latencyMs: 300 }),
      okLine({ ...at(2), latencyMs: 200 }),
      errorLine('permanent', { ...at(3), latencyMs: 9000 }),
    ]);
    const candidate = run([
      okLine({ ...at(0), latencyMs: 10 }),
      okLine({ ...at(1), latencyMs: 20 }),
      stoppedLine(at(2)),
      okLine({ ...at(3), latencyMs: 30 }),
    ]);
    const ops = opsOf(baseline, candidate);
    expect(ops.baseline.latencyMs).toEqual({ p50: 100, p95: 300, values: [100, 300] });
    expect(ops.candidate.latencyMs).toEqual({ p50: 20, p95: 30, values: [10, 20, 30] });
    expect(opsOf(empty).baseline.latencyMs).toEqual({ p50: null, p95: null, values: [] });
  });

  it('001 FR-023 tokens and cost per trial sum every line of a key and spread calls of no trial over those keys', () => {
    const lines: TrialLine[] = [
      errorLine('transient', { ...at(0), costUsd: 0.001, usage: { input: 10 } }),
      okLine({
        ...at(0),
        attempt: 2,
        costUsd: 0.002,
        usage: { input: 20, output: 5, reasoning: 2 },
      }),
      keyedCostLineSchema.parse({
        ...at(0),
        attempt: 2,
        segment: 1,
        source: 'calls',
        costUsd: 0.0005,
        usage: { output: 3 },
        calls: [{ model: 'm', outcome: 'ok', usage: { output: 3 } }],
        costCorrection: true,
      }),
      okLine({ ...at(1), costUsd: 0.003, usage: { input: 30 } }),
      unkeyedCostLineSchema.parse({
        segment: 1,
        source: 'calls',
        costUsd: 0.004,
        usage: { input: 40 },
        calls: [{ model: 'm', outcome: 'ok', usage: { input: 40 } }],
        costCorrection: true,
      }),
    ];
    const ops = opsOf(run(lines), run([okLine(at(0)), okLine(at(1))])).baseline;
    expect(ops.tokensPerTrial).toEqual({
      input: 50,
      cachedInput: 0,
      cacheWrite: 0,
      output: 4,
      reasoning: 1,
    });
    expect(ops.costPerTrialUsd).toBeCloseTo(0.00525, 12);
  });

  it('001 FR-023 token means per trial are not rounded', () => {
    const lines = [0, 1, 2].map((repeat) =>
      okLine({ ...at(repeat), usage: { input: repeat === 2 ? 11 : 10, output: 1 } }),
    );
    const ops = opsOf(run(lines), run(lines)).baseline;
    expect(ops.tokensPerTrial.input).toBeCloseTo(31 / 3, 12);
    expect(ops.tokensPerTrial.output).toBe(1);
  });

  it('001 FR-023 cost per trial is null when a line has unknown cost or no key finished in both runs', () => {
    const unknown = run([okLine({ ...at(0), costUsd: null })]);
    expect(opsOf(unknown, run([okLine(at(0))])).baseline.costPerTrialUsd).toBeNull();
    expect(opsOf(run([okLine(at(0))])).baseline.costPerTrialUsd).toBeNull();
  });
});

describe('metric warnings', () => {
  const base = opsOf(empty).baseline;

  function ops(fields: {
    discard?: [number, number];
    regeneration?: [number, number];
    p95?: number;
    cost?: number;
  }): VariantOps {
    return {
      ...base,
      rates: {
        ...base.rates,
        discard: metricRate(...(fields.discard ?? [0, 100]), Z_L),
        regeneration: metricRate(...(fields.regeneration ?? [0, 100]), Z_L),
      },
      latencyMs: { p50: null, p95: fields.p95 ?? 1000, values: [] },
      costPerTrialUsd: fields.cost ?? 0.25,
    };
  }

  const review = (candidate: VariantOps) =>
    reviewOps({ baseline: ops({}), candidate }, WARN, VARIANTS);

  it('001 FR-023 a point estimate at a threshold does not warn', () => {
    const result = review(ops({ discard: [1, 100], regeneration: [3, 100], p95: 1500, cost: 0.5 }));
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      { metric: 'discard', baseline: 0, candidate: 0.01 },
      { metric: 'regeneration', baseline: 0, candidate: 0.03 },
      { metric: 'latencyP95', baseline: 1000, candidate: 1500, ratio: 1.5 },
      { metric: 'costPerTrial', baseline: 0.25, candidate: 0.5, ratio: 2 },
    ]);
  });

  it('001 FR-023 a point estimate above its threshold warns with both variants side by side', () => {
    const result = review(
      ops({ discard: [2, 100], regeneration: [4, 100], p95: 1501, cost: 0.51 }),
    );
    expect(result.warnings).toEqual([
      {
        code: 'discard-rate-increase',
        params: { rates: { current: 0, next: 0.02 }, threshold: 0.01 },
        variants: ['current', 'next'],
      },
      {
        code: 'regeneration-rate-increase',
        params: { rates: { current: 0, next: 0.04 }, threshold: 0.03 },
        variants: ['current', 'next'],
      },
      {
        code: 'latency-p95-ratio',
        params: { p95Ms: { current: 1000, next: 1501 }, ratio: 1.501, threshold: 1.5 },
        variants: ['current', 'next'],
      },
      {
        code: 'cost-ratio',
        params: { costPerTrialUsd: { current: 0.25, next: 0.51 }, ratio: 2.04, threshold: 2 },
        variants: ['current', 'next'],
      },
    ]);
    for (const warning of result.warnings) {
      expect(warningSchema.parse(warning)).toEqual(warning);
    }
    expect(result.changes.map((change) => change.warning)).toEqual([
      'discard-rate-increase',
      'regeneration-rate-increase',
      'latency-p95-ratio',
      'cost-ratio',
    ]);
  });

  it('001 FR-023 metric checks return warnings and changes only, never a gate outcome', () => {
    const result = review(ops({ discard: [50, 100], p95: 9000, cost: 9 }));
    expect(Object.keys(result).sort()).toEqual(['changes', 'warnings']);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'discard-rate-increase',
      'latency-p95-ratio',
      'cost-ratio',
    ]);
  });

  it('001 FR-023 no ratio without a baseline value', () => {
    const result = reviewOps(
      {
        baseline: {
          ...ops({}),
          costPerTrialUsd: null,
          latencyMs: { p50: null, p95: 0, values: [] },
        },
        candidate: ops({}),
      },
      WARN,
      VARIANTS,
    );
    expect(result.changes.slice(2)).toEqual([
      { metric: 'latencyP95', baseline: 0, candidate: 1000, ratio: null },
      { metric: 'costPerTrial', baseline: null, candidate: 0.25, ratio: null },
    ]);
    expect(result.warnings).toEqual([]);
  });
});
