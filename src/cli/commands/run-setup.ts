import type { z } from 'zod';

import type { AdapterFault } from '../../adapter/client.js';
import type { LogParams } from '../../adapter/protocol.js';
import { loadProject, type Project } from '../../config/load.js';
import type { Lang, Variant } from '../../config/schema.js';
import { samplePlan, type SamplePlan } from '../../lint/sample-plan.js';
import { message, selectLang, type MessageKey, type MessageParams } from '../../messages/index.js';
import { milliseconds } from '../../report/format.js';
import { createRedactor } from '../../report/redact.js';
import type { RunEnd } from '../../run/active-run.js';
import type { RunCaseSpec } from '../../run/run-cases.js';
import type { ToolVersion, VariantPlan } from '../../run/runner.js';
import type { Warning } from '../../run/warning.js';
import type { ExitName } from '../exit-codes.js';
import {
  adapterEndLines,
  adapterFaultLines,
  diagnosticLines,
  startWarningLines,
} from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import type { dryRunPlanSchema } from '../results.js';

// What `run` and `swap` share: their options, the project they load and the plan they show.

export const TOOL_NAME = 'model-eval';

/** Options of `run` and `swap` (contracts/cli.md §Options of `run` and `swap`). */
export const RUN_OPTIONS = {
  repeats: { type: 'string' },
  cases: { type: 'string' },
  'max-cost-usd': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  concurrency: { type: 'string' },
} as const satisfies CommandHandler['options'];

export interface RunSettings {
  readonly repeats: number;
  /** `--cases`; `null` runs every case. */
  readonly caseFilter: string | null;
  /** `null` means no cap. */
  readonly maxCostUsd: number | null;
  readonly concurrency: number;
  readonly dryRun: boolean;
}

export interface RunSetup {
  readonly project: Project;
  /** `--lang`, else the config `lang`. */
  readonly lang: Lang;
  readonly settings: RunSettings;
  readonly tool: ToolVersion;
}

export type SetupResult =
  { readonly ok: true; readonly setup: RunSetup } | { readonly ok: false; readonly exit: ExitName };

type DryRunPlan = z.infer<typeof dryRunPlanSchema>;

const WHOLE_NUMBER = /^[1-9]\d*$/;
const AMOUNT = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Refusal };

interface Refusal {
  readonly key: MessageKey;
  readonly params: MessageParams;
}

function stringOption(invocation: CommandInvocation, name: string): string | undefined {
  const value = invocation.values[name];
  return typeof value === 'string' ? value : undefined;
}

function countOption(
  invocation: CommandInvocation,
  name: string,
  fallback: number,
): Parsed<number> {
  const value = stringOption(invocation, name);
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  return WHOLE_NUMBER.test(value)
    ? { ok: true, value: Number(value) }
    : { ok: false, error: { key: 'cli.invalidCount', params: { option: name, value } } };
}

function maxCostOption(
  invocation: CommandInvocation,
  fallback: number | null,
): Parsed<number | null> {
  const value = stringOption(invocation, 'max-cost-usd');
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  if (value === 'none') {
    return { ok: true, value: null };
  }
  return AMOUNT.test(value)
    ? { ok: true, value: Number(value) }
    : { ok: false, error: { key: 'cli.invalidMaxCost', params: { value } } };
}

/** Ends the command before a run starts: lines on stderr and an envelope without result. */
export function refuse(
  invocation: CommandInvocation,
  command: 'run' | 'swap',
  lines: readonly string[],
): ExitName {
  for (const line of lines) {
    invocation.output.progress(line);
  }
  invocation.output.envelope(command, 'config-error', null, []);
  return 'config-error';
}

/**
 * Loads the config and its rule and case files, switches the output to their `redact` rules
 * (FR-031) and reads the run options over the config's defaults.
 */
export async function setUpRun(
  invocation: CommandInvocation,
  command: 'run' | 'swap',
): Promise<SetupResult> {
  const { common, context, output } = invocation;
  const loaded = await loadProject(common.config, context.cwd, common.lang ?? 'en');
  if (!loaded.ok) {
    return {
      ok: false,
      exit: refuse(invocation, command, diagnosticLines(common.lang ?? 'en', loaded.diagnostics)),
    };
  }
  const { project } = loaded;
  const config = project.config.data;
  output.setRedactor(createRedactor(config.redact));
  const lang = selectLang(common.lang, config.lang);
  const refused = ({ key, params }: Refusal): SetupResult => ({
    ok: false,
    exit: refuse(invocation, command, [message(lang, key, params)]),
  });
  const repeats = countOption(invocation, 'repeats', config.sampling.repeats);
  if (!repeats.ok) {
    return refused(repeats.error);
  }
  const concurrency = countOption(invocation, 'concurrency', config.run.concurrency);
  if (!concurrency.ok) {
    return refused(concurrency.error);
  }
  const maxCostUsd = maxCostOption(invocation, config.budget.maxCostUsd);
  if (!maxCostUsd.ok) {
    return refused(maxCostUsd.error);
  }
  return {
    ok: true,
    setup: {
      project,
      lang,
      settings: {
        repeats: repeats.value,
        caseFilter: stringOption(invocation, 'cases') ?? null,
        maxCostUsd: maxCostUsd.value,
        concurrency: concurrency.value,
        dryRun: invocation.values['dry-run'] === true,
      },
      tool: { name: TOOL_NAME, version: context.version },
    },
  };
}

/** The variant an option names; a missing option or an unknown ID ends the command. */
export function variantOption(
  invocation: CommandInvocation,
  setup: RunSetup,
  command: 'run' | 'swap',
  option: string,
): Variant | ExitName {
  const id = stringOption(invocation, option);
  const { variants } = setup.project.config.data;
  if (id === undefined) {
    return refuse(invocation, command, [message(setup.lang, 'cli.missingOption', { option })]);
  }
  const variant = variants.find((item) => item.id === id);
  if (variant === undefined) {
    return refuse(invocation, command, [
      message(setup.lang, 'cli.unknownVariant', {
        variant: id,
        variants: variants.map((item) => item.id).join(', '),
      }),
    ]);
  }
  return variant;
}

/** The gated cells of the cases a run will send, and their `few-cases` and `margin-unreachable`. */
export function plannedCells(setup: RunSetup, cases: readonly RunCaseSpec[]): SamplePlan {
  const config = setup.project.config.data;
  return samplePlan({
    rules: setup.project.ruleFiles.flatMap((file) => file.data.rules),
    cases: cases.map((spec) => ({ definition: spec.definition, lang: spec.lang })),
    repeats: setup.settings.repeats,
    gate: config.gate,
    stats: config.stats,
  });
}

export function dryRunPlan(
  setup: RunSetup,
  variants: readonly VariantPlan[],
  costs: { readonly expectedUsd: number | null; readonly conservativeUsd: number | null },
  cells: SamplePlan,
): DryRunPlan {
  return {
    variants: variants.map((entry) => ({ ...entry, basis: { ...entry.basis } })),
    expectedUsd: costs.expectedUsd,
    conservativeUsd: costs.conservativeUsd,
    maxCostUsd: setup.settings.maxCostUsd,
    cells: [...cells.cells],
  };
}

/** Pre-start warnings go to stderr once, before any model call. */
export function showStartWarnings(
  invocation: CommandInvocation,
  setup: RunSetup,
  cells: SamplePlan,
  warnings: readonly Warning[],
): void {
  for (const line of startWarningLines(setup.lang, cells.warnings, warnings)) {
    invocation.output.progress(line);
  }
}

/** `--verbose` relays adapter stderr and `log` notifications, redacted like every other write. */
export function adapterRelay(invocation: CommandInvocation) {
  if (!invocation.common.verbose) {
    return {};
  }
  const { output } = invocation;
  return {
    onStderr: (line: string) => {
      output.progress(line);
    },
    onLog: (params: LogParams) => {
      output.progress(`[${params.level}] ${params.message}`);
    },
  };
}

/** Restarts of the adapter and the faults that stop a run go to stderr when they happen. */
export function faultRelay(invocation: CommandInvocation, lang: Lang) {
  return {
    onAdapterFault: (variantId: string, fault: AdapterFault) => {
      for (const line of adapterFaultLines(lang, variantId, fault)) {
        invocation.output.progress(line);
      }
    },
  };
}

/** The stderr tails of runs their adapter stopped and the grouped adapter logs, on stderr. */
export function showAdapterEnd(
  invocation: CommandInvocation,
  lang: Lang,
  runs: readonly RunEnd[],
): void {
  for (const line of adapterEndLines(lang, runs)) {
    invocation.output.progress(line);
  }
}

export function printAll(invocation: CommandInvocation, lines: readonly string[]): void {
  for (const line of lines) {
    invocation.output.print(line);
  }
}

/** `--verbose`: how long the start (adapters, renders, estimates) and the rest took. */
export function showTimings(
  invocation: CommandInvocation,
  lang: Lang,
  stages: { readonly start: number; readonly run: number },
): void {
  if (invocation.common.verbose) {
    invocation.output.progress(
      message(lang, 'human.timings', {
        start: milliseconds(stages.start),
        run: milliseconds(stages.run),
      }),
    );
  }
}
