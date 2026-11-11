import type { z } from 'zod';

import { LOSSES_IN_A_ROW, type AdapterFault } from '../../adapter/client.js';
import type { Diagnostic, LintFinding } from '../../config/diagnostics.js';
import type { Lang, Variant } from '../../config/schema.js';
import { message } from '../../messages/index.js';
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
import { isLowBaseline } from '../../compare/gate.js';
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
import type { RunEnd } from '../../run/active-run.js';
import type { Manifest, StopReason } from '../../run/manifest.js';
import { priceFor } from '../../run/cost.js';
import type { OverBudget, RunStartFailure } from '../../run/runner.js';
import type { SwapEnd } from '../../run/swap.js';
import type { Warning, WarningCode } from '../../run/warning.js';
import { nMin } from '../../stats/verdict.js';
import type { dryRunPlanSchema } from '../results.js';
import {
  lintText,
  placeLabel,
  positionLabel,
  quote,
  textOf,
  withPlace,
  type Text,
} from './text.js';

// Human output of `run` and `swap` (contracts/cli.md §Human Output): plain lines for stdout and
// stderr, built from the records and the Comparison alone; the Output layer redacts them.

type DryRunPlan = z.infer<typeof dryRunPlanSchema>;
type SummaryCell = Summary['worse'][number];
type Rates = Comparison['ops']['baseline']['rates'];
type RateName = keyof Rates;
type Align = 'left' | 'right';

const INDENT = '  ';
const GAP = 2;
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
const COST_STOPS: ReadonlySet<StopReason> = new Set(['budget', 'budget-projected']);
const CONFIG_MESSAGES_SHOWN = 3;
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

/** Hangul, kana, Han and full-width forms take two terminal columns. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE.test(character) ? 2 : 1;
  }
  return width;
}

interface Layout {
  readonly align?: readonly Align[];
  /** Spaces before each column; two where it gives none. */
  readonly gaps?: readonly number[];
  readonly indent?: string;
}

/** Pads every column but the last to its widest cell, in terminal columns. */
function aligned(
  rows: readonly (readonly string[])[],
  { align = [], gaps = [], indent = INDENT }: Layout = {},
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, column) => {
      const padding = ' '.repeat((widths[column] ?? 0) - displayWidth(cell));
      const gap = column === 0 ? '' : ' '.repeat(gaps[column] ?? GAP);
      if (align[column] === 'right') {
        return `${gap}${padding}${cell}`;
      }
      return column === row.length - 1 ? `${gap}${cell}` : `${gap}${cell}${padding}`;
    });
    return `${indent}${cells.join('')}`.trimEnd();
  });
}

/** A label column whose later lines are blank: `Worse  a` / `       b`. */
function labelled(entries: readonly (readonly [string, readonly string[]])[]): string[] {
  return aligned(
    entries.flatMap(([label, values]) =>
      values.map((value, index): readonly string[] => [index === 0 ? label : '', value]),
    ),
    { gaps: [0, 3] },
  );
}

function variantLabel(variant: Pick<Variant, 'id' | 'model'>): string {
  return `${variant.id} (${variant.model})`;
}

/** `ko, ja × 3` when every language has as many cases, else `ko × 3, ja × 2`. */
function languagesText(cases: Manifest['cases']): string {
  const counts = new Map<string, number>();
  for (const runCase of cases) {
    counts.set(runCase.lang, (counts.get(runCase.lang) ?? 0) + 1);
  }
  const values = [...counts.values()];
  const [first] = values;
  if (first !== undefined && values.every((value) => value === first)) {
    return `${[...counts.keys()].join(', ')} × ${String(first)}`;
  }
  return [...counts].map(([lang, count]) => `${lang} × ${String(count)}`).join(', ');
}

function ordinal(t: Text, n: number): string {
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

// Findings before the start

/** Why the config, rule or case files cannot be used, one line per finding. */
export function diagnosticLines(lang: Lang, diagnostics: readonly Diagnostic[]): string[] {
  const t = textOf(lang);
  return [
    t('human.configInvalid', { count: diagnostics.length }),
    ...diagnostics.map(
      (finding) =>
        `${INDENT}${withPlace(positionLabel(finding), lintText(t, finding, finding.localDetail))}`,
    ),
  ];
}

/** `few-cases`, `margin-unreachable` and `conservative-over-budget`, raised once before sending. */
export function startWarningLines(
  lang: Lang,
  samplePlan: readonly LintFinding[],
  warnings: readonly Warning[],
): string[] {
  const t = textOf(lang);
  return [
    ...samplePlan.map((finding) => withPlace(placeLabel(finding), lintText(t, finding))),
    ...warnings.map((warning) => warningText(lang, warning, quote)),
  ].map((line) => t('human.warning', { text: line }));
}

/** Why a run did not start; every one is a configuration error named with its variant. */
export function startFailureLines(
  lang: Lang,
  variantId: string,
  failure: RunStartFailure,
): string[] {
  const t = textOf(lang);
  const variant = { variant: variantId };
  switch (failure.kind) {
    case 'unpriced-variant':
      return [t('human.start.unpriced-variant', { ...variant, model: failure.model })];
    case 'adapter':
      return [
        t('human.start.adapter', {
          ...variant,
          kind: failure.error.kind,
          message: quote(failure.error.message),
        }),
        ...stderrTailLines(t, variantId, failure.stderrTail),
      ];
    case 'cases':
      return failure.problems.map((problem) =>
        t(`human.start.${problem.cause}`, {
          ...variant,
          caseId: problem.caseId,
          target: problem.target,
        }),
      );
    case 'no-cases':
      return [
        failure.caseFilter === null
          ? t('human.start.no-cases', variant)
          : t('human.start.no-matching-cases', { ...variant, cases: failure.caseFilter }),
      ];
    case 'render':
      return failure.failures.map((item) =>
        item.cause === 'render'
          ? t('human.start.render', {
              ...variant,
              caseId: item.caseId,
              message: quote(item.message ?? ''),
            })
          : t('human.start.input-tokens', { ...variant, caseId: item.caseId }),
      );
    case 'lock':
      return [
        failure.refusal.reason === 'unreadable'
          ? t('human.start.lock-unreadable', { ...variant, path: failure.refusal.path })
          : t('human.start.lock-held', {
              ...variant,
              path: failure.refusal.path,
              pid: failure.refusal.owner.pid,
              host: failure.refusal.owner.host,
            }),
      ];
  }
}

// The adapter

function stderrTailLines(t: Text, variantId: string, tail: readonly string[]): string[] {
  return tail.length === 0
    ? []
    : [
        t('human.adapter.stderrTail', { variant: variantId, count: tail.length }),
        ...tail.map((line) => `${INDENT}${line}`),
      ];
}

/** A restart of the adapter, or the fault that stops its run, shown when it happens. */
export function adapterFaultLines(lang: Lang, variantId: string, fault: AdapterFault): string[] {
  const t = textOf(lang);
  const variant = { variant: variantId };
  switch (fault.kind) {
    case 'restarted':
      return [];
    case 'restarting':
      return [t('human.adapter.restarting', { ...variant, message: quote(fault.message) })];
    case 'crashed':
      return [
        t('human.adapter.crashed', {
          ...variant,
          count: LOSSES_IN_A_ROW,
          message: quote(fault.message),
        }),
      ];
    case 'restart-failed':
      return [
        t('human.adapter.restartFailed', {
          ...variant,
          kind: fault.error.kind,
          message: quote(fault.error.message),
        }),
      ];
    case 'restart-changed':
      return [
        t('human.adapter.restartChanged', { ...variant, fields: fault.changes.join(', ') }),
        ...(fault.changes.includes('service') ? [t('human.adapter.serviceChanged')] : []),
      ];
  }
}

/**
 * At the end of the runs: the stderr tail of each run its adapter stopped, and each run's `warn`
 * and `error` logs grouped by message (adapter-protocol §Transport 3, §`log`).
 */
export function adapterEndLines(lang: Lang, runs: readonly RunEnd[]): string[] {
  const t = textOf(lang);
  return runs.flatMap(({ manifest, adapterFailure, adapterLogs }) => {
    const variant = manifest.variant.id;
    const logs =
      adapterLogs.length === 0
        ? []
        : [
            t('human.adapter.logs', { variant }),
            ...adapterLogs.map(
              (group) =>
                `${INDENT}${t('human.adapter.logGroup', {
                  level: group.level,
                  count: group.count,
                  message: group.message,
                })}`,
            ),
          ];
    return [...stderrTailLines(t, variant, adapterFailure?.stderrTail ?? []), ...logs];
  });
}

// The plan of --dry-run and of a refused start

export function planLines(
  lang: Lang,
  variants: readonly Pick<Variant, 'id' | 'model'>[],
  plan: DryRunPlan,
): string[] {
  const t = textOf(lang);
  const basisText = (basis: Readonly<Record<string, string>>): string =>
    Object.entries(basis)
      .map(([key, value]) => `${key} ${value}`)
      .join(', ');
  const cells =
    plan.cells.length === 0
      ? [t('human.plan.noCells')]
      : [
          t('human.plan.cells'),
          ...aligned(
            plan.cells.map((cell) => [
              cell.ruleId,
              cell.lang,
              cell.surface,
              t('human.plan.cell', { plannedTrials: cell.plannedTrials, nMin: cell.nMin }),
            ]),
          ),
        ];
  return [
    t('human.plan.header', { variants: variants.map(variantLabel).join(' → ') }),
    ...aligned(
      plan.variants.map((entry) => [
        entry.variant,
        t('human.plan.variant', {
          trials: entry.trials,
          calls: entry.calls,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          reservation: dollars(entry.reservationUsd),
          basis: basisText(entry.basis),
        }),
      ]),
    ),
    `${INDENT}${t('human.plan.costs', {
      expected: dollars(plan.expectedUsd),
      conservative: dollars(plan.conservativeUsd),
      cap: plan.maxCostUsd === null ? t('human.noCap') : dollars(plan.maxCostUsd),
    })}`,
    '',
    ...cells,
  ];
}

export function overBudgetLine(lang: Lang, refusal: OverBudget): string {
  return message(lang, 'human.overBudget', {
    expected: dollars(refusal.expectedUsd),
    cap: dollars(refusal.maxCostUsd),
  });
}

// Stops and outcomes

/**
 * What stopped a run on `config-error`: the messages of configuration failures, and calls to
 * models without a price while a cap is set.
 */
function configCauses(t: Text, runs: readonly RunEnd[]): string[] {
  const messages = new Set<string>();
  const unpriced = new Set<string>();
  for (const { lines, manifest } of runs) {
    for (const line of lines) {
      if ('status' in line && line.status === 'error' && line.error.kind === 'config') {
        messages.add(line.error.message);
      }
      const calls = 'calls' in line ? (line.calls ?? []) : [];
      for (const call of calls) {
        if (
          manifest.budget.maxCostUsd !== null &&
          priceFor(manifest.pricing, call.model).kind !== 'priced'
        ) {
          unpriced.add(call.model);
        }
      }
    }
  }
  return [
    ...[...messages]
      .slice(0, CONFIG_MESSAGES_SHOWN)
      .map((text) => `${INDENT}${t('human.configCause', { message: quote(text) })}`),
    ...(unpriced.size === 0
      ? []
      : [`${INDENT}${t('human.unpricedCalls', { models: [...unpriced].join(', ') })}`]),
  ];
}

/** The stop reason; `adapter-errors` reached by the loss limit says so, not the error rate. */
function stopText(t: Text, runs: readonly RunEnd[], reason: StopReason): string {
  const lossLimit = runs.some((run) => run.adapterFailure?.fault?.kind === 'crashed');
  return reason === 'adapter-errors' && lossLimit
    ? t('human.stop.adapter-restarts', { count: LOSSES_IN_A_ROW })
    : t(`human.stop.${reason}`);
}

/** The stop, what caused a `config-error`, and on a cost stop the outcomes so far (FR-011). */
function stoppedLines(t: Text, runs: readonly RunEnd[], reason: StopReason): string[] {
  const key = runs.length === 1 ? 'human.run.stopped' : 'human.stopped';
  const lines = [t(key, { reason: stopText(t, runs, reason) })];
  if (reason === 'config-error') {
    return [...lines, ...configCauses(t, runs)];
  }
  if (!COST_STOPS.has(reason)) {
    return lines;
  }
  return [...lines, t('human.outcomes'), ...outcomeRows(runs.map((run) => run.manifest))];
}

/** Per variant, the share of each outcome among its trials so far (FR-011 item 4). */
function outcomeRows(manifests: readonly Manifest[]): string[] {
  return aligned(
    manifests.map((manifest) => {
      const counts = Object.entries(manifest.totals.outcomes).filter(([, count]) => count > 0);
      const total = counts.reduce((sum, [, count]) => sum + count, 0);
      const shares = counts.map(
        ([outcome, count]) => `${outcome} ${percent(count / total)} (${String(count)})`,
      );
      return [manifest.variant.id, shares.length === 0 ? NONE : shares.join(' · ')];
    }),
  );
}

function warningLines(t: Text, warnings: readonly Warning[]): string[] {
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

// run and swap

interface Costs {
  readonly expectedUsd: number | null;
  readonly conservativeUsd: number | null;
}

function scaleParams(manifests: readonly Manifest[], spentUsd: number | null, costs: Costs) {
  const [first] = manifests;
  const cases = first?.cases ?? [];
  const repeats = first?.sampling.repeats ?? 0;
  return {
    cases: cases.length,
    languages: languagesText(cases),
    repeats,
    trials: manifests.reduce(
      (sum, manifest) => sum + manifest.cases.length * manifest.sampling.repeats,
      0,
    ),
    spent: dollars(spentUsd),
    expected: dollars(costs.expectedUsd),
    conservative: dollars(costs.conservativeUsd),
  };
}

export interface SwapView extends Costs {
  readonly end: SwapEnd;
  /**
   * The comparison's warnings, redacted with it, or both runs' warnings when the swap did not
   * compare.
   */
  readonly warnings: readonly Warning[];
  /** Where `report.md` was written, as the user should see it. */
  readonly reportPath?: string;
}

/**
 * A line of human output. `redacted` marks a line made from a Comparison, whose free text went
 * through the config's `redact` rules when it was built, so the output writes it as it is.
 */
export interface HumanLine {
  readonly text: string;
  readonly redacted: boolean;
}

const plainLines = (texts: readonly string[]): HumanLine[] =>
  texts.map((text) => ({ text, redacted: false }));

const redactedLines = (texts: readonly string[]): HumanLine[] =>
  texts.map((text) => ({ text, redacted: true }));

export function swapLines(lang: Lang, view: SwapView): HumanLine[] {
  const t = textOf(lang);
  const { end } = view;
  const manifests = [end.runs.baseline.manifest, end.runs.candidate.manifest];
  const { stopReason } = end.record;
  const { comparison } = end;
  const idLine =
    comparison === undefined
      ? t('human.swap.id', { swapId: end.record.swapId })
      : t('human.swap.idCompared', {
          swapId: end.record.swapId,
          ordinal: ordinal(t, comparison.priorComparisons + 1),
        });
  const head = plainLines([
    t('human.swap.header', {
      baseline: variantLabel(end.runs.baseline.manifest.variant),
      candidate: variantLabel(end.runs.candidate.manifest.variant),
      ...scaleParams(manifests, end.record.spentUsd, view),
    }),
    idLine,
    ...(stopReason === undefined
      ? []
      : ['', ...stoppedLines(t, [end.runs.baseline, end.runs.candidate], stopReason)]),
    '',
  ]);
  if (comparison === undefined) {
    return [
      ...head,
      ...plainLines([
        stopReason === 'config-error'
          ? t('human.noComparison.config-error')
          : t('human.noComparison.nothing-finished'),
        ...warningLines(t, view.warnings),
      ]),
    ];
  }
  return [
    ...head,
    ...redactedLines([
      ...comparisonLines(t, comparison),
      ...warningLines(
        t,
        view.warnings.filter((warning) => !OPS_WARNINGS.has(warning.code)),
      ),
    ]),
    ...(view.reportPath === undefined
      ? []
      : plainLines(['', t('human.report', { path: view.reportPath })])),
  ];
}

export interface RunView extends Costs {
  readonly end: RunEnd;
  readonly warnings: readonly Warning[];
}

export function runLines(lang: Lang, view: RunView): string[] {
  const t = textOf(lang);
  const { manifest } = view.end;
  return [
    t('human.run.header', {
      variant: variantLabel(manifest.variant),
      ...scaleParams([manifest], manifest.totals.costUsd, view),
    }),
    t('human.run.id', {
      runId: manifest.runId,
      status: manifest.status,
      gradeSetId: view.end.gradeSetId,
    }),
    ...(manifest.stopReason === undefined
      ? []
      : ['', ...stoppedLines(t, [view.end], manifest.stopReason)]),
    '',
    t('human.outcomes'),
    ...outcomeRows([manifest]),
    ...warningLines(t, view.warnings),
  ];
}
