import type { AdapterFault } from '../adapter/client.js';
import type { LogParams } from '../adapter/protocol.js';
import { buildComparison, type CurrentCase } from '../compare/comparison.js';
import { finishedTrials } from '../compare/finished.js';
import type { Project } from '../config/load.js';
import type { Lang, Variant } from '../config/schema.js';
import type { Comparison } from '../report/schema.js';
import { writeComparison, type WrittenComparison } from '../report/write.js';
import type { PerRole } from '../stats/interval.js';
import type { ActiveRun, RunEnd } from './active-run.js';
import { createCapLedger, exceedsCap } from './cap.js';
import { reestimateAtResume } from './drive.js';
import { newSwapId } from './ids.js';
import type { StopReason, SwapRecord } from './manifest.js';
import type { RandomSource } from './retry.js';
import { segmentSpentUsd } from './resume.js';
import {
  prepareResume,
  resumeTotalUsd,
  type PreparedResume,
  type ResumeFailure,
  type ResumeRequest,
} from './resume-run.js';
import type { SetOptions } from './resume-check.js';
import { readSwapRecord, type RunReadProblem } from './run-records.js';
import type { RunCaseSpec } from './run-cases.js';
import {
  conservativeWarning,
  prepareRun,
  runSignals,
  sendAll,
  watchRuns,
  type OverBudget,
  type PreparedRun,
  type RunRequest,
  type RunSignals,
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

export interface SwapRequest extends RunSignals {
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
  /** The result page template; the package's when left out. */
  readonly templateFile?: string;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly onLog?: (params: LogParams) => void;
  readonly onStderr?: (line: string) => void;
  readonly onAdapterFault?: (variantId: string, fault: AdapterFault) => void;
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
  /**
   * A second interrupt came after sending: nothing was compared and `record` stays as written
   * at the start, `running`, so `swap --resume` compares without sending.
   */
  readonly quit?: true;
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
    ...(request.onAdapterFault === undefined ? {} : { onAdapterFault: request.onAdapterFault }),
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

/** What every write of one segment's swap record shares. */
interface SwapSegment {
  readonly swapId: string;
  readonly runIds: PerRole<string>;
  readonly maxCostUsd: number | null;
  /** Segments of earlier starts; none for a new swap. */
  readonly earlier: SwapRecord['segments'];
  readonly startedAt: Date;
}

interface SwapProgress {
  /** Spend of both runs over every segment. */
  readonly spentUsd: number | null;
  /** Spend of this segment; the whole spend when absent. */
  readonly segmentSpentUsd?: number | null;
  readonly endedAt?: Date;
  readonly stopReason?: StopReason;
  readonly comparisonId?: string;
}

function swapRecord(segment: SwapSegment, progress: SwapProgress): SwapRecord {
  const { endedAt, stopReason, comparisonId } = progress;
  return {
    swapId: segment.swapId,
    baselineRunId: segment.runIds.baseline,
    candidateRunId: segment.runIds.candidate,
    budget: { maxCostUsd: segment.maxCostUsd, scope: 'swap' },
    spentUsd: progress.spentUsd,
    segments: [
      ...segment.earlier,
      {
        segment: (segment.earlier.at(-1)?.segment ?? 0) + 1,
        startedAt: segment.startedAt.toISOString(),
        ...(endedAt === undefined ? {} : { endedAt: endedAt.toISOString() }),
        spentUsd: progress.segmentSpentUsd ?? progress.spentUsd,
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
function currentCases(runs: PerRole<readonly RunCaseSpec[]>): CurrentCase[] {
  const cases = new Map<string, CurrentCase>();
  for (const role of ROLES) {
    for (const spec of runs[role]) {
      if (!cases.has(spec.id)) {
        cases.set(spec.id, { definition: spec.definition, hash: spec.hash, lang: spec.lang });
      }
    }
  }
  return [...cases.values()];
}

/** What the comparison of a swap needs besides its runs. */
interface CompareSetting {
  readonly project: Project;
  readonly lang: Lang;
  readonly templateFile?: string;
  readonly now?: () => Date;
}

async function compareRuns(
  request: CompareSetting,
  cases: PerRole<readonly RunCaseSpec[]>,
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
    cases: currentCases(cases),
    config,
    outputDir: project.paths.outputDir,
    now: request.now ?? (() => new Date()),
  });
  const written = await writeComparison({
    outputDir: project.paths.outputDir,
    comparison,
    lang: request.lang,
    ...(request.templateFile === undefined ? {} : { templateFile: request.templateFile }),
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
 * The begin failure is what the caller sees, even when shutting down or finishing the baseline,
 * or closing the record, fails too.
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
    // The begin failure is the error to report; a step that fails here leaves the baseline's
    // records and the swap record as written so far.
    try {
      await baseline.shutdown();
    } catch {
      // The adapter process is already gone or will be when this process exits.
    }
    try {
      await closeSwap(await baseline.finish());
    } catch {
      // The swap record stays as written at the start.
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
  const end = await runClaimedSwap(request, claimed.runs, {
    segment: {
      swapId: swap.swapId,
      runIds: byRole((role) => claimed.runs[role].runId),
      maxCostUsd,
      earlier: [],
      startedAt,
    },
    cases: byRole((role) => runs[role].cases),
    spentUsd: 0,
  });
  return { ok: true, end };
}

/** How {@link runClaimedSwap} starts: a new swap or a resumed one. */
interface SwapStart {
  readonly segment: SwapSegment;
  readonly cases: PerRole<readonly RunCaseSpec[]>;
  /** Spend of earlier segments, which the cap includes. */
  readonly spentUsd: number | null;
  /** The resume re-estimate, before any trial goes out. */
  readonly beforeSending?: (runs: readonly ActiveRun[], shared: SharedRun) => Promise<void>;
}

interface ClaimedSwapSide extends ClaimedSide<ActiveRun> {
  readonly runId: string;
}

/**
 * Both claimed runs under one cap ledger and one stop: when one run stops, both stop with the
 * same `stopReason`. Both adapters are shut down, which waits for late notifications and
 * responses, before the runs end and are graded. A stopped swap still compares what finished,
 * withheld by the gate, except as FR-032 item 3 says.
 */
async function runClaimedSwap(
  request: SwapRequest | SwapResumeRequest,
  claimed: PerRole<ClaimedSwapSide>,
  start: SwapStart,
): Promise<SwapEnd> {
  const { segment } = start;
  const shared: SharedRun = {
    ledger: createCapLedger(segment.maxCostUsd, start.spentUsd),
    stop: createStopSignal(),
  };
  const { outputDir } = request.project.paths;
  // The record is written before either manifest names the swap, so every run with a swapId has
  // one.
  try {
    await writeSwapRecord(outputDir, swapRecord(segment, { spentUsd: start.spentUsd }));
  } catch (error) {
    await Promise.all(ROLES.map((role) => claimed[role].abandon()));
    throw error;
  }
  const now = request.now ?? (() => new Date());
  // Only the baseline began, so this segment's spend is its own; the record says what a normal
  // stop says.
  const begun = await beginRuns(claimed, shared, (baseline: RunEnd) => {
    const segmentSpent = currentSegmentSpentUsd(baseline);
    return writeSwapRecord(
      outputDir,
      swapRecord(segment, {
        spentUsd: addUsd([start.spentUsd, segmentSpent]),
        segmentSpentUsd: segmentSpent,
        endedAt: now(),
        stopReason: 'config-error',
      }),
    );
  });
  const both = [begun.baseline, begun.candidate];
  const watch = watchRuns(runSignals(request), shared, both);
  try {
    const { beforeSending } = start;
    await sendAll(
      both,
      shared,
      watch,
      beforeSending === undefined ? undefined : () => beforeSending(both, shared),
    );
    const [baselineEnd, candidateEnd] = await Promise.all([
      begun.baseline.finish(),
      begun.candidate.finish(),
    ]);
    const ended: PerRole<RunEnd> = { baseline: baselineEnd, candidate: candidateEnd };
    // A second interrupt exits at once and compares nothing (data-model §Run and Swap Status).
    // While grading it left the runs as they ended, so the record stays `running` rather than
    // claim a stop the runs did not make.
    if (watch.quit && !watch.cut) {
      return { record: swapRecord(segment, { spentUsd: start.spentUsd }), runs: ended, quit: true };
    }
    const compared =
      !watch.cut && comparesAfterStop(shared.stop.reason, ended)
        ? await compareRuns(request, start.cases, ended)
        : undefined;
    const stopReason = shared.stop.reason;
    const record = swapRecord(segment, {
      spentUsd: addUsd(ROLES.map((role) => ended[role].manifest.totals.costUsd)),
      segmentSpentUsd: addUsd(ROLES.map((role) => currentSegmentSpentUsd(ended[role]))),
      endedAt: now(),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(compared === undefined ? {} : { comparisonId: compared.comparison.comparisonId }),
    });
    await writeSwapRecord(outputDir, record);
    return { record, runs: ended, ...compared };
  } finally {
    watch.dispose();
  }
}

function currentSegmentSpentUsd(end: RunEnd): number | null {
  const current = end.manifest.segments.at(-1)?.segment ?? 1;
  return segmentSpentUsd(end.lines, current);
}

// Resuming a swap check (data-model §Resume and Locking, rule 12).

export interface SwapResumeRequest extends RunSignals {
  readonly project: Project;
  readonly swapId: string;
  /** `--from` and `--to` when given; they must name the recorded variants. */
  readonly from?: string;
  readonly to?: string;
  /** `--repeats` and `--cases` when given; they must match the records. */
  readonly repeats?: number;
  readonly cases?: string;
  readonly concurrency: number;
  /** One cap over both runs and every earlier segment. */
  readonly maxCostUsd: number | null;
  readonly tool: ToolVersion;
  readonly lang: Lang;
  /** The result page template; the package's when left out. */
  readonly templateFile?: string;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly onLog?: (params: LogParams) => void;
  readonly onStderr?: (line: string) => void;
  readonly onAdapterFault?: (variantId: string, fault: AdapterFault) => void;
}

/** Every failure ends as a configuration error (exit code 4) before any model call. */
export type SwapResumeFailure =
  | { readonly kind: 'swap-record'; readonly swapId: string; readonly problem: RunReadProblem }
  /** Resume finishes stopped swaps; a complete one is not resent. */
  | { readonly kind: 'swap-complete'; readonly swapId: string }
  | { readonly kind: 'run'; readonly runId: string; readonly failure: ResumeFailure };

export interface PreparedSwapResume {
  readonly swapId: string;
  readonly runs: PerRole<PreparedResume>;
  /** The re-estimated total: spent over both runs and earlier segments plus what remains. */
  readonly expectedUsd: number | null;
  readonly maxCostUsd: number | null;
  /** Resume warnings of both runs' new segments. */
  readonly warnings: readonly Warning[];
  start(): Promise<SwapResumeResult>;
  abandon(): Promise<void>;
}

export type PrepareSwapResumeResult =
  | { readonly ok: true; readonly swap: PreparedSwapResume }
  | { readonly ok: false; readonly failure: SwapResumeFailure };

export type SwapResumeResult =
  | { readonly ok: true; readonly end: SwapEnd }
  | { readonly ok: false; readonly failure: SwapResumeFailure };

/**
 * Prepares both runs of the swap with their recorded variants. When both finished but the swap
 * did not (killed before comparing), nothing is sent and the swap compares.
 */
export async function prepareSwapResume(
  request: SwapResumeRequest,
): Promise<PrepareSwapResumeResult> {
  const { swapId, project } = request;
  const read = await readSwapRecord(project.paths.outputDir, swapId);
  if (!read.ok) {
    return { ok: false, failure: { kind: 'swap-record', swapId, problem: read.problem } };
  }
  const { record } = read;
  if (record.status === 'complete') {
    return { ok: false, failure: { kind: 'swap-complete', swapId } };
  }
  const runIds: PerRole<string> = {
    baseline: record.baselineRunId,
    candidate: record.candidateRunId,
  };
  const chosen: PerRole<string | undefined> = { baseline: request.from, candidate: request.to };
  const option = (role: Role): SetOptions['variant'] => {
    const id = chosen[role];
    return id === undefined ? undefined : { option: role === 'baseline' ? 'from' : 'to', id };
  };
  const resumeRequest = (role: Role): ResumeRequest => {
    const variant = option(role);
    return {
      project,
      runId: runIds[role],
      command: 'swap',
      set: {
        ...(variant === undefined ? {} : { variant }),
        ...(request.repeats === undefined ? {} : { repeats: request.repeats }),
        ...(request.cases === undefined ? {} : { cases: request.cases }),
      },
      concurrency: request.concurrency,
      maxCostUsd: request.maxCostUsd,
      tool: request.tool,
      ...(request.now === undefined ? {} : { now: request.now }),
      ...(request.random === undefined ? {} : { random: request.random }),
      ...(request.onLog === undefined ? {} : { onLog: request.onLog }),
      ...(request.onStderr === undefined ? {} : { onStderr: request.onStderr }),
      ...(request.onAdapterFault === undefined ? {} : { onAdapterFault: request.onAdapterFault }),
    };
  };
  const prepared = await bothOrNeither(
    (role) => prepareResume(resumeRequest(role)),
    (run) => run.abandon(),
  );
  if (!prepared.ok) {
    const { role, failure } = prepared;
    return { ok: false, failure: { kind: 'run', runId: runIds[role], failure } };
  }
  const { runs } = prepared;
  const swap: PreparedSwapResume = {
    swapId,
    runs,
    expectedUsd: resumeTotalUsd([runs.baseline, runs.candidate]),
    maxCostUsd: request.maxCostUsd,
    warnings: [...runs.baseline.warnings, ...runs.candidate.warnings],
    start: () => startSwapResume(request, record, runs),
    abandon: async () => {
      await Promise.all(ROLES.map((role) => runs[role].abandon()));
    },
  };
  return { ok: true, swap };
}

/**
 * Locks and repairs both runs, starts a segment of each and of the swap record under one cap
 * that includes earlier spend, re-estimates before sending and interleaves the remaining trials.
 */
async function startSwapResume(
  request: SwapResumeRequest,
  record: SwapRecord,
  runs: PerRole<PreparedResume>,
): Promise<SwapResumeResult> {
  const claimed = await bothOrNeither(
    (role) => runs[role].claim(),
    (run) => run.abandon(),
  );
  if (!claimed.ok) {
    const { role, failure } = claimed;
    return { ok: false, failure: { kind: 'run', runId: runs[role].runId, failure } };
  }
  const now = request.now ?? (() => new Date());
  const end = await runClaimedSwap(request, claimed.runs, {
    segment: {
      swapId: record.swapId,
      runIds: byRole((role) => runs[role].runId),
      maxCostUsd: request.maxCostUsd,
      earlier: record.segments,
      startedAt: now(),
    },
    cases: byRole((role) => runs[role].cases),
    spentUsd: addUsd(ROLES.map((role) => claimed.runs[role].spentUsd)),
    beforeSending: (begun, shared) => reestimateAtResume(begun, shared),
  });
  return { ok: true, end };
}
