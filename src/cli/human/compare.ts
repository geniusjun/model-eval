import type { Lang, Variant } from '../../config/schema.js';
import { isLowBaseline } from '../../compare/gate.js';
import {
  neededText,
  noteText,
  reasonText,
  verdictText,
  warningText,
} from '../../report/code-text.js';
import {
  dollars,
  factor,
  marginPoints,
  NONE,
  percent,
  percentInterval,
  points,
  pointsInterval,
  ratio,
  seconds,
} from '../../report/format.js';
import {
  opsRateNames,
  type Cell,
  type Comparison,
  type GateReason,
  type MetricRate,
  type Needed,
  type OpsChange,
  type Summary,
} from '../../report/schema.js';
import type { Warning, WarningCode } from '../../run/warning.js';
import { nMin } from '../../stats/verdict.js';
import type { GradeSet } from '../../grade/grade-set.js';
import type { GradeOutcome } from '../../grade/record.js';
import type { Manifest } from '../../run/manifest.js';
import {
  aligned,
  INDENT,
  labelled,
  plainLines,
  redactedLines,
  type Align,
  type HumanLine,
  type Layout,
} from './layout.js';
import { placeLabel, quote, textOf, withPlace, type Text } from './text.js';

// Human output of a Comparison (contracts/cli.md §Human Output), shared by `compare` and `swap`,
// and the lines of `grade` and `report`. Comparison text is redacted already.

type SummaryCell = Summary['worse'][number];
type Rates = Comparison['ops']['baseline']['rates'];
type RateName = keyof Rates;
/** Rates the operations table always shows; the others only when either variant has one. */
const MAIN_RATES: readonly RateName[] = [
  'rejection',
  'timeout',
  'transient',
  'discard',
  'fallback',
];
/** Warnings the operations table marks on their own row. */
const OPS_WARNINGS: ReadonlySet<WarningCode> = new Set([
  'discard-rate-increase',
  'regeneration-rate-increase',
  'latency-p95-ratio',
  'cost-ratio',
]);
const ROLES = ['baseline', 'candidate'] as const;
const EXCLUDED_KINDS = ['transient', 'adapter'] as const;
/**
 * A gated cell row as contracts/cli.md shows it: the mark, then labelled values (`base 99.3%`)
 * one space from their label, with rates, the difference, its interval and the margin aligned
 * right.
 */
const GATED_ROW_LAYOUT: Layout = {
  align: [
    ...Array.from({ length: 6 }, (): Align => 'left'),
    'right',
    'left',
    'right',
    'left',
    'right',
    'right',
    'left',
    'right',
  ],
  gaps: [0, 1, 2, 2, 2, 2, 1, 2, 1, 2, 1, 1, 2, 1],
  indent: '',
};
/** The operations table: names under the heading, one space to the baseline column. */
const OPS_LAYOUT: Layout = { gaps: [0, 1, 4, 2], indent: '' };
const REFERENCE_LAYOUT: Layout = {
  align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
};
const UNDECIDED_VERDICTS: ReadonlySet<Cell['verdict']> = new Set([
  'inconclusive',
  'insufficient',
  'not-applicable',
]);

export function variantLabel(variant: Pick<Variant, 'id' | 'model'>): string {
  return `${variant.id} (${variant.model})`;
}

export function ordinal(t: Text, n: number): string {
  const category = new Intl.PluralRules(t.lang, { type: 'ordinal' }).select(n);
  switch (category) {
    case 'one':
    case 'two':
    case 'few':
      return t(`human.ordinal.${category}`, { n });
    default:
      return t('human.ordinal.other', { n });
  }
}

export function warningLines(t: Text, warnings: readonly Warning[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  return [
    '',
    t('report.warnings'),
    ...warnings.map(
      (warning) =>
        `${INDENT}${withPlace(placeLabel(warning), warningText(t.lang, warning, quote))}`,
    ),
  ];
}

// The comparison

function cellLabel(cell: Pick<Cell, 'ruleId' | 'lang' | 'surface'>): string {
  return `${cell.ruleId} (${cell.lang}, ${cell.surface})`;
}

function findCell(comparison: Comparison, key: SummaryCell): Cell | undefined {
  return comparison.cells.find(
    (cell) => cell.ruleId === key.ruleId && cell.lang === key.lang && cell.surface === key.surface,
  );
}

function shortNeeded(t: Text, needed: Needed): string {
  switch (needed.kind) {
    case 'repeats':
      return t('human.needed.repeats', { repeats: needed.repeats });
    case 'cases':
      return t('human.needed.cases', { cases: needed.cases });
    case 'on-margin':
      return t('needed.on-margin');
  }
}

function changedEntry(t: Text, comparison: Comparison, entry: SummaryCell): string {
  const cell = findCell(comparison, entry);
  const parts = [
    cell === undefined
      ? cellLabel(entry)
      : `${cellLabel(entry)} ${percent(cell.baseline.rate)} → ${percent(cell.candidate.rate)}`,
  ];
  if (entry.verdict === 'regressed' && cell?.failRatio !== null && cell?.failRatio !== undefined) {
    parts.push(t('human.failures', { ratio: factor(cell.failRatio) }));
  }
  if (entry.note !== undefined) {
    parts.push(noteText(t.lang, entry.note));
  }
  return parts.join(', ');
}

function undecidedEntry(t: Text, entry: SummaryCell): string {
  const text =
    entry.needed === undefined ? verdictText(t.lang, entry.verdict) : shortNeeded(t, entry.needed);
  return `${cellLabel(entry)}: ${text}`;
}

const isRateMetric = (metric: OpsChange['metric']): metric is RateName =>
  opsRateNames.some((name) => name === metric);

/** Changes worth a line: a different rate, or a ratio other than 1. */
function opsSummary(t: Text, changes: readonly OpsChange[]): string[] {
  return changes.flatMap((change) => {
    const label = t(`human.opsChange.${change.metric}`);
    if (isRateMetric(change.metric)) {
      return change.baseline === change.candidate
        ? []
        : [`${label} ${percent(change.baseline)} → ${percent(change.candidate)}`];
    }
    return change.ratio === undefined || change.ratio === null || change.ratio === 1
      ? []
      : [`${label} ×${ratio(change.ratio)}`];
  });
}

function summaryLines(t: Text, comparison: Comparison): string[] {
  const { summary, rules } = comparison;
  const none = [t('report.none')];
  const orNone = (values: readonly string[]): readonly string[] =>
    values.length === 0 ? none : values;
  const ops = opsSummary(t, summary.ops);
  const scope = t('report.summaryScope', {
    targets: summary.scope.targets.length === 0 ? NONE : summary.scope.targets.join(', '),
    judged: summary.scope.judgedRules.length,
    total: rules.length,
    review: summary.scope.reviewRules.length,
  });
  return [
    t('human.summary'),
    ...labelled([
      [
        t('report.summary.worse'),
        orNone(summary.worse.map((entry) => changedEntry(t, comparison, entry))),
      ],
      [
        t('report.summary.improved'),
        orNone(summary.improved.map((entry) => changedEntry(t, comparison, entry))),
      ],
      [t('report.summary.unknown'), orNone(summary.unknown.map((e) => undecidedEntry(t, e)))],
      [t('report.summary.ops'), [ops.length === 0 ? t('report.none') : ops.join(' · ')]],
      [t('report.summary.scope'), [scope]],
    ]),
  ];
}

function maskedText(t: Text, cell: Cell): string | undefined {
  const masked = cell.masked;
  if (masked === undefined || masked.candidate === null || masked.candidate === 0) {
    return undefined;
  }
  return t('report.masked', {
    baseline: percent(masked.baseline),
    candidate: percent(masked.candidate),
  });
}

function gatedDetail(t: Text, cell: Cell): string {
  const parts: string[] = [];
  const masked = cell.verdict === 'regressed' ? maskedText(t, cell) : undefined;
  if (masked !== undefined) {
    parts.push(masked);
  } else if (cell.needed !== undefined) {
    parts.push(neededText(t.lang, cell.needed, cell.candidate.trials));
  }
  if (cell.note !== undefined) {
    parts.push(noteText(t.lang, cell.note));
  }
  parts.push(...excludedTexts(t, cell));
  const systematic = cell.systematic;
  if (systematic !== undefined && systematic.baseline.trials + systematic.candidate.trials > 0) {
    parts.push(
      t('report.systematic', {
        baseline: systematic.baseline.trials,
        candidate: systematic.candidate.trials,
      }),
    );
  }
  return parts.join(' · ');
}

/** `15 candidate transient errors excluded (no systematic failure)`, per variant and kind. */
function excludedTexts(t: Text, cell: Cell): string[] {
  const { excluded } = cell;
  if (excluded === undefined) {
    return [];
  }
  return ROLES.flatMap((role) =>
    EXCLUDED_KINDS.flatMap((kind) => {
      const count = excluded[role][kind];
      if (count === 0) {
        return [];
      }
      const variant = t(`human.role.${role}`);
      return [
        count === 1
          ? t(`human.excluded.${kind}.one`, { variant })
          : t(`human.excluded.${kind}.other`, { count, variant }),
      ];
    }),
  );
}

/**
 * The verdict, and for verdict row 7 (too few effective trials, with enough cases) the trials
 * per variant against n_min (data-model §Statistics).
 */
function verdictLabel(t: Text, comparison: Comparison, cell: Cell): string {
  const verdict = verdictText(t.lang, cell.verdict);
  const { baseline, candidate } = cell;
  const enoughCases = cell.cases >= Math.max(3, comparison.stats.minCases);
  if (
    cell.verdict !== 'insufficient' ||
    !enoughCases ||
    baseline.nEff === null ||
    candidate.nEff === null
  ) {
    return verdict;
  }
  const trials = Math.floor(Math.min(baseline.nEff, candidate.nEff));
  const needed = nMin(cell.margin, comparison.stats.zLower);
  return trials < needed
    ? `${verdict} ${t('human.tooFewTrials', { trials, nMin: needed })}`
    : verdict;
}

function diffColumns(cell: Cell): [string, string] {
  return cell.diff === null
    ? [NONE, '']
    : [points(cell.diff.estimate), pointsInterval(cell.diff.low, cell.diff.high)];
}

function gateLines(t: Text, comparison: Comparison): string[] {
  const { gate, cells } = comparison;
  const severity = new Map(comparison.rules.map((rule) => [rule.id, rule.severity]));
  const gated = cells.filter((cell) => cell.gated);
  const blocked = gated.filter((cell) => cell.verdict === 'regressed');
  const undecided = gated.filter((cell) => UNDECIDED_VERDICTS.has(cell.verdict));
  const held = gated.filter(
    (cell) => cell.verdict === 'non-inferior' || cell.verdict === 'improved',
  );
  const shownHeld = held.filter((cell) => gatedDetail(t, cell) !== '');
  const row = (mark: string, cell: Cell): string[] => [
    mark,
    cell.ruleId,
    cell.lang,
    cell.surface,
    severity.get(cell.ruleId) ?? '',
    t('human.base'),
    percent(cell.baseline.rate),
    t('human.cand'),
    percent(cell.candidate.rate),
    t('human.diff'),
    ...diffColumns(cell),
    t('human.margin'),
    marginPoints(cell.margin),
    verdictLabel(t, comparison, cell),
    gatedDetail(t, cell),
  ];
  const rows = [
    ...blocked.map((cell) => row('✗', cell)),
    ...undecided.map((cell) => row('?', cell)),
    ...shownHeld.map((cell) => row('✓', cell)),
  ];
  const reasons = gate.reasons.filter(
    (reason: GateReason) => reason.code !== 'regressed' && reason.code !== 'cell-undecided',
  );
  return [
    t('human.gate', {
      cells: gated.length,
      blocked: blocked.length,
      undecided: undecided.length,
      held: held.length,
      outcome: t(`report.outcome.${gate.outcome}`),
    }),
    ...reasons.map(
      (reason) => `${INDENT}${withPlace(placeLabel(reason), reasonText(t.lang, reason, quote))}`,
    ),
    ...(rows.length === 0 ? [] : ['', ...aligned(rows, GATED_ROW_LAYOUT)]),
    ...(held.length > shownHeld.length
      ? [`${INDENT}${t('human.moreHeld', { count: held.length - shownHeld.length })}`]
      : []),
  ];
}

function referenceLines(t: Text, comparison: Comparison): string[] {
  const severity = new Map(comparison.rules.map((rule) => [rule.id, rule.severity]));
  const level = comparison.config.report.lowBaseline;
  const reference = comparison.cells.filter(
    (cell) => !cell.gated && cell.verdict !== 'not-applicable' && !isLowBaseline(cell, level),
  );
  const low = comparison.cells.filter((cell) => isLowBaseline(cell, level));
  const lines: string[] = [];
  if (reference.length > 0) {
    lines.push(
      '',
      t('human.notGated'),
      ...aligned(
        reference.map((cell) => [
          cell.ruleId,
          cell.lang,
          cell.surface,
          severity.get(cell.ruleId) ?? '',
          `${percent(cell.baseline.rate)} → ${percent(cell.candidate.rate)}`,
          ...diffColumns(cell),
          verdictLabel(t, comparison, cell),
          cell.note === undefined ? '' : noteText(t.lang, cell.note),
        ]),
        REFERENCE_LAYOUT,
      ),
    );
  }
  if (low.length > 0) {
    lines.push(
      '',
      t('human.lowBaseline', { level: percent(level) }),
      ...aligned(
        low.map((cell) => [
          cell.ruleId,
          cell.lang,
          cell.surface,
          `${t('human.base')} ${percent(cell.baseline.rate)}`,
          `${t('human.cand')} ${percent(cell.candidate.rate)}`,
        ]),
      ),
    );
  }
  const review = comparison.scope.reviewRules.length;
  if (review > 0) {
    lines.push(t('human.sideBySide', { count: review }));
  }
  return lines;
}

function rateCell(rate: MetricRate): string {
  const interval = percentInterval(rate.low, rate.high);
  return interval === '' ? percent(rate.rate) : `${percent(rate.rate)} ${interval}`;
}

function withRatio(value: string, change: OpsChange | undefined): string {
  return change?.ratio === undefined || change.ratio === null
    ? value
    : `${value} (×${ratio(change.ratio)})`;
}

function opsWarning(t: Text, comparison: Comparison, change: OpsChange | undefined): string {
  const { warn } = comparison.config.report;
  switch (change?.warning) {
    case undefined:
      return '';
    case 'discard-rate-increase':
    case 'regeneration-rate-increase':
      return t('human.opsWarning.increase');
    case 'latency-p95-ratio':
      return t('human.opsWarning.ratio', { threshold: factor(warn.latencyP95Ratio) });
    case 'cost-ratio':
      return t('human.opsWarning.ratio', { threshold: factor(warn.costRatio) });
  }
}

function opsLines(t: Text, comparison: Comparison): string[] {
  const { baseline, candidate } = comparison.ops;
  const change = (metric: OpsChange['metric']) =>
    comparison.summary.ops.find((entry) => entry.metric === metric);
  const names = opsRateNames.filter(
    (name) =>
      MAIN_RATES.includes(name) ||
      baseline.rates[name].count > 0 ||
      candidate.rates[name].count > 0,
  );
  const body = [
    ...names.map((name) => [
      t(`human.ops.${name}`),
      rateCell(baseline.rates[name]),
      rateCell(candidate.rates[name]),
      opsWarning(t, comparison, change(name)),
    ]),
    [
      t('human.ops.latencyP95'),
      seconds(baseline.latencyMs.p95),
      withRatio(seconds(candidate.latencyMs.p95), change('latencyP95')),
      opsWarning(t, comparison, change('latencyP95')),
    ],
    [
      t('human.ops.costPerTrial'),
      dollars(baseline.costPerTrialUsd),
      withRatio(dollars(candidate.costPerTrialUsd), change('costPerTrial')),
      opsWarning(t, comparison, change('costPerTrial')),
    ],
  ];
  // The heading starts where the indented metric names do, as in contracts/cli.md.
  const rows = [
    [t('report.summary.ops'), t('report.role.baseline'), t('report.role.candidate'), ''],
    ...body.map(([label = '', ...values]) => [`${INDENT}${label}`, ...values]),
  ];
  return ['', ...aligned(rows, OPS_LAYOUT), `${INDENT}${t('human.opsNote')}`];
}

/** Variants whose adapter declares no post-processing ship their raw answer (FR-029). */
function postprocessLines(t: Text, comparison: Comparison): string[] {
  const notices = ROLES.flatMap((role) =>
    comparison[role].postprocess
      ? []
      : [t('report.noPostprocess', { variant: comparison[role].variant.id })],
  );
  return notices.length === 0 ? [] : ['', ...notices];
}

function comparisonLines(t: Text, comparison: Comparison): string[] {
  return [
    ...summaryLines(t, comparison),
    '',
    ...gateLines(t, comparison),
    ...referenceLines(t, comparison),
    ...opsLines(t, comparison),
    ...postprocessLines(t, comparison),
  ];
}

export interface ComparedView {
  readonly comparison: Comparison;
  /** The comparison's warnings, redacted with it. */
  readonly warnings: readonly Warning[];
  /** Where `report.md` was written, as the user should see it. */
  readonly reportPath?: string | undefined;
}

/** The comparison, the warnings the operations table does not show, and where the report is. */
export function comparedLines(t: Text, view: ComparedView): HumanLine[] {
  const warnings = view.warnings.filter((warning) => !OPS_WARNINGS.has(warning.code));
  return [
    ...redactedLines([...comparisonLines(t, view.comparison), ...warningLines(t, warnings)]),
    ...(view.reportPath === undefined
      ? []
      : plainLines(['', t('human.report', { path: view.reportPath })])),
  ];
}

// grade, compare and report

export function compareLines(lang: Lang, view: ComparedView): HumanLine[] {
  const t = textOf(lang);
  const { baseline, candidate, coverage, priorComparisons } = view.comparison;
  const leftOut =
    coverage.baselineOnly.length + coverage.candidateOnly.length + coverage.changedHash.length;
  return [
    ...plainLines([
      t('human.compare.header', {
        baseline: variantLabel(baseline.variant),
        candidate: variantLabel(candidate.variant),
        cases: coverage.commonCases,
      }),
      t('human.compare.id', {
        baselineRunId: baseline.runId,
        candidateRunId: candidate.runId,
        ordinal: ordinal(t, priorComparisons + 1),
      }),
      ...(leftOut === 0
        ? []
        : [
            t('human.compare.leftOut', {
              baselineOnly: coverage.baselineOnly.length,
              candidateOnly: coverage.candidateOnly.length,
              changed: coverage.changedHash.length,
            }),
          ]),
      '',
    ]),
    ...comparedLines(t, view),
  ];
}

export interface GradeView {
  readonly manifest: Manifest;
  readonly gradeSet: GradeSet;
  readonly reused: boolean;
}

export function gradeLines(lang: Lang, view: GradeView): string[] {
  const t = textOf(lang);
  const { manifest, gradeSet } = view;
  const count = (outcome: GradeOutcome) =>
    gradeSet.grades.filter((grade) => grade.outcome === outcome).length;
  const { gradeSetId } = gradeSet.header;
  return [
    t('human.grade.header', {
      variant: variantLabel(manifest.variant),
      runId: manifest.runId,
      status: manifest.status,
    }),
    view.reused
      ? t('human.grade.reused', { gradeSetId })
      : t('human.grade.written', { gradeSetId }),
    t('human.grade.outcomes', {
      grades: gradeSet.grades.length,
      pass: count('pass'),
      fail: count('fail'),
      skip: count('skip'),
      error: count('error'),
    }),
  ];
}

export interface ReportView {
  readonly comparison: Comparison;
  /** Where `report.md` was written, as the user should see it. */
  readonly reportPath: string;
}

export function reportLines(lang: Lang, view: ReportView): string[] {
  const t = textOf(lang);
  const { comparisonId, baseline, candidate } = view.comparison;
  return [
    t('human.report.header', {
      comparisonId,
      baseline: variantLabel(baseline.variant),
      candidate: variantLabel(candidate.variant),
    }),
    t('human.report', { path: view.reportPath }),
  ];
}
