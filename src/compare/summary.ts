import { compareCodeUnits } from '../adapter/canonical-json.js';
import { reviewSampleRepeats, type ReviewCheck } from '../checks/review.js';
import type { Case, Rule } from '../config/schema.js';
import { applicableRules } from '../grade/grade.js';
import type { Cell, OpsChange, Samples, SampleText, Scope, Summary } from '../report/schema.js';
import { trialKeyId } from '../run/ids.js';
import type { AttemptLine } from '../run/records.js';
import type { PerRole } from '../stats/interval.js';
import { cellId } from './cells.js';
import { keyOf, type CellTrials, type FailingTrial } from './gate.js';

// data-model §Comparison: the decision summary (FR-028) and `samples` (FR-020).

type SummaryCell = Summary['worse'][number];
type Role = keyof PerRole<unknown>;
type SampleKey = Samples['review'][number]['keys'][number];
type FailingKey = Samples['failing'][number]['keys'][number];

const ROLES: readonly Role[] = ['baseline', 'candidate'];

/**
 * Regressed cells and cells with a confirmed drop. Every drop note marks one: U < 0 with
 * K ≥ 3, or below 3 cases a clear drop (`clear-drop-too-few-cases`).
 */
export function isWorse(cell: Cell): boolean {
  return cell.verdict === 'regressed' || cell.note !== undefined;
}

export interface SummaryInput {
  readonly cells: readonly Cell[];
  /** The operational changes of the comparison, as `src/compare/ops.ts` lists them. */
  readonly ops: readonly OpsChange[];
  readonly scope: Scope;
}

/**
 * In the order of FR-028, each list in cell order. An undecided cell with a confirmed drop is in
 * both `worse` and `unknown`.
 */
export function decisionSummary({ cells, ops, scope }: SummaryInput): Summary {
  return {
    worse: cells.filter(isWorse).map(summaryCell),
    improved: cells.filter((cell) => cell.verdict === 'improved').map(summaryCell),
    unknown: cells.filter((cell) => cell.needed !== undefined).map(summaryCell),
    ops: [...ops],
    scope,
  };
}

function summaryCell(cell: Cell): SummaryCell {
  return {
    ...keyOf(cell),
    verdict: cell.verdict,
    ...(cell.note === undefined ? {} : { note: cell.note }),
    ...(cell.needed === undefined ? {} : { needed: cell.needed }),
  };
}

/**
 * Judged rules have a cell with a verdict other than `not-applicable`; `review` rules are never
 * judged and are listed apart. Rules keep their order.
 */
export function judgedScope(
  rules: readonly Rule[],
  targets: readonly string[],
  cells: readonly Cell[],
): Scope {
  const judged = new Set(
    cells.filter((cell) => cell.verdict !== 'not-applicable').map((cell) => cell.ruleId),
  );
  const graded = rules.filter((rule) => rule.check.type !== 'review');
  return {
    targets: [...targets],
    judgedRules: graded.filter((rule) => judged.has(rule.id)).map((rule) => rule.id),
    notJudgedRules: graded.filter((rule) => !judged.has(rule.id)).map((rule) => rule.id),
    reviewRules: rules.filter((rule) => rule.check.type === 'review').map((rule) => rule.id),
  };
}

/** A common, unchanged case with its current definition and language key. */
export interface ComparedCase {
  readonly definition: Case;
  readonly lang: string;
}

export interface SamplesInput {
  /** The active rules applicable to the compared targets. */
  readonly rules: readonly Rule[];
  readonly cases: readonly ComparedCase[];
  /** The effective attempt line of every trial on those cases. */
  readonly trials: PerRole<readonly AttemptLine[]>;
  readonly cells: readonly Cell[];
  readonly cellTrials: readonly CellTrials[];
  /** `report.samples`: failing examples per regressed cell. */
  readonly perCell: number;
}

/**
 * `review` samples of the same cases and repeats in both runs, and failing examples of regressed
 * cells next to the baseline's answer to the same case and repeat. Each text is stored once.
 */
export function comparisonSamples(input: SamplesInput): Samples {
  const finished = {
    baseline: finishedTrials(input.trials.baseline),
    candidate: finishedTrials(input.trials.candidate),
  };
  const review = input.rules.flatMap((rule) =>
    rule.check.type === 'review'
      ? [{ ruleId: rule.id, keys: reviewKeys(rule, rule.check, input.cases, finished) }]
      : [],
  );
  const trials = new Map(input.cellTrials.map((entry) => [cellId(entry), entry]));
  const failing = input.cells
    .filter((cell) => cell.verdict === 'regressed')
    .map((cell) => ({
      ...keyOf(cell),
      keys: failingKeys(trials.get(cellId(cell))?.candidateFailures ?? [], input.perCell),
    }));
  const referenced = [
    ...review.flatMap((entry) => entry.keys),
    ...failing.flatMap((entry) =>
      entry.keys.flatMap(({ caseId, repeat }) =>
        ROLES.map((variant): SampleKey => ({ variant, caseId, repeat })),
      ),
    ),
  ];
  return { texts: sampleTexts(referenced, finished), review, failing };
}

type FinishedLine = Exclude<AttemptLine, { status: 'stopped' }>;
type FinishedTrials = ReadonlyMap<string, FinishedLine>;

/** `stopped` attempts are not finished and carry no text. */
function finishedTrials(lines: readonly AttemptLine[]): FinishedTrials {
  const byKey = new Map<string, FinishedLine>();
  for (const line of lines) {
    if (line.status !== 'stopped') {
      byKey.set(trialKeyId(line), line);
    }
  }
  return byKey;
}

/** Per case, the lowest repeats either run finished, so both sides show the same repeat. */
function reviewKeys(
  rule: Rule,
  check: ReviewCheck,
  cases: readonly ComparedCase[],
  finished: PerRole<FinishedTrials>,
): SampleKey[] {
  return cases
    .filter(({ definition, lang }) => applicableRules([rule], definition, lang).length > 0)
    .map(({ definition }) => definition.id)
    .sort(compareCodeUnits)
    .flatMap((caseId) => {
      const repeats = ROLES.flatMap((role) =>
        [...finished[role].values()]
          .filter((line) => line.caseId === caseId)
          .map((line) => line.repeat),
      );
      return reviewSampleRepeats(check, repeats).flatMap((repeat) =>
        ROLES.filter((role) => finished[role].has(trialKeyId({ caseId, repeat }))).map(
          (variant): SampleKey => ({ variant, caseId, repeat }),
        ),
      );
    });
}

/** Up to `perCell` failures, sorted by case and repeat and taken round-robin across cases. */
function failingKeys(failures: readonly FailingTrial[], perCell: number): FailingKey[] {
  const seen = new Map<string, number>();
  const picked = [...failures]
    .sort((a, b) => compareCodeUnits(a.caseId, b.caseId) || a.repeat - b.repeat)
    .map((failure) => {
      const round = seen.get(failure.caseId) ?? 0;
      seen.set(failure.caseId, round + 1);
      return { failure, round };
    })
    // A stable sort by round keeps case order within each round.
    .sort((a, b) => a.round - b.round)
    .slice(0, perCell)
    .map(({ failure }) => failure);
  return picked.map(({ caseId, repeat, evidence }) => ({
    variant: 'candidate',
    caseId,
    repeat,
    ...(evidence === undefined || evidence.length === 0 ? {} : { evidence: [...evidence] }),
  }));
}

/** One text per referenced (variant, case, repeat) that has a finished trial, sorted by key. */
function sampleTexts(keys: readonly SampleKey[], finished: PerRole<FinishedTrials>): SampleText[] {
  const unique = new Map(keys.map((key) => [`${key.variant}:${trialKeyId(key)}`, key]));
  return [...unique.values()]
    .sort(
      (a, b) =>
        compareCodeUnits(a.caseId, b.caseId) ||
        a.repeat - b.repeat ||
        ROLES.indexOf(a.variant) - ROLES.indexOf(b.variant),
    )
    .flatMap((key) => {
      const line = finished[key.variant].get(trialKeyId(key));
      return line === undefined ? [] : [sampleText(key, line)];
    });
}

/** Error trials carry their kind and message instead of texts. */
function sampleText(key: SampleKey, line: FinishedLine): SampleText {
  if (line.status === 'error') {
    return { ...key, error: { kind: line.error.kind, message: line.error.message } };
  }
  return {
    ...key,
    raw: line.raw,
    finalKind: line.finalKind,
    ...(line.finalKind === 'discarded' ? {} : { final: line.final }),
    finishReason: line.finishReason,
  };
}
