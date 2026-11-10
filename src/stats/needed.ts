import type { Needed } from '../report/schema.js';
import {
  caseDifferences,
  caseWeightedRate,
  effectiveTrials,
  sampleVariance,
  type CaseCounts,
  type PairedCase,
  type ZValues,
} from './interval.js';
import { MIN_CASES_FLOOR, nMin } from './verdict.js';

// data-model §Statistics, Trials needed (FR-024), for undecided gated cells.

/** 0.84 = z_{0.80}: about 80% chance that a new run decides. */
const POWER_Z = 0.84;

/**
 * Δ̂ is a fraction over K times the trials per case and m a short decimal, so a Δ̂ on −m
 * differs from it only by rounding (0.9 − 1 + 0.1 is 2.8e-17), while a Δ̂ off the margin
 * differs by at least 1/(10^digits(m) · K · lcm of trials per case), far above this.
 */
const ON_MARGIN_TOLERANCE = 1e-9;

export interface NeededInput {
  /** The K common cases of the cell. */
  readonly pairs: readonly PairedCase[];
  readonly margin: number;
  readonly minCases: number;
  /** z_L and the corrected z_U of a gated cell. */
  readonly z: ZValues;
  /** All cases of the run, for the trials per variant of the whole new run. */
  readonly runCases: number;
}

interface Components {
  /** W = p̃_b(1−p̃_b) + p̃_c(1−p̃_c) */
  readonly w: number;
  /** r̄, the harmonic mean of candidate trials per case */
  readonly rBar: number;
  /** σ²_B, the between-case part repeats cannot reduce */
  readonly betweenCase: number;
  /** d = |Δ̂ + m| */
  readonly distance: number;
  /** z_t = z + 0.84 */
  readonly zPower: number;
}

/** p̃ = (x + z²/2) / (n + z²) over the pooled passes and trials. */
function smoothedRate(cases: readonly CaseCounts[], z: number): number {
  const passes = cases.reduce((sum, c) => sum + c.passes, 0);
  const trials = cases.reduce((sum, c) => sum + c.trials, 0);
  return (passes + (z * z) / 2) / (trials + z * z);
}

function components(pairs: readonly PairedCase[], margin: number, z: ZValues): Components {
  const baseline = pairs.map((pair) => pair.baseline);
  const candidate = pairs.map((pair) => pair.candidate);
  const estimate = caseWeightedRate(candidate) - caseWeightedRate(baseline);
  const zValue = estimate > -margin ? z.zLower : z.zUpper;
  const pb = smoothedRate(baseline, zValue);
  const pc = smoothedRate(candidate, zValue);
  const w = pb * (1 - pb) + pc * (1 - pc);
  const rBar = effectiveTrials(candidate) / pairs.length;
  return {
    w,
    rBar,
    betweenCase: Math.max(0, sampleVariance(caseDifferences(pairs)) - w / rBar),
    distance: Math.abs(estimate + margin),
    zPower: zValue + POWER_Z,
  };
}

/** ⌈z_t²(σ²_B + W/r̄)/d²⌉ */
const casesFor = (c: Components): number =>
  Math.ceil((c.zPower ** 2 * (c.betweenCase + c.w / c.rBar)) / c.distance ** 2);

const onMargin = (c: Components): boolean => c.distance <= ON_MARGIN_TOLERANCE;

/**
 * Cases first: below max(3, minCases) cases more repeats fall back into verdict rows 2 or 4.
 * The larger count of the cases formula needs s_d² (K ≥ 2) and a distance from the margin.
 */
function casesFirst(input: NeededInput, floor: number): Needed {
  if (input.pairs.length < 2) {
    return { kind: 'cases', cases: floor };
  }
  const c = components(input.pairs, input.margin, input.z);
  return { kind: 'cases', cases: onMargin(c) ? floor : Math.max(floor, casesFor(c)) };
}

export function trialsNeeded(input: NeededInput): Needed {
  const { pairs, margin, minCases, z, runCases } = input;
  const k = pairs.length;
  const floor = Math.max(MIN_CASES_FLOOR, minCases);
  if (k < floor) {
    return casesFirst(input, floor);
  }
  const c = components(pairs, margin, z);
  if (onMargin(c)) {
    return { kind: 'on-margin' };
  }
  const room = (k * c.distance ** 2) / c.zPower ** 2 - c.betweenCase;
  if (room <= 0) {
    return { kind: 'cases', cases: casesFor(c) };
  }
  const repeats = Math.max(
    Math.ceil(c.w / room),
    Math.ceil(nMin(margin, z.zLower) / k),
    Math.floor(c.rBar) + 1,
  );
  return {
    kind: 'repeats',
    repeats,
    cellTrials: k * repeats,
    trialsPerVariant: runCases * repeats,
    nearMargin: repeats > 10 * c.rBar,
  };
}
