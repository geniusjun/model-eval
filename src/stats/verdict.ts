import type { CellNote, Rate, Verdict } from '../report/schema.js';
import {
  cellZValues,
  differenceInterval,
  newcombeInterval,
  variantRate,
  type Difference,
  type PairedCase,
  type PerRole,
  type ZValues,
} from './interval.js';

// data-model §Statistics, Verdict order, and the cell notes of §Cell.

/** Below 3 cases V_cl is missing or too unstable to trust (research R3). */
export const MIN_CASES_FLOOR = 3;

/**
 * n_min(m) = ⌈z_L²(1−m)/m⌉: when both variants pass every trial, L = −z²/(ñ+z²), so L > −m
 * needs ñ above z²(1−m)/m. Lint uses it for `margin-unreachable`.
 */
export function nMin(margin: number, zLower: number): number {
  return Math.ceil((zLower * zLower * (1 - margin)) / margin);
}

export interface VerdictEvidence {
  /** Judged trials of the cell in each run, cases judged in one run only included. */
  readonly judgedTrials: PerRole<number>;
  /** K, the common cases with a judged trial in both runs. */
  readonly cases: number;
  /** L and U; null without a common case. */
  readonly diff: Pick<Difference, 'low' | 'high'> | null;
  /** min(ñ_b, ñ_c); null without a common case. */
  readonly minEffectiveTrials: number | null;
}

export interface VerdictSettings {
  readonly margin: number;
  readonly minCases: number;
  readonly zLower: number;
}

/** The first matching row of the verdict order decides. */
export function decideVerdict(evidence: VerdictEvidence, settings: VerdictSettings): Verdict {
  const { judgedTrials, cases, diff, minEffectiveTrials } = evidence;
  const { margin, minCases, zLower } = settings;
  if (judgedTrials.baseline === 0 && judgedTrials.candidate === 0) {
    return 'not-applicable';
  }
  if (cases < MIN_CASES_FLOOR || diff === null || minEffectiveTrials === null) {
    return 'insufficient';
  }
  if (diff.high < -margin) {
    return 'regressed';
  }
  if (cases < minCases) {
    return 'insufficient';
  }
  if (diff.low > 0) {
    return 'improved';
  }
  if (diff.low > -margin) {
    return 'non-inferior';
  }
  if (minEffectiveTrials < nMin(margin, zLower)) {
    return 'insufficient';
  }
  return 'inconclusive';
}

export interface NoteEvidence {
  readonly cases: number;
  /** U; null without a common case. */
  readonly high: number | null;
  /** U with deff = 1; null without a common case. */
  readonly highWithoutDesignEffect: number | null;
}

const DROP_NOTES: Partial<Record<Verdict, CellNote>> = {
  'non-inferior': 'drop-within-margin',
  inconclusive: 'drop-margin-undecided',
  insufficient: 'drop-too-few-samples',
};

/** A confirmed drop (U < 0) or, below 3 cases, a clear drop (U without deff below −m). */
export function cellNote(
  verdict: Verdict,
  evidence: NoteEvidence,
  margin: number,
): CellNote | undefined {
  const { cases, high, highWithoutDesignEffect } = evidence;
  if (cases < MIN_CASES_FLOOR) {
    return highWithoutDesignEffect !== null && highWithoutDesignEffect < -margin
      ? 'clear-drop-too-few-cases'
      : undefined;
  }
  return high !== null && high < 0 ? DROP_NOTES[verdict] : undefined;
}

/** `inconclusive` and `insufficient`; neither ever counts as passing. */
export function isUndecided(verdict: Verdict): boolean {
  return verdict === 'inconclusive' || verdict === 'insufficient';
}

export interface CellInput {
  /** The K common cases. */
  readonly pairs: readonly PairedCase[];
  readonly judgedTrials: PerRole<number>;
  readonly gated: boolean;
  /** The rule's margin, else `gate.margin`, else 0.10. */
  readonly margin: number;
  readonly minCases: number;
  /** z_L and the corrected z_U of the comparison; ungated cells use z_L for both bounds. */
  readonly z: ZValues;
}

export interface CellStatistics {
  readonly baseline: Rate;
  readonly candidate: Rate;
  readonly diff: Difference | null;
  readonly deff: number | null;
  readonly verdict: Verdict;
  readonly note?: CellNote;
}

/** The statistical fields of a Cell (data-model §Cell). */
export function judgeCell(input: CellInput): CellStatistics {
  const { pairs, judgedTrials, gated, margin, minCases } = input;
  const z = cellZValues(input.z, gated);
  const baseline = variantRate(
    pairs.map((pair) => pair.baseline),
    z.zLower,
  );
  const candidate = variantRate(
    pairs.map((pair) => pair.candidate),
    z.zLower,
  );
  const interval = differenceInterval(pairs, z);
  const verdict = decideVerdict(
    {
      judgedTrials,
      cases: pairs.length,
      diff: interval?.diff ?? null,
      minEffectiveTrials:
        baseline.nEff === null || candidate.nEff === null
          ? null
          : Math.min(baseline.nEff, candidate.nEff),
    },
    { margin, minCases, zLower: z.zLower },
  );
  const note = cellNote(
    verdict,
    {
      cases: pairs.length,
      high: interval?.diff.high ?? null,
      highWithoutDesignEffect: pairs.length === 0 ? null : newcombeInterval(pairs, z, 1).high,
    },
    margin,
  );
  return {
    baseline,
    candidate,
    diff: interval?.diff ?? null,
    deff: interval?.deff ?? null,
    verdict,
    ...(note === undefined ? {} : { note }),
  };
}
