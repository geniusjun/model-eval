import { isLowBaseline } from '../compare/gate.js';
import type { Lang } from '../config/schema.js';
import { countedKey, message, type MessageKey, type MessageParams } from '../messages/index.js';
import type { Warning } from '../run/warning.js';
import { neededText, noteText, reasonText, verdictText, warningText } from './code-text.js';
import { COMPARISON_FILE } from './layout.js';
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
  tokenMean,
} from './format.js';
import {
  opsRateNames,
  type Cell,
  type Comparison,
  type MetricRate,
  type OpsChange,
  type Rate,
  type RuleSummary,
  type SampleText,
  type Summary,
} from './schema.js';

type SummaryCell = Summary['worse'][number];

/*
 * report.md (spec FR-029), read from the Comparison alone. Text from the adapter, the model or
 * the service, and free text from the rule files, sits in a code span or block whose fence is
 * longer than any backtick run inside, so mentions, links and HTML in it never render when the
 * report is posted as a pull request comment (data-model §Comparison).
 */

type Role = 'baseline' | 'candidate';
const ROLES: readonly Role[] = ['baseline', 'candidate'];

interface Place {
  readonly ruleId?: string | undefined;
  readonly lang?: string | undefined;
  readonly surface?: string | undefined;
}

interface CellKey {
  readonly ruleId: string;
  readonly lang: string;
  readonly surface: string;
}

/**
 * Where readers find the side-by-side `review` samples: the result page when one is written
 * beside `report.md`, else `samples.review` in `comparison.json` (data-model §Comparison).
 */
export type ReviewSamplesAt = 'result-page' | 'comparison-json';

interface Context {
  readonly comparison: Comparison;
  readonly lang: Lang;
  readonly text: (key: MessageKey, params?: MessageParams) => string;
  readonly reviewSamplesAt: ReviewSamplesAt;
}

function reviewSamplesText(ctx: Context): string {
  return ctx.text(`report.reviewSamples.${ctx.reviewSamplesAt}`, {
    field: codeSpan('samples.review'),
    file: codeSpan(COMPARISON_FILE),
  });
}

// Markdown primitives

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) {
    longest = Math.max(longest, run[0].length);
  }
  return longest;
}

/**
 * A code span shows its content on one line, so line breaks become spaces, as CommonMark
 * renders them anyway; a blank line would otherwise end the paragraph inside the span. Content
 * that starts or ends with a backtick or a space gets one padding space on each side, the one
 * CommonMark strips; an empty text becomes a single space, since a span cannot be empty.
 */
function codeSpan(text: string): string {
  const line = text.replace(/\r\n|\r|\n/g, ' ');
  const fence = '`'.repeat(longestBacktickRun(line) + 1);
  if (line.trim() === '') {
    return `${fence}${line === '' ? ' ' : line}${fence}`;
  }
  return /^[ `]|[ `]$/.test(line) ? `${fence} ${line} ${fence}` : `${fence}${line}${fence}`;
}

function codeBlock(text: string, info = ''): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

/** A `|` inside a cell, also one from a case's language key, is escaped so it adds no column. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function list(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

function blocks(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('\n\n');
}

// Shared pieces

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** `script-ja (ja, raw)`, or as much of it as a warning or gate reason names. */
function placeLabel(place: Place): string | undefined {
  const where = [place.lang, place.surface].filter(isDefined).join(', ');
  const parts = [place.ruleId, where === '' ? undefined : `(${where})`].filter(isDefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

function cellLabel(key: CellKey): string {
  return `${key.ruleId} (${key.lang}, ${key.surface})`;
}

function labelled(label: string | undefined, text: string): string {
  return label === undefined ? text : `${label}: ${text}`;
}

function findCell(ctx: Context, key: CellKey): Cell | undefined {
  return ctx.comparison.cells.find(
    (cell) => cell.ruleId === key.ruleId && cell.lang === key.lang && cell.surface === key.surface,
  );
}

function rateText(rate: Pick<Rate, 'rate' | 'low' | 'high'>): string {
  const interval = percentInterval(rate.low, rate.high);
  return interval === '' ? percent(rate.rate) : `${percent(rate.rate)} ${interval}`;
}

function failRatioText(ctx: Context, cell: Cell): string {
  if (cell.failRatio !== null) {
    return `×${factor(cell.failRatio)}`;
  }
  return cell.baseline.rate === 1 ? ctx.text('report.baselineZero') : NONE;
}

function idList(ctx: Context, ids: readonly string[]): string {
  return ids.length === 0 ? ctx.text('report.none') : ids.join(', ');
}

function variantId(ctx: Context, role: Role): string {
  return ctx.comparison[role].variant.id;
}

function heading(ctx: Context, key: MessageKey): string {
  return `## ${ctx.text(key)}`;
}

// 1. Decision summary and gate result

function gateLines(ctx: Context): string {
  const { gate, stats, priorComparisons } = ctx.comparison;
  const outcome = ctx.text(countedKey('report.gate', stats.gatedCells), {
    outcome: ctx.text(`report.outcome.${gate.outcome}`),
    cells: stats.gatedCells,
  });
  const reasons = gate.reasons.map((reason) =>
    labelled(placeLabel(reason), reasonText(ctx.lang, reason, codeSpan)),
  );
  const prior = ctx.text('report.priorComparisons', { count: priorComparisons });
  return blocks([outcome, list(reasons), prior]);
}

function summaryCellLine(ctx: Context, entry: SummaryCell, withNeeded: boolean): string {
  const cell = findCell(ctx, entry);
  const parts = [verdictText(ctx.lang, entry.verdict)];
  if (cell !== undefined) {
    parts.push(
      `${percent(cell.baseline.rate)} → ${percent(cell.candidate.rate)}`,
      failRatioText(ctx, cell),
    );
  }
  if (entry.note !== undefined) {
    parts.push(noteText(ctx.lang, entry.note));
  }
  if (withNeeded && entry.needed !== undefined) {
    parts.push(neededText(ctx.lang, entry.needed, cell?.candidate.trials ?? 0));
  }
  return `${cellLabel(entry)}: ${parts.join(' · ')}`;
}

function metricValue(change: OpsChange, value: number | null): string {
  switch (change.metric) {
    case 'latencyP95':
      return seconds(value);
    case 'costPerTrial':
      return dollars(value);
    default:
      return percent(value);
  }
}

function opsChangeLine(ctx: Context, change: OpsChange): string {
  const parts = [
    `${metricValue(change, change.baseline)} → ${metricValue(change, change.candidate)}`,
  ];
  if (change.ratio !== undefined && change.ratio !== null) {
    parts.push(`×${ratio(change.ratio)}`);
  }
  if (change.warning !== undefined) {
    parts.push(ctx.text('report.opsWarning', { code: change.warning }));
  }
  return `${ctx.text(`report.metric.${change.metric}`)}: ${parts.join(' · ')}`;
}

/** `Label: none`, or the label over a list of its items. */
function labelledList(ctx: Context, label: MessageKey, items: readonly string[]): string {
  return items.length === 0
    ? `${ctx.text(label)}: ${ctx.text('report.none')}`
    : `${ctx.text(label)}:\n\n${list(items)}`;
}

function summarySection(ctx: Context): string {
  const { summary, rules } = ctx.comparison;
  const scope = ctx.text('report.summaryScope', {
    targets: idList(ctx, summary.scope.targets),
    judged: summary.scope.judgedRules.length,
    total: rules.length,
    review: summary.scope.reviewRules.length,
    sideBySide: reviewSamplesText(ctx),
  });
  return blocks([
    heading(ctx, 'report.section.summary'),
    gateLines(ctx),
    labelledList(
      ctx,
      'report.summary.worse',
      summary.worse.map((entry) => summaryCellLine(ctx, entry, false)),
    ),
    labelledList(
      ctx,
      'report.summary.improved',
      summary.improved.map((entry) => summaryCellLine(ctx, entry, false)),
    ),
    labelledList(
      ctx,
      'report.summary.unknown',
      summary.unknown.map((entry) => summaryCellLine(ctx, entry, true)),
    ),
    labelledList(
      ctx,
      'report.summary.ops',
      summary.ops.map((change) => opsChangeLine(ctx, change)),
    ),
    `${ctx.text('report.summary.scope')}: ${scope}`,
  ]);
}

// 2. Cell table

function cellNotes(ctx: Context, cell: Cell): string {
  const notes = cell.note === undefined ? [] : [noteText(ctx.lang, cell.note)];
  if (cell.systematic !== undefined) {
    notes.push(
      ctx.text(countedKey('report.systematic', cell.systematic.candidate.trials), {
        baseline: cell.systematic.baseline.trials,
        candidate: cell.systematic.candidate.trials,
      }),
    );
  }
  return notes.join(' · ');
}

function cellsSection(ctx: Context): string {
  const { cells, aggregates } = ctx.comparison;
  const yes = ctx.text('report.yes');
  const cellTable = table(
    [
      ctx.text('report.column.rule'),
      ctx.text('report.column.lang'),
      ctx.text('report.column.surface'),
      ctx.text('report.column.gated'),
      ctx.text('report.column.cases'),
      ctx.text('report.column.baseline'),
      ctx.text('report.column.candidate'),
      ctx.text('report.column.difference'),
      ctx.text('report.column.failRatio'),
      ctx.text('report.column.margin'),
      ctx.text('report.column.verdict'),
      ctx.text('report.column.notes'),
    ],
    cells.map((cell) => [
      cell.ruleId,
      cell.lang,
      cell.surface,
      cell.gated ? yes : '',
      cell.droppedCases === 0
        ? String(cell.cases)
        : ctx.text('report.casesDropped', { cases: cell.cases, dropped: cell.droppedCases }),
      rateText(cell.baseline),
      rateText(cell.candidate),
      cell.diff === null
        ? NONE
        : `${points(cell.diff.estimate)} ${pointsInterval(cell.diff.low, cell.diff.high)}`,
      failRatioText(ctx, cell),
      marginPoints(cell.margin),
      verdictText(ctx.lang, cell.verdict),
      cellNotes(ctx, cell),
    ]),
  );
  const pooled = table(
    [
      ctx.text('report.column.rule'),
      ctx.text('report.column.surface'),
      ctx.text('report.column.baseline'),
      ctx.text('report.column.candidate'),
      ctx.text('report.column.difference'),
    ],
    aggregates.map((aggregate) => [
      aggregate.ruleId,
      aggregate.surface,
      `${percent(aggregate.baseline.rate)} (${ctx.text('report.countOf', { count: aggregate.baseline.passes, total: aggregate.baseline.trials })})`,
      `${percent(aggregate.candidate.rate)} (${ctx.text('report.countOf', { count: aggregate.candidate.passes, total: aggregate.candidate.trials })})`,
      aggregate.diff === null ? NONE : points(aggregate.diff),
    ]),
  );
  return blocks([
    heading(ctx, 'report.section.cells'),
    ctx.text('report.cellsIntro'),
    cellTable,
    ctx.text('report.pooledIntro'),
    pooled,
  ]);
}

// 3. Failing examples of regressed cells

function sampleText(ctx: Context, text: SampleText): string {
  if ('error' in text) {
    return blocks([
      ctx.text('report.sample.error', { kind: text.error.kind }),
      codeBlock(text.error.message),
    ]);
  }
  const final =
    text.final === undefined
      ? ctx.text('report.sample.noFinal', { finalKind: text.finalKind })
      : blocks([
          ctx.text('report.sample.final', { finalKind: text.finalKind }),
          codeBlock(text.final),
        ]);
  return blocks([
    ctx.text('report.sample.raw', { finishReason: text.finishReason }),
    codeBlock(text.raw),
    final,
  ]);
}

function failingSection(ctx: Context): string {
  const { failing, texts } = ctx.comparison.samples;
  const examples = failing.map((cell) => {
    const keys = cell.keys.map((key) => {
      const intro = ctx.text('report.sample.key', {
        variant: variantId(ctx, key.variant),
        caseId: key.caseId,
        repeat: key.repeat,
      });
      const evidence =
        key.evidence === undefined || key.evidence.length === 0
          ? intro
          : `${intro} · ${ctx.text('report.sample.evidence', { evidence: key.evidence.map(codeSpan).join(', ') })}`;
      const text = texts.find(
        (candidate) =>
          candidate.variant === key.variant &&
          candidate.caseId === key.caseId &&
          candidate.repeat === key.repeat,
      );
      return blocks([evidence, text === undefined ? '' : sampleText(ctx, text)]);
    });
    return blocks([`### ${cellLabel(cell)}`, ...keys]);
  });
  return blocks([
    heading(ctx, 'report.section.failing'),
    examples.length === 0 ? ctx.text('report.noFailing') : blocks(examples),
  ]);
}

// 4. Post-processing

function metricRateText(ctx: Context, rate: MetricRate): string {
  return `${rateText(rate)} (${ctx.text('report.countOf', { count: rate.count, total: rate.total })})`;
}

function postprocessVariant(ctx: Context, role: Role): string {
  const id = variantId(ctx, role);
  if (!ctx.comparison[role].postprocess) {
    return ctx.text('report.noPostprocess', { variant: id });
  }
  const ops = ctx.comparison.ops[role];
  const figures = (['discard', 'fallback', 'regeneration'] as const).map(
    (name) => `${ctx.text(`report.metric.${name}`)}: ${metricRateText(ctx, ops.rates[name])}`,
  );
  const reasons = ops.discardReasons.map(
    (reason) => `${codeSpan(reason.discardReason)} × ${String(reason.count)}`,
  );
  const reasonLines =
    reasons.length === 0 ? '' : `${ctx.text('report.discardReasons')}:\n\n${list(reasons)}`;
  return blocks([`### ${id}`, list(figures), reasonLines]);
}

function postprocessSection(ctx: Context): string {
  const masked = ctx.comparison.cells.flatMap((cell) =>
    cell.masked === undefined
      ? []
      : [
          `${cellLabel(cell)}: ${ctx.text('report.masked', {
            baseline: percent(cell.masked.baseline),
            candidate: percent(cell.masked.candidate),
          })}`,
        ],
  );
  return blocks([
    heading(ctx, 'report.section.postprocess'),
    masked.length === 0 ? '' : `${ctx.text('report.maskedIntro')}\n\n${list(masked)}`,
    ...ROLES.map((role) => postprocessVariant(ctx, role)),
  ]);
}

// 5. Cells whose baseline compliance is below the configured level

function lowBaselineSection(ctx: Context): string {
  const level = ctx.comparison.config.report.lowBaseline;
  const low = ctx.comparison.cells.filter((cell) => isLowBaseline(cell, level));
  const body =
    low.length === 0
      ? ctx.text('report.lowBaselineNone', { level: percent(level) })
      : blocks([
          ctx.text('report.lowBaselineIntro', { level: percent(level) }),
          table(
            [
              ctx.text('report.column.rule'),
              ctx.text('report.column.lang'),
              ctx.text('report.column.surface'),
              ctx.text('report.column.baseline'),
              ctx.text('report.column.candidate'),
              ctx.text('report.column.verdict'),
            ],
            low.map((cell) => [
              cell.ruleId,
              cell.lang,
              cell.surface,
              rateText(cell.baseline),
              rateText(cell.candidate),
              verdictText(ctx.lang, cell.verdict),
            ]),
          ),
        ]);
  return blocks([heading(ctx, 'report.section.lowBaseline'), body]);
}

// 6. Anchors and origins

function ruleLines(ctx: Context, rule: RuleSummary): string {
  const anchors = rule.anchors.map((anchor) => {
    const extra = [
      anchor.target === undefined
        ? undefined
        : ctx.text('report.anchorTarget', { target: anchor.target }),
      anchor.cases === undefined
        ? undefined
        : ctx.text('report.cases', { cases: anchor.cases.join(', ') }),
    ].filter(isDefined);
    return [
      ctx.text('report.anchor', { lang: anchor.lang, quote: codeSpan(anchor.quote) }),
      ...extra,
    ].join(' · ');
  });
  const origins = rule.origin.map((origin) =>
    [
      ctx.text('report.origin'),
      origin.commit === undefined ? undefined : codeSpan(origin.commit),
      origin.date === undefined ? undefined : codeSpan(origin.date),
      origin.layer,
    ]
      .filter(isDefined)
      .join(' · '),
  );
  const details = [
    ...(anchors.length === 0 ? [ctx.text('report.noAnchor')] : anchors),
    ...(origins.length === 0 ? [ctx.text('report.noOrigin')] : origins),
  ];
  const title = `${rule.id} · ${rule.severity} · ${codeSpan(rule.title)}`;
  return `- ${title}\n${details.map((detail) => `  - ${detail}`).join('\n')}`;
}

function anchorsSection(ctx: Context): string {
  const { rules } = ctx.comparison;
  return blocks([
    heading(ctx, 'report.section.anchors'),
    rules.length === 0
      ? ctx.text('report.none')
      : rules.map((rule) => ruleLines(ctx, rule)).join('\n'),
  ]);
}

// 7. Operational metrics and warnings

function opsTable(ctx: Context): string {
  const { ops } = ctx.comparison;
  const both = (value: (role: Role) => string): string[] => ROLES.map(value);
  const tokens = (role: Role): string => {
    const usage = ops[role].tokensPerTrial;
    return [usage.input, usage.cachedInput, usage.cacheWrite, usage.output, usage.reasoning]
      .map((count) => (count === undefined ? NONE : tokenMean(count)))
      .join(' / ');
  };
  const rows: string[][] = [
    ...opsRateNames.map((name) => [
      ctx.text(`report.metric.${name}`),
      ...both((role) => metricRateText(ctx, ops[role].rates[name])),
    ]),
    [
      ctx.text('report.metric.systematic'),
      ...both(
        (role) => `${String(ops[role].systematic.trials)} / ${String(ops[role].systematic.cases)}`,
      ),
    ],
    [
      ctx.text('report.metric.abandoned'),
      ...both(
        (role) => `${String(ops[role].abandoned.timeout)} / ${String(ops[role].abandoned.restart)}`,
      ),
    ],
    [
      ctx.text('report.metric.finishReasons'),
      ...both((role) => {
        const reasons = ops[role].finishReasons;
        return [reasons.stop, reasons.length, reasons.content_filter, reasons.other].join(' / ');
      }),
    ],
    [ctx.text('report.metric.latencyP50'), ...both((role) => seconds(ops[role].latencyMs.p50))],
    [ctx.text('report.metric.latencyP95'), ...both((role) => seconds(ops[role].latencyMs.p95))],
    [ctx.text('report.metric.tokensPerTrial'), ...both(tokens)],
    [ctx.text('report.metric.costPerTrial'), ...both((role) => dollars(ops[role].costPerTrialUsd))],
  ];
  return table(
    [ctx.text('report.column.metric'), variantId(ctx, 'baseline'), variantId(ctx, 'candidate')],
    rows,
  );
}

function opsLists(ctx: Context): string {
  const { ops } = ctx.comparison;
  const messages = ROLES.flatMap((role) =>
    ops[role].topMessages.map(
      (top) =>
        `${variantId(ctx, role)} · ${top.kind} × ${String(top.count)}: ${codeSpan(top.message)}`,
    ),
  );
  const sideCalls = ROLES.flatMap((role) =>
    ops[role].sideCallFailures.map(
      (failure) => `${variantId(ctx, role)} · ${failure.kind} × ${String(failure.count)}`,
    ),
  );
  const models = ROLES.flatMap((role) =>
    ops[role].responseModels.map(
      (model) => `${variantId(ctx, role)}: ${codeSpan(model.model)} × ${String(model.trials)}`,
    ),
  );
  return blocks([
    labelledList(ctx, 'report.topMessages', messages),
    labelledList(ctx, 'report.sideCallFailures', sideCalls),
    labelledList(ctx, 'report.responseModels', models),
  ]);
}

function warningLine(ctx: Context, warning: Warning): string {
  const label = [
    placeLabel(warning),
    warning.variants?.join(', '),
    warning.caseIds === undefined
      ? undefined
      : ctx.text('report.cases', { cases: warning.caseIds.join(', ') }),
  ]
    .filter(isDefined)
    .join(' · ');
  return labelled(label === '' ? undefined : label, warningText(ctx.lang, warning, codeSpan));
}

function opsSection(ctx: Context): string {
  const { warnings } = ctx.comparison;
  return blocks([
    heading(ctx, 'report.section.ops'),
    ctx.text('report.opsIntro'),
    opsTable(ctx),
    opsLists(ctx),
    `### ${ctx.text('report.warnings')}`,
    warnings.length === 0
      ? ctx.text('report.noWarnings')
      : list(warnings.map((warning) => warningLine(ctx, warning))),
  ]);
}

// 8. Judged scope

function scopeSection(ctx: Context): string {
  const { scope, rules, gate, coverage, completion } = ctx.comparison;
  const excluded = gate.excluded.map((rule) => `${rule.ruleId} (${rule.cause})`);
  const completionText = completion.map(
    (entry) =>
      `${entry.lang} ${percent(entry.rate)} (${ctx.text('report.countOf', { count: entry.passes, total: entry.trials })})`,
  );
  return blocks([
    heading(ctx, 'report.section.scope'),
    list([
      `${ctx.text('report.scope.targets')}: ${idList(ctx, scope.targets)}`,
      `${ctx.text('report.scope.judged', { judged: scope.judgedRules.length, total: rules.length })}: ${idList(ctx, scope.judgedRules)}`,
      `${ctx.text('report.scope.notJudged')}: ${idList(ctx, scope.notJudgedRules)}`,
      `${ctx.text('report.scope.review', { sideBySide: reviewSamplesText(ctx) })}: ${idList(ctx, scope.reviewRules)}`,
      `${ctx.text('report.scope.excluded')}: ${idList(ctx, excluded)}`,
      `${ctx.text('report.scope.commonCases')}: ${String(coverage.commonCases)}`,
      `${ctx.text('report.scope.baselineOnly', { variant: variantId(ctx, 'baseline') })}: ${idList(ctx, coverage.baselineOnly)}`,
      `${ctx.text('report.scope.candidateOnly', { variant: variantId(ctx, 'candidate') })}: ${idList(ctx, coverage.candidateOnly)}`,
      `${ctx.text('report.scope.changedHash')}: ${idList(ctx, coverage.changedHash)}`,
      `${ctx.text('report.scope.completion')}: ${idList(ctx, completionText)}`,
    ]),
  ]);
}

// 9. Reproduction details

function runLines(ctx: Context, role: Role): string {
  const run = ctx.comparison[role];
  const yesNo = (value: boolean): string => ctx.text(value ? 'report.yes' : 'report.no');
  const { adapter, service, variant } = run;
  const lines = [
    `${ctx.text('report.run.run')}: ${run.runId}`,
    `${ctx.text('report.run.gradeSet')}: ${run.gradeSetId}`,
    `${ctx.text('report.run.model')}: ${codeSpan(variant.model)}`,
    variant.params === undefined
      ? undefined
      : `${ctx.text('report.run.params')}: ${codeSpan(JSON.stringify(variant.params))}`,
    `${ctx.text('report.run.fingerprint')}: ${variant.fingerprint}`,
    `${ctx.text('report.run.status')}: ${run.status}`,
    `${ctx.text('report.run.tool')}: ${codeSpan(`${run.tool.name} ${run.tool.version}`)}`,
    `${ctx.text('report.run.adapter')}: ${codeSpan(adapter.name)} ${codeSpan(adapter.version)}`,
    `${ctx.text('report.run.launchHash')}: ${adapter.launchHash}`,
    adapter.helper === undefined
      ? undefined
      : `${ctx.text('report.run.helper')}: ${codeSpan(adapter.helper.language)} ${codeSpan(adapter.helper.version)}`,
    service.version === undefined
      ? undefined
      : `${ctx.text('report.run.serviceVersion')}: ${codeSpan(service.version)}`,
    service.dirty === undefined
      ? undefined
      : `${ctx.text('report.run.serviceDirty')}: ${yesNo(service.dirty)}`,
    service.treeHash === undefined
      ? undefined
      : `${ctx.text('report.run.treeHash')}: ${service.treeHash}`,
    `${ctx.text('report.run.postprocess')}: ${yesNo(run.postprocess)}`,
  ].filter(isDefined);
  return blocks([`### ${ctx.text(`report.role.${role}`)}: ${variant.id}`, list(lines)]);
}

function reproductionSection(ctx: Context): string {
  const { comparisonId, createdAt, stats, config, baseline, candidate } = ctx.comparison;
  const statistics = list([
    `${ctx.text('report.stats.confidence')}: ${percent(stats.confidence)}`,
    `${ctx.text('report.stats.method')}: ${stats.method}`,
    `${ctx.text('report.stats.gatedCells')}: ${String(stats.gatedCells)}`,
    `z_L ${String(stats.zLower)} · z_U ${String(stats.zUpper)}`,
    `minCases: ${String(stats.minCases)}`,
  ]);
  const commands = [
    `model-eval compare ${baseline.runId} ${candidate.runId}`,
    `model-eval report ${comparisonId}`,
  ].join('\n');
  return blocks([
    heading(ctx, 'report.section.reproduction'),
    ctx.text('report.comparison', { comparisonId, createdAt }),
    ...ROLES.map((role) => runLines(ctx, role)),
    `### ${ctx.text('report.statistics')}`,
    statistics,
    `### ${ctx.text('report.settings')}`,
    codeBlock(JSON.stringify(config, null, 2), 'json'),
    `### ${ctx.text('report.commands')}`,
    codeBlock(commands, 'sh'),
  ]);
}

/**
 * The Markdown report of a Comparison, in the language the command runs in, pointing to where
 * the writer put the `review` samples.
 */
export function renderReport(
  comparison: Comparison,
  lang: Lang,
  reviewSamplesAt: ReviewSamplesAt = 'comparison-json',
): string {
  const ctx: Context = {
    comparison,
    lang,
    text: (key, params) => message(lang, key, params),
    reviewSamplesAt,
  };
  const title = ctx.text('report.title', {
    baseline: `${comparison.baseline.variant.id} (${codeSpan(comparison.baseline.variant.model)})`,
    candidate: `${comparison.candidate.variant.id} (${codeSpan(comparison.candidate.variant.model)})`,
  });
  const sections = [
    summarySection,
    cellsSection,
    failingSection,
    postprocessSection,
    lowBaselineSection,
    anchorsSection,
    opsSection,
    scopeSection,
    reproductionSection,
  ].map((section) => section(ctx));
  return `${blocks([`# ${title}`, ...sections])}\n`;
}
