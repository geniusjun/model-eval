import path from 'node:path';

import type { RunEnd } from '../../run/active-run.js';
import { exceedsCap } from '../../run/cap.js';
import { prepareResume, resumeTotalUsd, startResumedRun } from '../../run/resume-run.js';
import { conservativeWarning, prepareRun, startRun } from '../../run/runner.js';
import type { Warning } from '../../run/warning.js';
import { stopExit, type ExitName } from '../exit-codes.js';
import { resumeFailureLines } from '../human/resume.js';
import { overBudgetLine, planLines, runLines, startFailureLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { EnvelopeWarning } from '../results.js';
import {
  adapterRelay,
  dryRunPlan,
  faultRelay,
  interruptRelay,
  plannedCells,
  printAll,
  refuse,
  RUN_OPTIONS,
  setUpRun,
  showAdapterEnd,
  showStartWarnings,
  showTimings,
  variantOption,
  type RunSetup,
} from './run-setup.js';

// `model-eval run --variant <id>`: records and grades one variant under its own cap; with
// `--resume <runId>`, finishes a stopped run.

/** The result, warnings and human lines of a run that ended, new or resumed. */
function showEnd(
  invocation: CommandInvocation,
  setup: RunSetup,
  view: {
    readonly end: RunEnd;
    readonly expectedUsd: number | null;
    readonly conservativeUsd: number | null;
    readonly startWarnings: readonly EnvelopeWarning[];
    readonly timings: { readonly start: number; readonly run: number };
  },
): ExitName {
  const { end } = view;
  const exit = end.stopReason === undefined ? 'ok' : stopExit(end.stopReason);
  const warnings: readonly Warning[] = end.manifest.warnings;
  invocation.output.envelope(
    'run',
    exit,
    {
      runId: end.runId,
      status: end.status,
      ...(end.stopReason === undefined ? {} : { stopReason: end.stopReason }),
      gradeSetId: end.gradeSetId,
    },
    [...view.startWarnings, ...warnings],
  );
  printAll(
    invocation,
    runLines(setup.lang, {
      end,
      expectedUsd: view.expectedUsd,
      conservativeUsd: view.conservativeUsd,
      warnings,
    }),
  );
  showAdapterEnd(invocation, setup.lang, [end]);
  showTimings(invocation, setup.lang, view.timings);
  return exit;
}

/**
 * `run --resume <runId>`: the recorded variant, seed, repeats and cases; `--variant`,
 * `--repeats` and `--cases` only when they match the record (data-model §Resume and Locking).
 */
async function resume(
  invocation: CommandInvocation,
  setup: RunSetup,
  runId: string,
): Promise<ExitName> {
  const { output } = invocation;
  const { settings, lang, project } = setup;
  const variant = invocation.values.variant;
  const started = Date.now();
  const prepared = await prepareResume({
    project,
    runId,
    command: 'run',
    set: {
      ...(typeof variant === 'string' ? { variant: { option: 'variant', id: variant } } : {}),
      ...settings.given,
    },
    concurrency: settings.concurrency,
    maxCostUsd: settings.maxCostUsd,
    tool: setup.tool,
    ...adapterRelay(invocation),
    ...faultRelay(invocation, lang),
    ...interruptRelay(invocation, lang),
  });
  const runsDir = path.join(project.paths.outputDir, 'runs');
  if (!prepared.ok) {
    return refuse(invocation, 'run', resumeFailureLines(lang, runsDir, runId, prepared.failure));
  }
  const run = prepared.run;
  const { repeats } = run.manifest.sampling;
  const cells = plannedCells({ ...setup, settings: { ...settings, repeats } }, run.cases);
  const expectedUsd = resumeTotalUsd([run]);
  const plan = dryRunPlan(setup, [run.plan], { expectedUsd, conservativeUsd: null }, cells);
  const startWarnings: EnvelopeWarning[] = [...cells.warnings];
  showStartWarnings(invocation, setup, cells, []);
  if (settings.dryRun) {
    await run.abandon();
    const exit = exceedsCap(plan.expectedUsd, plan.maxCostUsd) ? 'over-budget' : 'ok';
    printAll(invocation, planLines(lang, [run.manifest.variant], plan));
    output.envelope('run', exit, { plan }, [...startWarnings, ...run.warnings]);
    return exit;
  }
  const sending = Date.now();
  const result = await startResumedRun(run, settings.maxCostUsd);
  if (!result.ok) {
    return refuse(invocation, 'run', resumeFailureLines(lang, runsDir, runId, result.failure));
  }
  return showEnd(invocation, setup, {
    end: result.end,
    expectedUsd,
    conservativeUsd: null,
    startWarnings,
    timings: { start: sending - started, run: Date.now() - sending },
  });
}

async function run(invocation: CommandInvocation, setup: RunSetup): Promise<ExitName> {
  const { output } = invocation;
  if (setup.settings.resume !== undefined) {
    return resume(invocation, setup, setup.settings.resume);
  }
  const variant = variantOption(invocation, setup, 'run', 'variant');
  if (typeof variant === 'string') {
    return variant;
  }
  const { settings, lang } = setup;
  const started = Date.now();
  const prepared = await prepareRun({
    project: setup.project,
    variant,
    repeats: settings.repeats,
    caseFilter: settings.caseFilter,
    concurrency: settings.concurrency,
    maxCostUsd: settings.maxCostUsd,
    tool: setup.tool,
    ...adapterRelay(invocation),
    ...faultRelay(invocation, lang),
    ...interruptRelay(invocation, lang),
  });
  if (!prepared.ok) {
    return refuse(invocation, 'run', startFailureLines(lang, variant.id, prepared.failure));
  }
  const prepare = prepared.run;
  const costs = {
    expectedUsd: prepare.estimate.expected.usd,
    conservativeUsd: prepare.estimate.conservativeUsd,
  };
  const cells = plannedCells(setup, prepare.cases);
  const plan = dryRunPlan(setup, [prepare.plan], costs, cells);
  const conservative = conservativeWarning(costs.conservativeUsd, settings.maxCostUsd);
  const startWarnings: EnvelopeWarning[] = [...cells.warnings, ...conservative];
  showStartWarnings(invocation, setup, cells, conservative);
  if (settings.dryRun) {
    await prepare.abandon();
    const exit = exceedsCap(plan.expectedUsd, plan.maxCostUsd) ? 'over-budget' : 'ok';
    printAll(invocation, planLines(lang, [variant], plan));
    output.envelope('run', exit, { plan }, startWarnings);
    return exit;
  }
  const sending = Date.now();
  const result = await startRun(prepare, settings.maxCostUsd);
  if (!result.ok) {
    if (result.failure.kind === 'over-budget') {
      printAll(invocation, planLines(lang, [variant], plan));
      output.progress(overBudgetLine(lang, result.failure));
      output.envelope('run', 'over-budget', { plan }, startWarnings);
      return 'over-budget';
    }
    return refuse(invocation, 'run', startFailureLines(lang, variant.id, result.failure));
  }
  return showEnd(invocation, setup, {
    end: result.end,
    ...costs,
    startWarnings,
    timings: { start: sending - started, run: Date.now() - sending },
  });
}

export const runCommand: CommandHandler = {
  options: {
    variant: { type: 'string' },
    ...RUN_OPTIONS,
  },
  async run(invocation) {
    const setup = await setUpRun(invocation, 'run');
    return setup.ok ? run(invocation, setup.setup) : setup.exit;
  },
};
