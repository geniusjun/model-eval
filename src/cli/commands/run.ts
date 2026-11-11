import { exceedsCap } from '../../run/cap.js';
import { conservativeWarning, prepareRun, startRun } from '../../run/runner.js';
import { stopExit, type ExitName } from '../exit-codes.js';
import { overBudgetLine, planLines, runLines, startFailureLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { EnvelopeWarning } from '../results.js';
import {
  adapterRelay,
  dryRunPlan,
  faultRelay,
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

// `model-eval run --variant <id>`: records and grades one variant under its own cap.

async function run(invocation: CommandInvocation, setup: RunSetup): Promise<ExitName> {
  const { output } = invocation;
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
  const { end } = result;
  const exit = end.stopReason === undefined ? 'ok' : stopExit(end.stopReason);
  output.envelope(
    'run',
    exit,
    {
      runId: end.runId,
      status: end.status,
      ...(end.stopReason === undefined ? {} : { stopReason: end.stopReason }),
      gradeSetId: end.gradeSetId,
    },
    [...startWarnings, ...end.manifest.warnings],
  );
  printAll(invocation, runLines(lang, { end, ...costs, warnings: end.manifest.warnings }));
  showAdapterEnd(invocation, lang, [end]);
  showTimings(invocation, lang, { start: sending - started, run: Date.now() - sending });
  return exit;
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
