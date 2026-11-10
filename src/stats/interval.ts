import type { Rate } from '../report/schema.js';
import { normalQuantile } from './quantile.js';
import { wilson } from './wilson.js';

// data-model §Statistics: estimators, the interval and the levels of one cell.

export interface PerRole<T> {
  readonly baseline: T;
  readonly candidate: T;
}

/** n_vi and x_vi: judged trials and passes of one case for one variant. */
export interface CaseCounts {
  readonly trials: number;
  readonly passes: number;
}

/** One of the K common cases, judged in both variants. */
export type PairedCase = PerRole<CaseCounts>;

/** z_L for lower bounds and z_U for upper bounds. */
export interface ZValues {
  readonly zLower: number;
  readonly zUpper: number;
}

export interface Difference {
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
}

export interface DifferenceInterval {
  readonly diff: Difference;
  readonly deff: number;
}

/**
 * z_L = z_{1−α} and z_U = z_{1−α/G} with α = (1 − confidence)/2; z_U = z_L when G = 0. They are
 * taken as −z_α and −z_{α/G}: for a confidence near 1, 1 − α rounds to 1 and has no quantile.
 */
export function zValues(confidence: number, gatedCells: number): ZValues {
  const alpha = (1 - confidence) / 2;
  const zLower = -normalQuantile(alpha);
  return {
    zLower,
    zUpper: gatedCells > 0 ? -normalQuantile(alpha / gatedCells) : zLower,
  };
}

/** Only gated cells use the corrected z_U. */
export function cellZValues(z: ZValues, gated: boolean): ZValues {
  return gated ? z : { zLower: z.zLower, zUpper: z.zLower };
}

function assertCases(cases: readonly CaseCounts[]): void {
  if (cases.length === 0) {
    throw new RangeError('a rate needs at least one case');
  }
  for (const { trials, passes } of cases) {
    if (!(Number.isInteger(trials) && Number.isInteger(passes) && trials >= 1)) {
      throw new RangeError(
        `case counts must be integers with trials ≥ 1, not ${String(passes)}/${String(trials)}`,
      );
    }
    if (passes < 0 || passes > trials) {
      throw new RangeError(
        `passes must be within 0..trials, not ${String(passes)}/${String(trials)}`,
      );
    }
  }
}

const shares = (cases: readonly CaseCounts[]): number[] =>
  cases.map(({ trials, passes }) => passes / trials);

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Sample variance with K − 1 in the denominator; 0 below two values. */
export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const centre = mean(values);
  return values.reduce((sum, value) => sum + (value - centre) ** 2, 0) / (values.length - 1);
}

/** p̂_v = (1/K) Σ x_vi / n_vi. */
export function caseWeightedRate(cases: readonly CaseCounts[]): number {
  assertCases(cases);
  return mean(shares(cases));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * ñ_v = K² / Σ(1/n_vi). Integer arithmetic over the least common multiple keeps ñ = K·r exact
 * for equal repeats: summing 1/r in floating point gives 149.99999999999994 for 30 × 5, which
 * would move ⌊r̄⌋ and the n_min comparison by one.
 */
export function effectiveTrials(cases: readonly CaseCounts[]): number {
  assertCases(cases);
  const k = cases.length;
  const common = commonMultiple(cases);
  if (common !== null) {
    const reciprocals = cases.reduce((sum, { trials }) => sum + common / trials, 0);
    const numerator = k * k * common;
    if (Number.isSafeInteger(numerator) && Number.isSafeInteger(reciprocals)) {
      return numerator / reciprocals;
    }
  }
  return (k * k) / cases.reduce((sum, { trials }) => sum + 1 / trials, 0);
}

/** The least common multiple of the trial counts; null once it is not a safe integer. */
function commonMultiple(cases: readonly CaseCounts[]): number | null {
  let lcm = 1;
  for (const { trials } of cases) {
    lcm = (lcm / gcd(lcm, trials)) * trials;
    if (!Number.isSafeInteger(lcm)) {
      return null;
    }
  }
  return lcm;
}

/**
 * The rate of one variant over the given cases: case-weighted, with the Wilson interval at
 * z_L widened by deff_v = max(1, (s²(y_v)/K) ÷ (p̂_v(1−p̂_v)/ñ_v)). Statistics are null without
 * a case.
 */
export function variantRate(cases: readonly CaseCounts[], zLower: number): Rate {
  if (cases.length === 0) {
    return {
      cases: 0,
      trials: 0,
      passes: 0,
      rate: null,
      pooledRate: null,
      low: null,
      high: null,
      nEff: null,
    };
  }
  const rate = caseWeightedRate(cases);
  const nEff = effectiveTrials(cases);
  const trials = cases.reduce((sum, c) => sum + c.trials, 0);
  const passes = cases.reduce((sum, c) => sum + c.passes, 0);
  const binomial = (rate * (1 - rate)) / nEff;
  const deff =
    binomial === 0 ? 1 : Math.max(1, sampleVariance(shares(cases)) / cases.length / binomial);
  const { low, high } = wilson((rate * nEff) / deff, nEff / deff, zLower);
  return {
    cases: cases.length,
    trials,
    passes,
    rate,
    pooledRate: passes / trials,
    low,
    high,
    nEff,
  };
}

interface CellEstimates {
  readonly baseline: { readonly rate: number; readonly nEff: number };
  readonly candidate: { readonly rate: number; readonly nEff: number };
  /** d_i = y_ci − y_bi */
  readonly differences: readonly number[];
}

function estimates(pairs: readonly PairedCase[]): CellEstimates {
  const baseline = pairs.map((pair) => pair.baseline);
  const candidate = pairs.map((pair) => pair.candidate);
  return {
    baseline: { rate: caseWeightedRate(baseline), nEff: effectiveTrials(baseline) },
    candidate: { rate: caseWeightedRate(candidate), nEff: effectiveTrials(candidate) },
    differences: caseDifferences(pairs),
  };
}

/** d_i = y_ci − y_bi */
export function caseDifferences(pairs: readonly PairedCase[]): number[] {
  return pairs.map(
    (pair) =>
      pair.candidate.passes / pair.candidate.trials - pair.baseline.passes / pair.baseline.trials,
  );
}

/**
 * deff = max(1, V_cl / V_bin), 1 when V_bin = 0. With one case V_cl has no degree of freedom
 * and deff is 1; such a cell is `insufficient` anyway (verdict row 2).
 */
export function designEffect(pairs: readonly PairedCase[]): number {
  const { baseline, candidate, differences } = estimates(pairs);
  const k = pairs.length;
  const binomial =
    (candidate.rate * (1 - candidate.rate)) / candidate.nEff +
    (baseline.rate * (1 - baseline.rate)) / baseline.nEff;
  if (k < 2 || binomial === 0) {
    return 1;
  }
  // V_cl = Σ(d_i − Δ̂)² / (K(K−1)), and Δ̂ is the mean of the d_i.
  return Math.max(1, sampleVariance(differences) / k / binomial);
}

/**
 * Newcombe hybrid score interval on n*_v = ñ_v/deff: L from the Wilson bounds at z_L, U from
 * those at z_U.
 */
export function newcombeInterval(
  pairs: readonly PairedCase[],
  z: ZValues,
  deff: number,
): Difference {
  const { baseline, candidate } = estimates(pairs);
  const bounds = (side: { rate: number; nEff: number }, zValue: number) =>
    wilson((side.rate * side.nEff) / deff, side.nEff / deff, zValue);
  const lower = { baseline: bounds(baseline, z.zLower), candidate: bounds(candidate, z.zLower) };
  const upper = { baseline: bounds(baseline, z.zUpper), candidate: bounds(candidate, z.zUpper) };
  const estimate = candidate.rate - baseline.rate;
  return {
    estimate,
    low:
      estimate -
      Math.hypot(candidate.rate - lower.candidate.low, lower.baseline.high - baseline.rate),
    high:
      estimate +
      Math.hypot(upper.candidate.high - candidate.rate, baseline.rate - upper.baseline.low),
  };
}

/** Δ̂ with [L, U] and the design effect; null without a common case. */
export function differenceInterval(
  pairs: readonly PairedCase[],
  z: ZValues,
): DifferenceInterval | null {
  if (pairs.length === 0) {
    return null;
  }
  const deff = designEffect(pairs);
  return { diff: newcombeInterval(pairs, z, deff), deff };
}
