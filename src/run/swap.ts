import type { LogParams } from '../adapter/protocol.js';
import { buildComparison, type CurrentCase } from '../compare/comparison.js';
import { finishedTrials } from '../compare/finished.js';
import type { Project } from '../config/load.js';
import type { Lang, Variant } from '../config/schema.js';
import { createRedactor } from '../report/redact.js';
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
  const [baseline, candidate] = await Promise.all([
    prepareRun(runRequest(request.baseline)),
    prepareRun(runRequest(request.candidate)),
  ]);
  if (!baseline.ok) {
    if (candidate.ok) {
      await candidate.run.abandon();
    }
    return {
      ok: false,
      failure: { kind: 'start', variantId: request.baseline.id, failure: baseline.failure },
    };
  }
  if (!candidate.ok) {
    await baseline.run.abandon();
    return {
      ok: false,
      failure: { kind: 'start', variantId: request.candidate.id, failure: candidate.failure },
    };
  }
  const runs: PerRole<PreparedRun> = { baseline: baseline.run, candidate: candidate.run };
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
    baselineRunId: swap.runs.baseline.runId,
    candidateRunId: swap.runs.candidate.runId,
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
        cases.set(spec.id, { definition: spec.definition, hash: spec.hash });
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
    redactor: createRedactor(config.redact),
  });
  return { comparison, written };
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
  const shared: SharedRun = { ledger: createCapLedger(maxCostUsd, 0), stop: createStopSignal() };
  const baseline = await runs.baseline.begin(shared);
  if (!baseline.ok) {
    await runs.candidate.abandon();
    return {
      ok: false,
      failure: { kind: 'start', variantId: runs.baseline.variantId, failure: baseline.failure },
    };
  }
  const candidate = await runs.candidate.begin(shared);
  if (!candidate.ok) {
    shared.stop.raise('config-error');
    await baseline.run.shutdown();
    await baseline.run.finish();
    return {
      ok: false,
      failure: { kind: 'start', variantId: runs.candidate.variantId, failure: candidate.failure },
    };
  }
  await writeSwapRecord(
    request.project.paths.outputDir,
    swapRecord(swap, startedAt, { spentUsd: 0 }),
  );
  const active = [baseline.run, candidate.run];
  try {
    await driveRuns(active, shared);
  } finally {
    await Promise.all(active.map((run) => run.shutdown()));
  }
  const [baselineEnd, candidateEnd] = await Promise.all([
    baseline.run.finish(),
    candidate.run.finish(),
  ]);
  const ended: PerRole<RunEnd> = { baseline: baselineEnd, candidate: candidateEnd };
  const stopReason = shared.stop.reason;
  const compared = comparesAfterStop(stopReason, ended)
    ? await compareRuns(swap, request, ended)
    : undefined;
  const record = swapRecord(swap, startedAt, {
    spentUsd: addUsd(ROLES.map((role) => ended[role].manifest.totals.costUsd)),
    endedAt: (request.now ?? (() => new Date()))(),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(compared === undefined ? {} : { comparisonId: compared.comparison.comparisonId }),
  });
  await writeSwapRecord(request.project.paths.outputDir, record);
  return { ok: true, end: { record, runs: ended, ...compared } };
}
