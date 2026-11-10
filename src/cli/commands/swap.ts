import path from 'node:path';

import { groupWarnings } from '../../compare/warnings.js';
import { exceedsCap } from '../../run/cap.js';
import { prepareSwap, type SwapEnd } from '../../run/swap.js';
import type { Warning } from '../../run/warning.js';
import { gateExit } from '../../compare/gate.js';
import { message } from '../../messages/index.js';
import { resolveExit, stopExit, type ExitName } from '../exit-codes.js';
import { overBudgetLine, planLines, startFailureLines, swapLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { EnvelopeWarning } from '../results.js';
import {
  adapterRelay,
  dryRunPlan,
  plannedCells,
  refuse,
  RUN_OPTIONS,
  printAll,
  setUpRun,
  showStartWarnings,
  showTimings,
  variantOption,
  type RunSetup,
} from './run-setup.js';

// `model-eval swap --from <id> --to <id>` (contracts/cli.md, FR-032).

/** The stop reason's exit, then the gate's, in the overlap order of contracts/cli.md. */
function swapExit(end: SwapEnd): ExitName {
  const { stopReason } = end.record;
  return resolveExit([
    ...(stopReason === undefined ? [] : [stopExit(stopReason)]),
    ...(end.comparison === undefined ? [] : [gateExit(end.comparison.gate.outcome)]),
  ]);
}

/**
 * The comparison re-raises every run warning; a swap that did not compare carries both runs'
 * warnings grouped the same way instead (contracts/cli.md §`--json` Output).
 */
function resultWarnings(end: SwapEnd): Warning[] {
  return (
    end.comparison?.warnings ??
    groupWarnings([...end.runs.baseline.manifest.warnings, ...end.runs.candidate.manifest.warnings])
  );
}

async function swap(invocation: CommandInvocation, setup: RunSetup): Promise<ExitName> {
  const { output } = invocation;
  const baseline = variantOption(invocation, setup, 'swap', 'from');
  if (typeof baseline === 'string') {
    return baseline;
  }
  const candidate = variantOption(invocation, setup, 'swap', 'to');
  if (typeof candidate === 'string') {
    return candidate;
  }
  if (candidate.id === baseline.id) {
    return refuse(invocation, 'swap', [
      message(setup.lang, 'cli.sameVariant', { variant: candidate.id }),
    ]);
  }
  const { settings, lang } = setup;
  const started = Date.now();
  const prepared = await prepareSwap({
    project: setup.project,
    baseline,
    candidate,
    repeats: settings.repeats,
    caseFilter: settings.caseFilter,
    concurrency: settings.concurrency,
    maxCostUsd: settings.maxCostUsd,
    tool: setup.tool,
    lang,
    ...adapterRelay(invocation),
  });
  if (!prepared.ok) {
    const { variantId, failure } = prepared.failure;
    return refuse(invocation, 'swap', startFailureLines(lang, variantId, failure));
  }
  const prepare = prepared.swap;
  const cells = plannedCells(setup, prepare.runs.baseline.cases);
  const plan = dryRunPlan(
    setup,
    [prepare.runs.baseline.plan, prepare.runs.candidate.plan],
    prepare,
    cells,
  );
  const variants = [baseline, candidate];
  const startWarnings: EnvelopeWarning[] = [...cells.warnings, ...prepare.startWarnings];
  showStartWarnings(invocation, setup, cells, prepare.startWarnings);
  if (settings.dryRun) {
    await prepare.abandon();
    const exit = exceedsCap(plan.expectedUsd, plan.maxCostUsd) ? 'over-budget' : 'ok';
    printAll(invocation, planLines(lang, variants, plan));
    output.envelope('swap', exit, { plan }, startWarnings);
    return exit;
  }
  const sending = Date.now();
  const result = await prepare.start();
  if (!result.ok) {
    if (result.failure.kind === 'over-budget') {
      printAll(invocation, planLines(lang, variants, plan));
      output.progress(overBudgetLine(lang, result.failure));
      output.envelope('swap', 'over-budget', { plan }, startWarnings);
      return 'over-budget';
    }
    const { variantId, failure } = result.failure;
    return refuse(invocation, 'swap', startFailureLines(lang, variantId, failure));
  }
  const { end } = result;
  const exit = swapExit(end);
  const warnings = resultWarnings(end);
  const { comparison } = end;
  // The comparison and its warnings are redacted already; a second pass would change text a
  // rule's replacement matches again. The IDs beside it hold no free text.
  output.envelope(
    'swap',
    exit,
    {
      swapId: end.record.swapId,
      runs: [end.runs.baseline.runId, end.runs.candidate.runId],
      ...(comparison === undefined ? {} : { comparison, gate: comparison.gate }),
    },
    comparison === undefined ? [...startWarnings, ...warnings] : startWarnings,
    comparison === undefined ? {} : { result: true, warnings },
  );
  const lines = swapLines(lang, {
    end,
    expectedUsd: prepare.expectedUsd,
    conservativeUsd: prepare.conservativeUsd,
    warnings,
    ...(end.written === undefined
      ? {}
      : { reportPath: path.relative(invocation.context.cwd, end.written.report) }),
  });
  for (const line of lines) {
    if (line.redacted) {
      output.printRedacted(line.text);
    } else {
      output.print(line.text);
    }
  }
  showTimings(invocation, lang, { start: sending - started, run: Date.now() - sending });
  return exit;
}

export const swapCommand: CommandHandler = {
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    ...RUN_OPTIONS,
  },
  async run(invocation) {
    const setup = await setUpRun(invocation, 'swap');
    return setup.ok ? swap(invocation, setup.setup) : setup.exit;
  },
};
