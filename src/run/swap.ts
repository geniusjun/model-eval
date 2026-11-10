import type { LogParams } from '../adapter/protocol.js';
import { buildComparison, type CurrentCase } from '../compare/comparison.js';
import { finishedTrials } from '../compare/finished.js';
import type { Project } from '../config/load.js';
import type { Lang, Variant } from '../config/schema.js';
import type { Comparison } from '../report/schema.js';
import { writeComparison, type WrittenComparison } from '../report/write.js';
import type { PerRole } from '../stats/interval.js';
import type { RunEnd } from './active-run.js';
import { createCapLedger, exceedsCap } from './cap.js';
import { driveRuns } from './drive.js';
import { newSwapId } from './ids.js';
import type { StopReason, SwapRecord } from './manifest.js';
import type { RandomSource } from './retry.js';
import {
  conservativeWarning,
  prepareRun,
  type OverBudget,
  type PreparedRun,
  type RunRequest,
  type RunStartFailure,
  type SharedRun,
  type ToolVersion,
} from './runner.js';
import { createStopSignal } from './stopping.js';
import type { Warning } from './warning.js';
import { writeSwapRecord } from './writer.js';

// The swap check (FR-032): both variants under one cap with interleaved trials, then grade,
// compare, gate and write the outputs (data-model §Run, Run and Swap Status).

type Role = keyof PerRole<unknown>;
const ROLES: readonly Role[] = ['baseline', 'candidate'];

export interface SwapRequest {
  readonly project: Project;
  /** `--from`. */
  readonly baseline: Variant;
  /** `--to`. */
  readonly candidate: Variant;
  readonly repeats: number;
  readonly caseFilter: string | null;
  /** Per adapter process, so per variant. */
  readonly concurrency: number;
  /** One cap over both runs; `null` means no cap. */
  readonly maxCostUsd: number | null;
  readonly tool: ToolVersion;
  /** The language of `report.md`. */
  readonly lang: Lang;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly onLog?: (params: LogParams) => void;
  readonly onStderr?: (line: string) => void;
}

/** A start failure with the variant whose run it stopped. */
export interface SwapStartFailure {
  readonly kind: 'start';
  readonly variantId: string;
  readonly failure: RunStartFailure;
}

export interface SwapEnd {
  readonly record: SwapRecord;
  readonly runs: PerRole<RunEnd>;
  /** Absent when the swap stopped on `config-error` or finished no trial (FR-032 item 3). */
  readonly comparison?: Comparison;
  readonly written?: WrittenComparison;
}

export type SwapResult =
  | { readonly ok: true; readonly end: SwapEnd }
  | { readonly ok: false; readonly failure: SwapStartFailure | OverBudget };

/** Both variants started and rendered; nothing is written until `start`. */
export interface PreparedSwap {
  readonly swapId: string;
  readonly runs: PerRole<PreparedRun>;
  /** The expected estimates of both runs added; `null` when either is unknown. */
  readonly expectedUsd: number | null;
  readonly conservativeUsd: number | null;
  readonly maxCostUsd: number | null;
  /** `conservative-over-budget` for the whole swap, raised once rather than per run. */
  readonly startWarnings: readonly Warning[];
  /** The start check, both runs, the comparison and the swap record. */
  start(): Promise<SwapResult>;
  /** Shuts both adapters down without writing anything. */
  abandon(): Promise<void>;
}

export type PrepareSwapResult =
  | { readonly ok: true; readonly swap: PreparedSwap }
  | { readonly ok: false; readonly failure: SwapStartFailure };

function addUsd(values: readonly (number | null)[]): number | null {
  return values.reduce<number | null>(
    (total, value) => (total === null || value === null ? null : total + value),
    0,
  );
}

const byRole = <T>(value: (role: Role) => T): PerRole<T> => ({
  baseline: value('baseline'),
  candidate: value('candidate'),
});

type Step<T, F> =
  { readonly ok: true; readonly run: T } | { readonly ok: false; readonly failure: F };

type Settled<T, F> =
  | { readonly kind: 'run'; readonly run: T }
  | { readonly kind: 'refused'; readonly failure: F }
  | { readonly kind: 'threw'; readonly reason: unknown };

type BothSteps<T, F> =
  | { readonly ok: true; readonly runs: PerRole<T> }
  | { readonly ok: false; readonly role: Role; readonly failure: F };

async function settle<T, F>(step: Promise<Step<T, F>>): Promise<Settled<T, F>> {
  try {
    const result = await step;
    return result.ok
      ? { kind: 'run', run: result.run }
      : { kind: 'refused', failure: result.failure };
  } catch (reason) {
    return { kind: 'threw', reason };
  }
}

function failedStep<T, F>(
  role: Role,
  settled: Exclude<Settled<T, F>, { kind: 'run' }>,
): BothSteps<T, F> {
  if (settled.kind === 'threw') {
    throw settled.reason;
  }
  return { ok: false, role, failure: settled.failure };
}

/**
 * Runs one step for both roles at once. When either is refused or throws, the side that
 * succeeded is abandoned, so no adapter outlives a failed start.
 */
async function bothOrNeither<T, F>(
  step: (role: Role) => Promise<Step<T, F>>,
  abandon: (run: T) => Promise<void>,
): Promise<BothSteps<T, F>> {
  const [baseline, candidate] = await Promise.all([
    settle(step('baseline')),
    settle(step('candidate')),
  ]);
  if (baseline.kind === 'run') {
    if (candidate.kind === 'run') {
      return { ok: true, runs: { baseline: baseline.run, candidate: candidate.run } };
    }
    await abandon(baseline.run);
    return failedStep('candidate', candidate);
  }
  if (candidate.kind === 'run') {
    await abandon(candidate.run);
  }
  return failedStep('baseline', baseline);
}

/**
 * Starts one adapter per variant and renders every case of both, before any model call. When
 * either fails, the other adapter is shut down and nothing is written.
 */
export async function prepareSwap(request: SwapRequest): Promise<PrepareSwapResult> {
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  const swapId = newSwapId(startedAt);
  const runRequest = (variant: Variant): RunRequest => ({
    project: request.project,
    variant,
    repeats: request.repeats,
    caseFilter: request.caseFilter,
    concurrency: request.concurrency,
    maxCostUsd: request.maxCostUsd,
    tool: request.tool,
    swapId,
    now,
    ...(request.random === undefined ? {} : { random: request.random }),
    ...(request.onLog === undefined ? {} : { onLog: request.onLog }),
    ...(request.onStderr === undefined ? {} : { onStderr: request.onStderr }),
  });
  const variants: PerRole<Variant> = { baseline: request.baseline, candidate: request.candidate };
  const prepared = await bothOrNeither(
    (role) => prepareRun(runRequest(variants[role])),
    (run) => run.abandon(),
  );
  if (!prepared.ok) {
    const { role, failure } = prepared;
    return { ok: false, failure: { kind: 'start', variantId: variants[role].id, failure } };
  }
  const { runs } = prepared;
  const conservativeUsd = addUsd(ROLES.map((role) => runs[role].estimate.conservativeUsd));
  const swap: PreparedSwap = {
    swapId,
    runs,
    expectedUsd: addUsd(ROLES.map((role) => runs[role].estimate.expected.usd)),
    conservativeUsd,
    maxCostUsd: request.maxCostUsd,
    startWarnings: conservativeWarning(conservativeUsd, request.maxCostUsd),
    start: () => startSwap(swap, request, startedAt),
    abandon: async () => {
      await Promise.all(ROLES.map((role) => runs[role].abandon()));
    },
  };
  return { ok: true, swap };
}

/** `model-eval swap`: {@link prepareSwap}, then {@link PreparedSwap.start}. */
export async function executeSwap(request: SwapRequest): Promise<SwapResult> {
  const prepared = await prepareSwap(request);
  return prepared.ok ? prepared.swap.start() : prepared;
}

function swapRecord(
  swap: PreparedSwap,
  runIds: PerRole<string>,
  startedAt: Date,
  progress: {
    readonly spentUsd: number | null;
    readonly endedAt?: Date;
    readonly stopReason?: StopReason;
    readonly comparisonId?: string;
  },
): SwapRecord {
  const { endedAt, stopReason, comparisonId } = progress;
  return {
    swapId: swap.swapId,
    baselineRunId: runIds.baseline,
    candidateRunId: runIds.candidate,
    budget: { maxCostUsd: swap.maxCostUsd, scope: 'swap' },
    spentUsd: progress.spentUsd,
    segments: [
      {
        segment: 1,
        startedAt: startedAt.toISOString(),
        ...(endedAt === undefined ? {} : { endedAt: endedAt.toISOString() }),
        spentUsd: progress.spentUsd,
      },
    ],
    status: endedAt === undefined ? 'running' : stopReason === undefined ? 'complete' : 'partial',
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(comparisonId === undefined ? {} : { comparisonId }),
  };
}

/** No comparison on `config-error`, nor when neither run finished a trial (FR-032 item 3). */
function comparesAfterStop(stopReason: StopReason | undefined, runs: PerRole<RunEnd>): boolean {
  if (stopReason === undefined) {
    return true;
  }
  if (stopReason === 'config-error') {
    return false;
  }
  return ROLES.some((role) => {
    const { manifest, lines } = runs[role];
    const caseIds = new Set(manifest.cases.map((runCase) => runCase.id));
    return finishedTrials(lines, manifest.limits.retries, caseIds).length > 0;
  });
}

/** The cases both runs send, with their case hashes; the comparison keeps the common ones. */
function currentCases(runs: PerRole<PreparedRun>): CurrentCase[] {
  const cases = new Map<string, CurrentCase>();
  for (const role of ROLES) {
    for (const spec of runs[role].cases) {
      if (!cases.has(spec.id)) {
        cases.set(spec.id, { definition: spec.definition, hash: spec.hash, lang: spec.lang });
      }
    }
  }
  return [...cases.values()];
}

async function compareRuns(
  swap: PreparedSwap,
  request: SwapRequest,
  runs: PerRole<RunEnd>,
): Promise<{ comparison: Comparison; written: WrittenComparison }> {
  const { project } = request;
  const config = project.config.data;
  const comparison = await buildComparison({
    runs: byRole((role) => ({
      manifest: runs[role].manifest,
      lines: runs[role].lines,
      gradeSet: runs[role].gradeSet,
    })),
    rules: project.ruleFiles.flatMap((file) => file.data.rules),
    cases: currentCases(swap.runs),
    config,
    outputDir: project.paths.outputDir,
    now: request.now ?? (() => new Date()),
  });
  const written = await writeComparison({
    outputDir: project.paths.outputDir,
    comparison,
    lang: request.lang,
  });
  return { comparison, written };
}

interface ClaimedSide<R> {
  begin(shared: SharedRun): Promise<R>;
  abandon(): Promise<void>;
}

interface BegunSide<E> {
  shutdown(): Promise<unknown>;
  finish(): Promise<E>;
}

/**
 * Begins the baseline, then the candidate. A failure leaves no run holding its lock: a baseline
 * that did not begin cleans up after itself and the candidate claim is abandoned; a candidate
 * that did not begin cleans up after itself, the begun baseline ends as a `config-error` stop
 * does, shut down and finished `partial`, and `closeSwap` writes the swap record of that stop.
 * The begin failure is what the caller sees, even when closing the record fails too.
 */
export async function beginRuns<E, R extends BegunSide<E>>(
  claimed: PerRole<ClaimedSide<R>>,
  shared: SharedRun,
  closeSwap: (baseline: E) => Promise<void>,
): Promise<PerRole<R>> {
  let baseline: R;
  try {
    baseline = await claimed.baseline.begin(shared);
  } catch (error) {
    await claimed.candidate.abandon();
    throw error;
  }
  try {
    return { baseline, candidate: await claimed.candidate.begin(shared) };
  } catch (error) {
    shared.stop.raise('config-error');
    await baseline.shutdown();
    const ended = await baseline.finish();
    try {
      await closeSwap(ended);
    } catch {
      // The record stays as written at the start; the begin failure is the error to report.
    }
    throw error;
  }
}

/**
 * The combined start check, then both runs under one cap ledger and one stop: when one run
 * stops, both stop with the same `stopReason`. Both adapters are shut down, which waits for late
 * notifications and responses, before the runs end and are graded. A stopped swap still compares
 * what finished, withheld by the gate, except as FR-032 item 3 says.
 */
async function startSwap(
  swap: PreparedSwap,
  request: SwapRequest,
  startedAt: Date,
): Promise<SwapResult> {
  const { maxCostUsd, runs } = swap;
  if (maxCostUsd !== null && exceedsCap(swap.expectedUsd, maxCostUsd)) {
    await swap.abandon();
    return {
      ok: false,
      failure: { kind: 'over-budget', expectedUsd: swap.expectedUsd, maxCostUsd },
    };
  }
  const claimed = await bothOrNeither(
    (role) => runs[role].claim(),
    (run) => run.abandon(),
  );
  if (!claimed.ok) {
    const { role, failure } = claimed;
    return { ok: false, failure: { kind: 'start', variantId: runs[role].variantId, failure } };
  }
  const runIds = byRole((role) => claimed.runs[role].runId);
  const shared: SharedRun = { ledger: createCapLedger(maxCostUsd, 0), stop: createStopSignal() };
  const { outputDir } = request.project.paths;
  // The record is written before either manifest names the swap, so every run with a swapId has
  // one.
  try {
    await writeSwapRecord(outputDir, swapRecord(swap, runIds, startedAt, { spentUsd: 0 }));
  } catch (error) {
    await Promise.all(ROLES.map((role) => claimed.runs[role].abandon()));
    throw error;
  }
  const now = request.now ?? (() => new Date());
  // Only the baseline began, so its spend is the swap's; the record says what a normal stop says.
  const begun = await beginRuns(claimed.runs, shared, (baseline: RunEnd) =>
    writeSwapRecord(
      outputDir,
      swapRecord(swap, runIds, startedAt, {
        spentUsd: baseline.manifest.totals.costUsd,
        endedAt: now(),
        stopReason: 'config-error',
      }),
    ),
  );
  try {
    await driveRuns([begun.baseline, begun.candidate], shared);
  } finally {
    await Promise.all(ROLES.map((role) => begun[role].shutdown()));
  }
  const [baselineEnd, candidateEnd] = await Promise.all([
    begun.baseline.finish(),
    begun.candidate.finish(),
  ]);
  const ended: PerRole<RunEnd> = { baseline: baselineEnd, candidate: candidateEnd };
  const stopReason = shared.stop.reason;
  const compared = comparesAfterStop(stopReason, ended)
    ? await compareRuns(swap, request, ended)
    : undefined;
  const record = swapRecord(swap, runIds, startedAt, {
    spentUsd: addUsd(ROLES.map((role) => ended[role].manifest.totals.costUsd)),
    endedAt: now(),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(compared === undefined ? {} : { comparisonId: compared.comparison.comparisonId }),
  });
  await writeSwapRecord(outputDir, record);
  return { ok: true, end: { record, runs: ended, ...compared } };
}
