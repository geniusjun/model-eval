import type { z } from 'zod';

import { LOSSES_IN_A_ROW, type AdapterFault } from '../../adapter/client.js';
import type { Diagnostic, LintFinding } from '../../config/diagnostics.js';
import type { Lang, Variant } from '../../config/schema.js';
import { message } from '../../messages/index.js';
import { warningText } from '../../report/code-text.js';
import { dollars, NONE, percent } from '../../report/format.js';
import type { RunEnd } from '../../run/active-run.js';
import type { Manifest, StopReason } from '../../run/manifest.js';
import { priceFor } from '../../run/cost.js';
import type { OverBudget, RunStartFailure } from '../../run/runner.js';
import type { SwapEnd } from '../../run/swap.js';
import type { Warning } from '../../run/warning.js';
import type { dryRunPlanSchema } from '../results.js';
import {
  comparedLines,
  ordinal,
  variantLabel,
  warningLines,
  type ShownComparison,
} from './compare.js';
import { aligned, INDENT, plainLines, type HumanLine } from './layout.js';
import {
  counted,
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
const COST_STOPS: ReadonlySet<StopReason> = new Set(['budget', 'budget-projected']);
const CONFIG_MESSAGES_SHOWN = 3;

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

// Findings before the start

/** Why the config, rule or case files cannot be used, one line per finding. */
export function diagnosticLines(lang: Lang, diagnostics: readonly Diagnostic[]): string[] {
  const t = textOf(lang);
  return [
    counted(t, 'human.configInvalid', diagnostics.length),
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
        counted(t, 'human.adapter.stderrTail', tail.length, { variant: variantId }),
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
              counted(t, 'human.plan.cell', cell.plannedTrials, {
                plannedTrials: cell.plannedTrials,
                nMin: cell.nMin,
              }),
            ]),
          ),
        ];
  return [
    t('human.plan.header', { variants: variants.map(variantLabel).join(' → ') }),
    ...aligned(
      plan.variants.map((entry) => [
        entry.variant,
        t('human.plan.variant', {
          trials: counted(t, 'count.trials', entry.trials),
          calls: counted(t, 'count.calls', entry.calls),
          inputTokens: counted(t, 'count.inputTokens', entry.inputTokens),
          outputTokens: counted(t, 'count.outputTokens', entry.outputTokens),
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

// run and swap

interface Costs {
  readonly expectedUsd: number | null;
  readonly conservativeUsd: number | null;
}

function scaleParams(
  t: Text,
  manifests: readonly Manifest[],
  spentUsd: number | null,
  costs: Costs,
) {
  const [first] = manifests;
  const cases = first?.cases ?? [];
  const repeats = first?.sampling.repeats ?? 0;
  const trials = manifests.reduce(
    (sum, manifest) => sum + manifest.cases.length * manifest.sampling.repeats,
    0,
  );
  return {
    cases: counted(t, 'count.cases', cases.length),
    languages: languagesText(cases),
    repeats: counted(t, 'count.repeats', repeats),
    trials: counted(t, 'count.trials', trials),
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
  /** What the swap wrote for its comparison. */
  readonly written?: ShownComparison;
}

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
      ...scaleParams(t, manifests, end.record.spentUsd, view),
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
    ...comparedLines(t, { comparison, warnings: view.warnings, written: view.written }),
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
      ...scaleParams(t, [manifest], manifest.totals.costUsd, view),
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
