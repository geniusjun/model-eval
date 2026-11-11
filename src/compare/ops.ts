import { compareCodeUnits } from '../adapter/canonical-json.js';
import { errorKindSchema, type ErrorKind, type Usage } from '../adapter/protocol.js';
import type { ReportConfig } from '../config/schema.js';
import { classifyTrial, completedGrade, isEmptyText, type TrialOutcome } from '../grade/outcome.js';
import type { Redactor } from '../report/redact.js';
import type { MetricRate, OpsChange, VariantOps } from '../report/schema.js';
import { indexTrialLines, p95, type KeyLines } from '../run/cost.js';
import { trialKeyId } from '../run/ids.js';
import type { AttemptLine, TrialLine } from '../run/records.js';
import type { Warning } from '../run/warning.js';
import type { PerRole } from '../stats/interval.js';
import { wilson } from '../stats/wilson.js';

// data-model §Comparison, `ops`: operational metrics per variant on the common, unchanged cases.

const TOP_MESSAGES = 3;

export interface OpsRun {
  /** Every complete line of the run's `trials.jsonl`. */
  readonly lines: readonly TrialLine[];
  /** The run's finished effective lines on common cases (`finishedTrials`). */
  readonly finished: readonly AttemptLine[];
  /** The run's systematic failures (`systematicFailures`). */
  readonly systematic: readonly AttemptLine[];
}

/** A count with its denominator and the Wilson interval at z_L; null statistics without trials. */
export function metricRate(count: number, total: number, zLower: number): MetricRate {
  if (total === 0) {
    return { count, total, rate: null, low: null, high: null };
  }
  const { low, high } = wilson(count, total, zLower);
  return { count, total, rate: count / total, low, high };
}

function countBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== undefined) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Most frequent first, then in code-unit order. */
const byFrequency = (a: [string, number], b: [string, number]): number =>
  b[1] - a[1] || compareCodeUnits(a[0], b[0]);

/** The nearest-rank 50th percentile. */
function p50(sorted: readonly number[]): number | null {
  return sorted[Math.ceil(sorted.length / 2) - 1] ?? null;
}

interface Classified {
  readonly line: AttemptLine;
  readonly outcome: TrialOutcome;
}

/**
 * The variant's trials graded on `completed` in the comparison: systematic failures in, other
 * transient, adapter and config errors out. It is the denominator of the rejection, time-out,
 * discard, fallback, empty answer and regeneration rates.
 */
function completedTrials(run: OpsRun): Classified[] {
  const systematic = new Set(run.systematic.map(trialKeyId));
  return run.finished
    .map((line) => ({ line, outcome: classifyTrial(line) }))
    .filter(
      ({ line, outcome }) => completedGrade(outcome) !== 'skip' || systematic.has(trialKeyId(line)),
    );
}

/** Finished trials in one row of the outcome table, out of all finished trials. */
export function outcomeShare(
  finished: readonly AttemptLine[],
  outcome: TrialOutcome,
): { readonly count: number; readonly total: number } {
  const count = finished.filter((line) => classifyTrial(line) === outcome).length;
  return { count, total: finished.length };
}

function rates(run: OpsRun, zLower: number): VariantOps['rates'] {
  const graded = completedTrials(run);
  const ofGraded = (matches: (trial: Classified) => boolean) =>
    metricRate(graded.filter(matches).length, graded.length, zLower);
  const ofFinished = (outcome: TrialOutcome) => {
    const { count, total } = outcomeShare(run.finished, outcome);
    return metricRate(count, total, zLower);
  };
  return {
    rejection: ofGraded(({ outcome }) => outcome === 'permanent'),
    timeout: ofGraded(({ outcome }) => outcome === 'timeout'),
    transient: ofFinished('transient'),
    adapter: ofFinished('adapter'),
    discard: ofGraded(({ line }) => line.status === 'ok' && line.finalKind === 'discarded'),
    fallback: ofGraded(({ line }) => line.status === 'ok' && line.finalKind === 'fallback'),
    empty: ofGraded(
      ({ line }) => line.status === 'ok' && line.answers >= 1 && isEmptyText(line.raw),
    ),
    regeneration: ofGraded(({ line }) => line.status === 'ok' && line.answers >= 2),
  };
}

/** Reasons are grouped after redaction, so reasons that differ only in a redacted part merge. */
function discardReasons(run: OpsRun, redactor: Redactor): VariantOps['discardReasons'] {
  const reasons = countBy(completedTrials(run), ({ line }) =>
    line.status === 'ok' && line.finalKind === 'discarded' && line.discardReason !== undefined
      ? redactor.text(line.discardReason)
      : undefined,
  );
  return [...reasons].sort(byFrequency).map(([discardReason, count]) => ({ discardReason, count }));
}

/** Messages are grouped after redaction, like discard reasons. */
function topMessages(run: OpsRun, redactor: Redactor): VariantOps['topMessages'] {
  return errorKindSchema.options.flatMap((kind) => {
    const messages = countBy(run.finished, (line) =>
      line.status === 'error' && line.error.kind === kind
        ? redactor.text(line.error.message)
        : undefined,
    );
    return [...messages]
      .sort(byFrequency)
      .slice(0, TOP_MESSAGES)
      .map(([message, count]) => ({ kind, message, count }));
  });
}

/** Failed and unanswered side calls with a kind, over every line of the finished keys. */
function sideCallFailures(
  run: OpsRun,
  keys: ReadonlyMap<string, KeyLines>,
): VariantOps['sideCallFailures'] {
  const kinds = new Map<ErrorKind, number>();
  for (const line of run.finished) {
    const lines = keys.get(trialKeyId(line));
    for (const each of [...(lines?.attempts ?? []), ...(lines?.costLines ?? [])]) {
      for (const call of each.calls ?? []) {
        if (call.branch === 'side' && call.outcome !== 'ok' && call.errorKind !== undefined) {
          kinds.set(call.errorKind, (kinds.get(call.errorKind) ?? 0) + 1);
        }
      }
    }
  }
  return errorKindSchema.options.flatMap((kind) => {
    const count = kinds.get(kind);
    return count === undefined ? [] : [{ kind, count }];
  });
}

/** Trials abandoned after a time-out or an adapter restart, by cause. */
export function abandonedCounts(lines: readonly AttemptLine[]): VariantOps['abandoned'] {
  const cause = (line: AttemptLine) => (line.status === 'error' ? line.error.abandoned : undefined);
  return {
    timeout: lines.filter((line) => cause(line) === 'timeout').length,
    restart: lines.filter((line) => cause(line) === 'restart').length,
  };
}

function finishReasons(run: OpsRun): VariantOps['finishReasons'] {
  const counts = { stop: 0, length: 0, content_filter: 0, other: 0 };
  for (const { line } of completedTrials(run)) {
    if (line.status === 'ok') {
      counts[line.finishReason] += 1;
    }
  }
  return counts;
}

function responseModels(run: OpsRun): VariantOps['responseModels'] {
  const models = countBy(run.finished, (line) =>
    line.status === 'ok' ? line.modelSnapshot : undefined,
  );
  return [...models]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([model, trials]) => ({ model, trials }));
}

/** A line that may carry tokens and cost. */
interface ChargedLine {
  readonly usage?: Usage | undefined;
  readonly costUsd: number | null;
}

interface PerTrial {
  readonly tokensPerTrial: VariantOps['tokensPerTrial'];
  readonly costPerTrialUsd: number | null;
}

/**
 * Tokens and cost per trial over the keys finished in both runs: each key sums all its lines,
 * and calls that belong to no known trial are spread evenly over those keys.
 */
function perTrial(
  lines: readonly ChargedLine[],
  unkeyed: readonly ChargedLine[],
  keys: number,
): PerTrial {
  const all = [...lines, ...unkeyed];
  const mean = (field: keyof Usage): number =>
    keys === 0 ? 0 : all.reduce((total, line) => total + (line.usage?.[field] ?? 0), 0) / keys;
  const cost = all.some((line) => line.costUsd === null)
    ? null
    : all.reduce((total, line) => total + (line.costUsd ?? 0), 0);
  return {
    tokensPerTrial: {
      input: mean('input'),
      cachedInput: mean('cachedInput'),
      cacheWrite: mean('cacheWrite'),
      output: mean('output'),
      reasoning: mean('reasoning'),
    },
    costPerTrialUsd: keys === 0 || cost === null ? null : cost / keys,
  };
}

function variantOps(
  run: OpsRun,
  bothFinished: ReadonlySet<string>,
  zLower: number,
  redactor: Redactor,
): VariantOps {
  const index = indexTrialLines(run.lines);
  const shared = run.finished.filter((line) => bothFinished.has(trialKeyId(line)));
  const sharedLines = shared.flatMap((line) => {
    const lines = index.keys.get(trialKeyId(line));
    return [...(lines?.attempts ?? []), ...(lines?.costLines ?? [])];
  });
  const latencies = shared
    .flatMap((line) => (line.status === 'ok' ? [line.latencyMs] : []))
    .sort((a, b) => a - b);
  return {
    rates: rates(run, zLower),
    systematic: {
      trials: run.systematic.length,
      cases: new Set(run.systematic.map((line) => line.caseId)).size,
    },
    discardReasons: discardReasons(run, redactor),
    topMessages: topMessages(run, redactor),
    sideCallFailures: sideCallFailures(run, index.keys),
    abandoned: abandonedCounts(run.finished),
    finishReasons: finishReasons(run),
    latencyMs: {
      p50: p50(latencies),
      p95: latencies.length === 0 ? null : p95(latencies),
      values: latencies,
    },
    ...perTrial(sharedLines, index.unkeyed, shared.length),
    responseModels: responseModels(run),
  };
}

/** `ops` of the comparison, its free text redacted; Wilson intervals at z_L. */
export function comparisonOps(
  runs: PerRole<OpsRun>,
  zLower: number,
  redactor: Redactor,
): PerRole<VariantOps> {
  const candidate = new Set(runs.candidate.finished.map(trialKeyId));
  const bothFinished = new Set(
    runs.baseline.finished.map(trialKeyId).filter((key) => candidate.has(key)),
  );
  return {
    baseline: variantOps(runs.baseline, bothFinished, zLower, redactor),
    candidate: variantOps(runs.candidate, bothFinished, zLower, redactor),
  };
}

export interface OpsReview {
  readonly changes: OpsChange[];
  readonly warnings: Warning[];
}

interface Check {
  readonly change: OpsChange;
  readonly warning?: Warning;
}

type Values = PerRole<number | null>;

const ratioOf = ({ baseline, candidate }: Values): number | null =>
  baseline === null || candidate === null || baseline === 0 ? null : candidate / baseline;

function rateCheck(
  metric: 'discard' | 'regeneration',
  code: 'discard-rate-increase' | 'regeneration-rate-increase',
  ops: PerRole<VariantOps>,
  threshold: number,
  variants: PerRole<string>,
): Check {
  const baseline = ops.baseline.rates[metric].rate;
  const candidate = ops.candidate.rates[metric].rate;
  if (baseline === null || candidate === null || candidate - baseline <= threshold) {
    return { change: { metric, baseline, candidate } };
  }
  return {
    change: { metric, baseline, candidate, warning: code },
    warning: {
      code,
      params: { rates: perVariant(variants, baseline, candidate), threshold },
      variants: [variants.baseline, variants.candidate],
    },
  };
}

function latencyCheck(
  ops: PerRole<VariantOps>,
  threshold: number,
  variants: PerRole<string>,
): Check {
  const values = { baseline: ops.baseline.latencyMs.p95, candidate: ops.candidate.latencyMs.p95 };
  const ratio = ratioOf(values);
  const change: OpsChange = { metric: 'latencyP95', ...values, ratio };
  if (
    ratio === null ||
    ratio <= threshold ||
    values.baseline === null ||
    values.candidate === null
  ) {
    return { change };
  }
  return {
    change: { ...change, warning: 'latency-p95-ratio' },
    warning: {
      code: 'latency-p95-ratio',
      params: { p95Ms: perVariant(variants, values.baseline, values.candidate), ratio, threshold },
      variants: [variants.baseline, variants.candidate],
    },
  };
}

function costCheck(ops: PerRole<VariantOps>, threshold: number, variants: PerRole<string>): Check {
  const values = {
    baseline: ops.baseline.costPerTrialUsd,
    candidate: ops.candidate.costPerTrialUsd,
  };
  const ratio = ratioOf(values);
  const change: OpsChange = { metric: 'costPerTrial', ...values, ratio };
  if (
    ratio === null ||
    ratio <= threshold ||
    values.baseline === null ||
    values.candidate === null
  ) {
    return { change };
  }
  return {
    change: { ...change, warning: 'cost-ratio' },
    warning: {
      code: 'cost-ratio',
      params: {
        costPerTrialUsd: perVariant(variants, values.baseline, values.candidate),
        ratio,
        threshold,
      },
      variants: [variants.baseline, variants.candidate],
    },
  };
}

function perVariant<T>(variants: PerRole<string>, baseline: T, candidate: T): Record<string, T> {
  return { [variants.baseline]: baseline, [variants.candidate]: candidate };
}

/**
 * The four metric checks: point estimates above `report.warn`, never an interval, and never an
 * input to the gate, so they cannot change the exit code (constitution II).
 */
export function reviewOps(
  ops: PerRole<VariantOps>,
  warn: ReportConfig['warn'],
  variants: PerRole<string>,
): OpsReview {
  const checks = [
    rateCheck('discard', 'discard-rate-increase', ops, warn.discardRateIncrease, variants),
    rateCheck(
      'regeneration',
      'regeneration-rate-increase',
      ops,
      warn.regenerationRateIncrease,
      variants,
    ),
    latencyCheck(ops, warn.latencyP95Ratio, variants),
    costCheck(ops, warn.costRatio, variants),
  ];
  return {
    changes: checks.map((check) => check.change),
    warnings: checks.flatMap((check) => (check.warning === undefined ? [] : [check.warning])),
  };
}
