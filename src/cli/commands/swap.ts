import path from 'node:path';

import { groupWarnings } from '../../compare/warnings.js';
import { exceedsCap } from '../../run/cap.js';
import { prepareSwap, prepareSwapResume, type SwapEnd } from '../../run/swap.js';
import type { Warning } from '../../run/warning.js';
import { gateExit } from '../../compare/gate.js';
import { message } from '../../messages/index.js';
import { resolveExit, stopExit, type ExitName } from '../exit-codes.js';
import { shownComparison } from '../human/compare.js';
import { swapResumeFailureLines } from '../human/resume.js';
import { overBudgetLine, planLines, startFailureLines, swapLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { EnvelopeWarning } from '../results.js';
import {
  adapterRelay,
  dryRunPlan,
  faultRelay,
  interruptRelay,
  pageTemplateOf,
  plannedCells,
  refuse,
  RUN_OPTIONS,
  printAll,
  setUpRun,
  showAdapterEnd,
  showStartWarnings,
  showTimings,
  variantOption,
  warnWithoutPage,
  type RunSetup,
} from './run-setup.js';

// `model-eval swap --from <id> --to <id>` (contracts/cli.md, FR-032); with `--resume <swapId>`,
// finishes a stopped swap check.

/** The stop reason's exit, then the gate's, in the overlap order of contracts/cli.md. */
function swapExit(end: SwapEnd): ExitName {
  const { stopReason } = end.record;
  return resolveExit([
    // Quit by a second interrupt while grading or comparing: the user interrupted it.
    ...(end.quit === true ? [stopExit('interrupted')] : []),
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

/** The result, warnings and human lines of a swap that ended, new or resumed. */
function showEnd(
  invocation: CommandInvocation,
  setup: RunSetup,
  view: {
    readonly end: SwapEnd;
    readonly expectedUsd: number | null;
    readonly conservativeUsd: number | null;
    readonly startWarnings: readonly EnvelopeWarning[];
    readonly timings: { readonly start: number; readonly run: number };
  },
): ExitName {
  const { output } = invocation;
  const { end, startWarnings } = view;
  const { lang } = setup;
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
    comparison === undefined ? [...startWarnings, ...warnings] : [...startWarnings],
    comparison === undefined ? {} : { result: true, warnings },
  );
  const lines = swapLines(lang, {
    end,
    expectedUsd: view.expectedUsd,
    conservativeUsd: view.conservativeUsd,
    warnings,
    ...(end.written === undefined
      ? {}
      : { written: shownComparison(end.written, invocation.context.cwd) }),
  });
  for (const line of lines) {
    if (line.redacted) {
      output.printRedacted(line.text);
    } else {
      output.print(line.text);
    }
  }
  if (end.written !== undefined) {
    warnWithoutPage(invocation, lang, end.written);
  }
  showAdapterEnd(invocation, lang, [end.runs.baseline, end.runs.candidate]);
  showTimings(invocation, lang, view.timings);
  return exit;
}

/**
 * `swap --resume <swapId>`: both runs with their recorded variants, seed, repeats and cases;
 * `--from`, `--to`, `--repeats` and `--cases` only when they match the records.
 */
async function resumeSwap(
  invocation: CommandInvocation,
  setup: RunSetup,
  swapId: string,
): Promise<ExitName> {
  const { output } = invocation;
  const { settings, lang, project } = setup;
  const { from, to } = invocation.values;
  const started = Date.now();
  const prepared = await prepareSwapResume({
    project,
    swapId,
    ...(typeof from === 'string' ? { from } : {}),
    ...(typeof to === 'string' ? { to } : {}),
    ...settings.given,
    concurrency: settings.concurrency,
    maxCostUsd: settings.maxCostUsd,
    tool: setup.tool,
    lang,
    ...pageTemplateOf(invocation),
    ...adapterRelay(invocation),
    ...faultRelay(invocation, lang),
    ...interruptRelay(invocation, lang),
  });
  const dirs = {
    swapsDir: path.join(project.paths.outputDir, 'swaps'),
    runsDir: path.join(project.paths.outputDir, 'runs'),
  };
  if (!prepared.ok) {
    return refuse(invocation, 'swap', swapResumeFailureLines(lang, dirs, prepared.failure));
  }
  const resumed = prepared.swap;
  const { baseline, candidate } = resumed.runs;
  const { repeats } = baseline.manifest.sampling;
  const cells = plannedCells({ ...setup, settings: { ...settings, repeats } }, baseline.cases);
  const plan = dryRunPlan(
    setup,
    [baseline.plan, candidate.plan],
    { expectedUsd: resumed.expectedUsd, conservativeUsd: null },
    cells,
  );
  const startWarnings: EnvelopeWarning[] = [...cells.warnings];
  showStartWarnings(invocation, setup, cells, []);
  if (settings.dryRun) {
    await resumed.abandon();
    const exit = exceedsCap(plan.expectedUsd, plan.maxCostUsd) ? 'over-budget' : 'ok';
    printAll(
      invocation,
      planLines(lang, [baseline.manifest.variant, candidate.manifest.variant], plan),
    );
    output.envelope('swap', exit, { plan }, [...startWarnings, ...resumed.warnings]);
    return exit;
  }
  const sending = Date.now();
  const result = await resumed.start();
  if (!result.ok) {
    return refuse(invocation, 'swap', swapResumeFailureLines(lang, dirs, result.failure));
  }
  return showEnd(invocation, setup, {
    end: result.end,
    expectedUsd: resumed.expectedUsd,
    conservativeUsd: null,
    startWarnings,
    timings: { start: sending - started, run: Date.now() - sending },
  });
}

async function swap(invocation: CommandInvocation, setup: RunSetup): Promise<ExitName> {
  const { output } = invocation;
  if (setup.settings.resume !== undefined) {
    return resumeSwap(invocation, setup, setup.settings.resume);
  }
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
    ...pageTemplateOf(invocation),
    ...adapterRelay(invocation),
    ...faultRelay(invocation, lang),
    ...interruptRelay(invocation, lang),
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
  return showEnd(invocation, setup, {
    end: result.end,
    expectedUsd: prepare.expectedUsd,
    conservativeUsd: prepare.conservativeUsd,
    startWarnings,
    timings: { start: sending - started, run: Date.now() - sending },
  });
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
