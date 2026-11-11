import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { Rule, Surface } from '../config/schema.js';
import { classifyTrial } from '../grade/outcome.js';
import type { Grade } from '../grade/record.js';
import type { Aggregate, Cell, Rate } from '../report/schema.js';
import { trialKeyId } from '../run/ids.js';
import type { AttemptLine } from '../run/records.js';
import {
  caseWeightedRate,
  type CaseCounts,
  type PairedCase,
  type PerRole,
  type ZValues,
} from '../stats/interval.js';
import { trialsNeeded } from '../stats/needed.js';
import { isUndecided, judgeCell } from '../stats/verdict.js';
import type { CommonCase } from './common-cases.js';

// data-model §Cell: rule × language × surface over the common, unchanged cases.

/** The margin when neither the rule nor `gate.margin` sets one. */
export const DEFAULT_MARGIN = 0.1;

const SURFACE_ORDER: readonly Surface[] = ['raw', 'final', 'trial'];

export interface CellKey {
  readonly ruleId: string;
  readonly lang: string;
  readonly surface: Surface;
}

export interface CellsInput {
  /** The common, unchanged cases. */
  readonly cases: readonly CommonCase[];
  /** The rules of the comparison; cells follow their order and take their margin. */
  readonly rules: readonly Rule[];
  /** `gate.margin`, the margin of rules without their own. */
  readonly gateMargin: number | undefined;
  /** Each run's grade set. */
  readonly grades: PerRole<readonly Grade[]>;
  /** Each run's systematic failures (`systematicFailures`). */
  readonly systematic: PerRole<readonly AttemptLine[]>;
  /** Each run's finished trials of the common cases (`finishedTrials`). */
  readonly finished: PerRole<readonly AttemptLine[]>;
}

/** Errors whose trials the `completed` cell leaves out unless they are systematic. */
type ExcludedKind = 'transient' | 'adapter';
type ExcludedCounts = Record<ExcludedKind, number>;

/** What a cell holds before the gate decides which cells are gated. */
export interface CellEvidence extends CellKey {
  readonly margin: number;
  /** The K common cases judged in both runs, in case order. */
  readonly pairs: readonly PairedCase[];
  /** Judged trials of the cell in each run, cases judged in one run only included. */
  readonly judgedTrials: PerRole<number>;
  readonly droppedCases: number;
  /** `completed` cells only. */
  readonly systematic?: PerRole<{ readonly trials: number; readonly cases: number }>;
  /** `completed` cells only: transient and adapter errors left out, not systematic. */
  readonly excluded?: PerRole<Readonly<ExcludedCounts>>;
  /** `raw` cells only. */
  readonly masked?: PerRole<number | null>;
}

export interface CellContext {
  readonly gated: boolean;
  /** z_L and the corrected z_U of the comparison. */
  readonly z: ZValues;
  readonly minCases: number;
  /** All cases of the run, for the trials per variant a new run needs. */
  readonly runCases: number;
}

/** A map key for a cell. */
export function cellId(cell: CellKey): string {
  return `${cell.ruleId}\u0000${cell.lang}\u0000${cell.surface}`;
}

interface MutableCounts {
  trials: number;
  passes: number;
}

interface TrialSurfaces {
  readonly ruleId: string;
  readonly caseId: string;
  raw?: Grade['outcome'];
  final?: Grade['outcome'];
}

interface SystematicTally {
  readonly trials: Set<string>;
  readonly cases: Set<string>;
}

/** Judged counts per cell and case, systematic failures per cell, and both text surfaces per trial. */
interface RunTally {
  readonly keys: Map<string, CellKey>;
  readonly counts: Map<string, Map<string, MutableCounts>>;
  readonly systematic: Map<string, SystematicTally>;
  readonly excluded: Map<string, ExcludedCounts>;
  readonly surfaces: Map<string, TrialSurfaces>;
}

const isJudged = (outcome: Grade['outcome'] | undefined): boolean =>
  outcome === 'pass' || outcome === 'fail';

/** The outcome of each finished trial in a transient or adapter row, by trial key. */
function excludedKinds(finished: readonly AttemptLine[]): Map<string, ExcludedKind> {
  const kinds = new Map<string, ExcludedKind>();
  for (const line of finished) {
    const outcome = classifyTrial(line);
    if (outcome === 'transient' || outcome === 'adapter') {
      kinds.set(trialKeyId(line), outcome);
    }
  }
  return kinds;
}

function tally(
  grades: readonly Grade[],
  lang: ReadonlyMap<string, string>,
  rules: ReadonlySet<string>,
  systematic: ReadonlySet<string>,
  errors: ReadonlyMap<string, ExcludedKind>,
): RunTally {
  const result: RunTally = {
    keys: new Map(),
    counts: new Map(),
    systematic: new Map(),
    excluded: new Map(),
    surfaces: new Map(),
  };
  for (const grade of grades) {
    const caseLang = lang.get(grade.caseId);
    if (caseLang === undefined || !rules.has(grade.ruleId)) {
      continue;
    }
    const key: CellKey = { ruleId: grade.ruleId, lang: caseLang, surface: grade.surface };
    const id = cellId(key);
    result.keys.set(id, key);
    const trialKey = trialKeyId(grade);
    const isSystematic =
      grade.surface === 'trial' && grade.outcome === 'skip' && systematic.has(trialKey);
    const outcome = isSystematic ? 'fail' : grade.outcome;
    if (isSystematic) {
      const counted = result.systematic.get(id) ?? { trials: new Set(), cases: new Set() };
      counted.trials.add(trialKey);
      counted.cases.add(grade.caseId);
      result.systematic.set(id, counted);
    }
    const error = errors.get(trialKey);
    if (
      grade.surface === 'trial' &&
      grade.outcome === 'skip' &&
      !isSystematic &&
      error !== undefined
    ) {
      const counted = result.excluded.get(id) ?? { transient: 0, adapter: 0 };
      counted[error] += 1;
      result.excluded.set(id, counted);
    }
    if (grade.surface !== 'trial') {
      const surfaceId = `${grade.ruleId}\u0000${trialKey}`;
      const surfaces = result.surfaces.get(surfaceId) ?? {
        ruleId: grade.ruleId,
        caseId: grade.caseId,
      };
      surfaces[grade.surface] = outcome;
      result.surfaces.set(surfaceId, surfaces);
    }
    if (!isJudged(outcome)) {
      continue;
    }
    const perCase = result.counts.get(id) ?? new Map<string, MutableCounts>();
    const counts = perCase.get(grade.caseId) ?? { trials: 0, passes: 0 };
    counts.trials += 1;
    counts.passes += outcome === 'pass' ? 1 : 0;
    perCase.set(grade.caseId, counts);
    result.counts.set(id, perCase);
  }
  return result;
}

function judgedTrialsOf(perCase: ReadonlyMap<string, CaseCounts>): number {
  let total = 0;
  for (const { trials } of perCase.values()) {
    total += trials;
  }
  return total;
}

/** Share of trials judged on both surfaces that failed raw and passed final; null without one. */
function maskedShare(
  tallied: RunTally,
  ruleId: string,
  caseIds: ReadonlySet<string>,
): number | null {
  let both = 0;
  let masked = 0;
  for (const { raw, final, ...trial } of tallied.surfaces.values()) {
    if (trial.ruleId === ruleId && caseIds.has(trial.caseId) && isJudged(raw) && isJudged(final)) {
      both += 1;
      masked += raw === 'fail' && final === 'pass' ? 1 : 0;
    }
  }
  return both === 0 ? null : masked / both;
}

const systematicCounts = (counted: SystematicTally | undefined) => ({
  trials: counted?.trials.size ?? 0,
  cases: counted?.cases.size ?? 0,
});

function compareKeys(order: ReadonlyMap<string, number>) {
  return (a: CellKey, b: CellKey): number =>
    (order.get(a.ruleId) ?? 0) - (order.get(b.ruleId) ?? 0) ||
    compareCodeUnits(a.lang, b.lang) ||
    SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface);
}

/**
 * One evidence per cell that has a grade on a common case in either run. Grades of other cases
 * and of rules outside `rules` are left out; systematic failures turn their `skip` grades on
 * the trial surface into failures.
 */
export function cellEvidence(input: CellsInput): CellEvidence[] {
  const lang = new Map(input.cases.map((testCase) => [testCase.id, testCase.lang]));
  const rules = new Map(input.rules.map((rule) => [rule.id, rule]));
  const ruleIds = new Set(rules.keys());
  const runTally = (role: keyof PerRole<unknown>): RunTally =>
    tally(
      input.grades[role],
      lang,
      ruleIds,
      new Set(input.systematic[role].map(trialKeyId)),
      excludedKinds(input.finished[role]),
    );
  const runs: PerRole<RunTally> = {
    baseline: runTally('baseline'),
    candidate: runTally('candidate'),
  };
  const excludedOf = (tallied: RunTally, id: string): ExcludedCounts =>
    tallied.excluded.get(id) ?? { transient: 0, adapter: 0 };
  const order = new Map(input.rules.map((rule, index) => [rule.id, index]));
  const keys = new Map([...runs.baseline.keys, ...runs.candidate.keys]);
  return [...keys.values()].sort(compareKeys(order)).map((key) => {
    const id = cellId(key);
    const perCase = {
      baseline: runs.baseline.counts.get(id) ?? new Map<string, MutableCounts>(),
      candidate: runs.candidate.counts.get(id) ?? new Map<string, MutableCounts>(),
    };
    const pairs: PairedCase[] = [];
    const pairedCaseIds = new Set<string>();
    let droppedCases = 0;
    for (const testCase of input.cases) {
      if (testCase.lang !== key.lang) {
        continue;
      }
      const baseline = perCase.baseline.get(testCase.id);
      const candidate = perCase.candidate.get(testCase.id);
      if (baseline !== undefined && candidate !== undefined) {
        pairs.push({ baseline: { ...baseline }, candidate: { ...candidate } });
        pairedCaseIds.add(testCase.id);
      } else if (baseline !== undefined || candidate !== undefined) {
        droppedCases += 1;
      }
    }
    const rule = rules.get(key.ruleId);
    return {
      ...key,
      margin: rule?.margin ?? input.gateMargin ?? DEFAULT_MARGIN,
      pairs,
      judgedTrials: {
        baseline: judgedTrialsOf(perCase.baseline),
        candidate: judgedTrialsOf(perCase.candidate),
      },
      droppedCases,
      ...(rule?.check.type === 'completed'
        ? {
            systematic: {
              baseline: systematicCounts(runs.baseline.systematic.get(id)),
              candidate: systematicCounts(runs.candidate.systematic.get(id)),
            },
            excluded: {
              baseline: excludedOf(runs.baseline, id),
              candidate: excludedOf(runs.candidate, id),
            },
          }
        : {}),
      ...(key.surface === 'raw'
        ? {
            masked: {
              baseline: maskedShare(runs.baseline, key.ruleId, pairedCaseIds),
              candidate: maskedShare(runs.candidate, key.ruleId, pairedCaseIds),
            },
          }
        : {}),
    };
  });
}

/** Verdict row 1: neither run has a judged trial in this cell. */
export function isNotApplicable(evidence: CellEvidence): boolean {
  return evidence.judgedTrials.baseline === 0 && evidence.judgedTrials.candidate === 0;
}

/** The case-weighted baseline `rate` over the K common cases, for the low-baseline check. */
export function baselineRate(evidence: CellEvidence): number | null {
  return evidence.pairs.length === 0
    ? null
    : caseWeightedRate(evidence.pairs.map((pair) => pair.baseline));
}

/** Candidate failure rate ÷ baseline failure rate; null when the baseline has no failure. */
function failRatio(baseline: Rate, candidate: Rate): number | null {
  if (baseline.rate === null || candidate.rate === null || baseline.passes === baseline.trials) {
    return null;
  }
  return (1 - candidate.rate) / (1 - baseline.rate);
}

/** The cell with its verdict; `needed` for undecided gated cells only. */
export function cellOf(evidence: CellEvidence, context: CellContext): Cell {
  const { ruleId, lang, surface, margin, pairs, judgedTrials, droppedCases } = evidence;
  const { gated, z, minCases, runCases } = context;
  const stats = judgeCell({ pairs, judgedTrials, gated, margin, minCases, z });
  const needed =
    gated && isUndecided(stats.verdict)
      ? trialsNeeded({ pairs, margin, minCases, z, runCases })
      : undefined;
  return {
    ruleId,
    lang,
    surface,
    gated,
    cases: pairs.length,
    droppedCases,
    ...(evidence.systematic === undefined ? {} : { systematic: evidence.systematic }),
    ...(evidence.excluded === undefined ? {} : { excluded: evidence.excluded }),
    baseline: stats.baseline,
    candidate: stats.candidate,
    diff: stats.diff === null ? null : { ...stats.diff },
    deff: stats.deff,
    failRatio: failRatio(stats.baseline, stats.candidate),
    ...(evidence.masked === undefined ? {} : { masked: evidence.masked }),
    margin,
    verdict: stats.verdict,
    ...(needed === undefined ? {} : { needed }),
    ...(stats.note === undefined ? {} : { note: stats.note }),
  };
}

const pooledRate = ({ trials, passes }: MutableCounts) => ({
  trials,
  passes,
  rate: trials === 0 ? null : passes / trials,
});

/** Per rule and surface, the pooled rate over languages and its difference; no verdict. */
export function aggregates(cells: readonly Cell[]): Aggregate[] {
  const groups = new Map<
    string,
    { ruleId: string; surface: Surface; sides: PerRole<MutableCounts> }
  >();
  for (const cell of cells) {
    const id = `${cell.ruleId}\u0000${cell.surface}`;
    const group = groups.get(id) ?? {
      ruleId: cell.ruleId,
      surface: cell.surface,
      sides: { baseline: { trials: 0, passes: 0 }, candidate: { trials: 0, passes: 0 } },
    };
    for (const role of ['baseline', 'candidate'] as const) {
      group.sides[role].trials += cell[role].trials;
      group.sides[role].passes += cell[role].passes;
    }
    groups.set(id, group);
  }
  return [...groups.values()].map(({ ruleId, surface, sides }) => {
    const baseline = pooledRate(sides.baseline);
    const candidate = pooledRate(sides.candidate);
    return {
      ruleId,
      surface,
      baseline,
      candidate,
      diff:
        baseline.rate === null || candidate.rate === null ? null : candidate.rate - baseline.rate,
    };
  });
}
