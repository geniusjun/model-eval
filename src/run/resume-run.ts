import path from 'node:path';

import type { AdapterFault } from '../adapter/client.js';
import type { LogParams } from '../adapter/protocol.js';
import type { Project } from '../config/load.js';
import { NO_LANGUAGE } from '../grade/grade.js';
import { ActiveRun, type RunEnd } from './active-run.js';
import { createCapLedger, reestimate, type VariantProjection } from './cap.js';
import {
  attemptCharge,
  costProfiles,
  expectedEstimate,
  pricingWarnings,
  plannedUsage,
  refusesUnpricedVariant,
  type CasePlan,
  type Charge,
  type ChargeContext,
  type ExpectedEstimate,
  type Pricing,
  type ProfileMap,
} from './cost.js';
import { reestimateAtResume } from './drive.js';
import { launchHash, rulesHash } from './hashes.js';
import { previousProfiles } from './history.js';
import { acquireRunLock, type HeldLock } from './lock.js';
import type { Manifest, Segment } from './manifest.js';
import { sendOrder, type SendPlan } from './order.js';
import type { AttemptLine, SendLine, TrialLine } from './records.js';
import { mergeListWarnings } from './merge-warnings.js';
import { renderCases, type RenderedCases } from './render-cases.js';
import type { RandomSource } from './retry.js';
import {
  checkCases,
  checkGeneration,
  ignoredConfigFields,
  joinedToolPaths,
  optionRefusal,
  recordedOptions,
  resumeWarnings,
  statusRefusal,
  type ResumeRefusal,
  type SetOptions,
} from './resume-check.js';
import {
  recount,
  repairedLines,
  repairRunRecords,
  segmentSpentUsd,
  trialsToSend,
} from './resume.js';
import { readRunRecords, type RunReadProblem, type RunRecords } from './run-records.js';
import { runCases, targetLanguages, type RunCaseSpec } from './run-cases.js';
import {
  launchAdapter,
  matchedToolPaths,
  runSignals,
  sendAll,
  startReservationUsd,
  watchRuns,
  variantPrice,
  type Listened,
  type RunSignals,
  type RunStartFailure,
  type SharedRun,
  type ToolVersion,
  type VariantPlan,
} from './runner.js';
import { createStopSignal } from './stopping.js';
import { TrialBook } from './trial-book.js';
import type { Warning } from './warning.js';
import { openTrialLog, RUN_FILES, runDirectoryPath } from './writer.js';

// A stopped or killed run resumed as a new segment (data-model §Resume and Locking, FR-013).

export interface ResumeRequest extends RunSignals {
  readonly project: Project;
  readonly runId: string;
  /** `swap` resumes a run of a swap check; `run` refuses one. */
  readonly command: 'run' | 'swap';
  readonly set: SetOptions;
  /** `--concurrency`, else `run.concurrency`; stored per segment. */
  readonly concurrency: number;
  /** The cap over every segment; stored per segment. */
  readonly maxCostUsd: number | null;
  readonly tool: ToolVersion;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly onLog?: (params: LogParams) => void;
  readonly onStderr?: (line: string) => void;
  readonly onAdapterFault?: (variantId: string, fault: AdapterFault) => void;
}

/** Every failure ends as a configuration error (exit code 4) before any model call. */
export type ResumeFailure =
  | RunStartFailure
  | { readonly kind: 'records'; readonly runId: string; readonly problem: RunReadProblem }
  | { readonly kind: 'refused'; readonly runId: string; readonly refusal: ResumeRefusal };

/** A resumable run whose adapter started and whose conditions hold; nothing is written yet. */
export interface PreparedResume {
  readonly runId: string;
  readonly variantId: string;
  readonly manifest: Manifest;
  /** The remaining trials, for the `--dry-run` plan. */
  readonly plan: VariantPlan;
  readonly cases: readonly RunCaseSpec[];
  /** Spend recounted from the records, unclosed send lines at their reservation. */
  readonly spentUsd: number | null;
  /** This run's part of the re-estimate before sending. */
  readonly projection: VariantProjection;
  /** `resume-unverified` and `resume-config-ignored` of the new segment. */
  readonly warnings: readonly Warning[];
  readonly signals: RunSignals;
  /** Takes `run.lock` and repairs the records; a failure shuts the adapter down. */
  claim(): Promise<ClaimResumeResult>;
  /** Shuts the adapter down without writing anything. */
  abandon(): Promise<void>;
}

/** A locked and repaired run whose new segment has not started. */
export interface ClaimedResume {
  readonly runId: string;
  /** Spend recounted after the repair. */
  readonly spentUsd: number | null;
  begin(shared: SharedRun): Promise<ActiveRun>;
  /** Releases the lock and shuts the adapter down. */
  abandon(): Promise<void>;
}

export type PrepareResumeResult =
  | { readonly ok: true; readonly run: PreparedResume }
  | { readonly ok: false; readonly failure: ResumeFailure };

export type ClaimResumeResult =
  | { readonly ok: true; readonly run: ClaimedResume }
  | { readonly ok: false; readonly failure: ResumeFailure };

/** Everything the new segment needs once the checks passed. */
interface Checked {
  readonly request: ResumeRequest;
  readonly records: RunRecords;
  readonly adapter: Listened;
  readonly toolPaths: readonly string[];
  readonly cases: readonly RunCaseSpec[];
  readonly rendered: RenderedCases;
  readonly previous: ProfileMap;
  readonly expected: ExpectedEstimate;
  readonly sendPlan: SendPlan;
  readonly warnings: readonly Warning[];
}

function attemptsOf(lines: readonly TrialLine[]): AttemptLine[] {
  return lines.filter((line): line is AttemptLine => 'status' in line);
}

function langOf(cases: readonly RunCaseSpec[]): (caseId: string) => string {
  const langs = new Map(cases.map((spec) => [spec.id, spec.lang]));
  return (caseId) => langs.get(caseId) ?? NO_LANGUAGE;
}

/** A book over the earlier attempt lines: what is finished and what goes out. */
function resumedBook(
  checked: Pick<Checked, 'sendPlan' | 'cases' | 'records'>,
  lines: readonly TrialLine[],
  random: RandomSource,
): TrialBook {
  return new TrialBook(
    checked.sendPlan,
    langOf(checked.cases),
    checked.records.manifest.limits.retries,
    random,
    attemptsOf(lines),
  );
}

function projectionOf(checked: Checked, lines: readonly TrialLine[]): VariantProjection {
  const book = resumedBook(checked, lines, Math.random);
  const retries = checked.records.manifest.limits.retries;
  return {
    firstBatchFinished: book.firstBatchFinished(),
    measured: costProfiles(lines, langOf(checked.cases), retries),
    expected: checked.expected.perTrial,
    remaining: book.remaining(),
  };
}

function remainingPlan(checked: Checked, lines: readonly TrialLine[]): VariantPlan {
  const { manifest } = checked.records;
  const config = checked.request.project.config.data;
  const plans = checked.rendered.plans;
  const remaining = trialsToSend(lines, checked.sendPlan.keys, manifest.limits.retries);
  const casePlans = remaining.flatMap((key) => {
    const plan = plans.get(key.caseId);
    return plan === undefined ? [] : [plan];
  });
  const price = variantPrice(config.pricing, manifest.variant.model);
  return {
    variant: manifest.variant.id,
    trials: remaining.length,
    ...plannedUsage({
      cases: casePlans,
      repeats: 1,
      outputTokens: config.estimate.outputTokens,
      price,
      previous: checked.previous,
    }),
    basis: checked.expected.basis,
    reservationUsd: startReservationUsd(
      config.pricing,
      manifest.variant,
      [...plans.values()],
      config.estimate.outputTokens,
      checked.previous,
    ),
  };
}

/**
 * Reads the run, refuses what data-model §Resume and Locking refuses, starts the adapter with the
 * recorded variant and time limit and the joined `toolPaths`, re-renders every case and compares
 * the generation conditions. Nothing is written.
 */
export async function prepareResume(request: ResumeRequest): Promise<PrepareResumeResult> {
  const { project, runId } = request;
  const config = project.config.data;
  const read = await readRunRecords(runDirectoryPath(project.paths.outputDir, runId));
  if (!read.ok) {
    return { ok: false, failure: { kind: 'records', runId, problem: read.problem } };
  }
  const records = read.run;
  const { manifest } = records;
  const refused = (refusal: ResumeRefusal): PrepareResumeResult => ({
    ok: false,
    failure: { kind: 'refused', runId, refusal },
  });
  const early =
    statusRefusal(manifest, request.command) ??
    optionRefusal(recordedOptions(manifest, request.set));
  if (early !== undefined) {
    return refused(early);
  }
  if (refusesUnpricedVariant(config.pricing, manifest.variant.model, request.maxCostUsd)) {
    return { ok: false, failure: { kind: 'unpriced-variant', model: manifest.variant.model } };
  }
  const paths = joinedToolPaths(manifest.segments, await matchedToolPaths(project));
  const { id, model, params } = manifest.variant;
  const launched = await launchAdapter(request, {
    variant: { id, model, ...(params === undefined ? {} : { params }) },
    timeoutMs: manifest.limits.timeoutMs,
    toolPaths: paths,
  });
  if (!launched.ok) {
    return launched;
  }
  const { adapter } = launched;
  try {
    const checked = await checkResumed(request, records, adapter, paths);
    if (!checked.ok) {
      await adapter.client.shutdown();
      return checked;
    }
    return { ok: true, run: preparedResume(checked.checked) };
  } catch (error) {
    await adapter.client.shutdown();
    throw error;
  }
}

type CheckResult =
  | { readonly ok: true; readonly checked: Checked }
  | { readonly ok: false; readonly failure: ResumeFailure };

async function checkResumed(
  request: ResumeRequest,
  records: RunRecords,
  adapter: Listened,
  paths: readonly string[],
): Promise<CheckResult> {
  const { project, runId } = request;
  const config = project.config.data;
  const { manifest } = records;
  const { info } = adapter.client;
  const selected = runCases(project, info.targets, manifest.sampling.cases);
  if (!selected.ok) {
    return { ok: false, failure: { kind: 'cases', problems: selected.problems } };
  }
  const cases = checkCases(manifest, selected.cases);
  if (cases.refusal !== undefined) {
    return { ok: false, failure: { kind: 'refused', runId, refusal: cases.refusal } };
  }
  const rendered = await renderCases(
    adapter.client,
    cases.cases,
    manifest.sampling.seed,
    config.estimate.inputTokens,
  );
  if (!rendered.ok) {
    return { ok: false, failure: { kind: 'render', failures: rendered.failures } };
  }
  const generation = checkGeneration(manifest, {
    info,
    launchHash: launchHash({
      command: config.adapter.command,
      env: config.adapter.env,
      cwd: project.paths.adapterCwd,
    }),
    prompts: info.capabilities.render ? rendered.rendered.prompts : undefined,
  });
  if (generation.refusal !== undefined) {
    return { ok: false, failure: { kind: 'refused', runId, refusal: generation.refusal } };
  }
  const previous = await previousProfiles(project.paths.outputDir, manifest.variant.fingerprint);
  const plans: CasePlan[] = [...rendered.rendered.plans.values()];
  return {
    ok: true,
    checked: {
      request,
      records,
      adapter,
      toolPaths: paths,
      cases: cases.cases,
      rendered: rendered.rendered,
      previous,
      expected: expectedEstimate({
        cases: plans,
        repeats: manifest.sampling.repeats,
        outputTokens: config.estimate.outputTokens,
        price: variantPrice(config.pricing, manifest.variant.model),
        previous,
      }),
      sendPlan: sendOrder(cases.cases, targetLanguages(info.targets), manifest.sampling.repeats),
      warnings: resumeWarnings(
        manifest.variant.id,
        generation.unverified,
        ignoredConfigFields(manifest, config),
        cases.leftOut,
      ),
    },
  };
}

function preparedResume(checked: Checked): PreparedResume {
  const { records, request, adapter } = checked;
  // Until the lock is held, unclosed send lines are closed in memory only.
  const lines = repairedLines(records);
  return {
    runId: request.runId,
    variantId: records.manifest.variant.id,
    manifest: records.manifest,
    plan: remainingPlan(checked, lines),
    cases: checked.cases,
    spentUsd: recount(lines, 0).spentUsd,
    projection: projectionOf(checked, lines),
    warnings: checked.warnings,
    signals: runSignals(request),
    claim: () => claimResume(checked),
    abandon: async () => {
      await adapter.client.shutdown();
    },
  };
}

/**
 * Takes the lock, reads the records again (a dead owner may have written after the first read),
 * truncates a cut last line and closes unanswered send lines.
 */
async function claimResume(checked: Checked): Promise<ClaimResumeResult> {
  const { request, adapter } = checked;
  const { runDir } = checked.records;
  const now = request.now ?? (() => new Date());
  const fail = async (failure: ResumeFailure): Promise<ClaimResumeResult> => {
    await adapter.client.shutdown();
    return { ok: false, failure };
  };
  const locked = await acquireRunLock(runDir, { now: now() });
  if (!locked.ok) {
    return fail({ kind: 'lock', refusal: locked.refusal });
  }
  const { lock } = locked;
  try {
    const read = await readRunRecords(runDir);
    const refusal = read.ok ? statusRefusal(read.run.manifest, request.command) : undefined;
    if (!read.ok || refusal !== undefined) {
      await lock.release();
      return await fail(
        read.ok
          ? { kind: 'refused', runId: request.runId, refusal: refusal ?? { kind: 'complete' } }
          : { kind: 'records', runId: request.runId, problem: read.problem },
      );
    }
    const records = read.run;
    // Nothing is written until the run begins, so a swap whose other run is refused here leaves
    // these records as they were.
    const lines = repairedLines(records);
    return {
      ok: true,
      run: {
        runId: request.runId,
        spentUsd: recount(lines, 0).spentUsd,
        begin: async (shared) => {
          try {
            await repairRunRecords(records);
            return await beginResumed({ ...checked, records }, lines, lock, shared);
          } catch (error) {
            try {
              await lock.release();
            } finally {
              await adapter.client.shutdown();
            }
            throw error;
          }
        },
        abandon: async () => {
          try {
            await lock.release();
          } finally {
            await adapter.client.shutdown();
          }
        },
      },
    };
  } catch (error) {
    await lock.release();
    await adapter.client.shutdown();
    throw error;
  }
}

/** The charge of one earlier line at its segment's prices, for the models it names. */
function lineCharge(
  line: Exclude<TrialLine, SendLine>,
  pricing: Pricing,
  variantModel: string,
): Charge {
  // Only the models matter here, so reservations are sized at zero tokens.
  const context: ChargeContext = {
    pricing,
    variantModel,
    tokens: { input: 0, output: 0 },
    billedCalls: 1,
  };
  const unanswered =
    'status' in line &&
    (line.status === 'stopped' || (line.status === 'error' && line.error.abandoned !== undefined));
  return attemptCharge(
    unanswered ? { answered: false } : { answered: true, usage: line.usage, calls: line.calls },
    context,
  );
}

/**
 * `unpriced-model` and `cached-input-unpriced` of the earlier segments, recounted from their lines
 * with the prices and cap each segment had, so a resume under another cap keeps them.
 */
function earlierPricingWarnings(manifest: Manifest, lines: readonly TrialLine[]): Warning[] {
  return manifest.segments.flatMap((segment) => {
    const charges = lines.flatMap((line) =>
      'sending' in line || line.segment !== segment.segment
        ? []
        : [lineCharge(line, segment.pricing, manifest.variant.model)],
    );
    return pricingWarnings({
      variantId: manifest.variant.id,
      maxCostUsd: segment.maxCostUsd,
      unpricedModels: charges.flatMap((charge) => charge.unpricedModels),
      cachedInputUnpricedModels: charges.flatMap((charge) => charge.cachedInputUnpricedModels),
    });
  });
}

/**
 * Warnings of the starts that no record of this segment raises: the first start's
 * `estimate-low-accuracy`, the resume warnings of every segment, and earlier pricing warnings.
 */
function startWarnings(
  manifest: Manifest,
  segments: readonly Segment[],
  lines: readonly TrialLine[],
): Warning[] {
  return mergeListWarnings([
    ...manifest.warnings.filter((warning) => warning.code === 'estimate-low-accuracy'),
    ...segments.flatMap((segment) => segment.resumeWarnings),
    ...earlierPricingWarnings(manifest, lines),
  ]);
}

function newSegment(checked: Checked, shared: SharedRun, startedAt: Date): Segment {
  const { request, adapter, records } = checked;
  const last = records.manifest.segments.at(-1)?.segment ?? 0;
  const { helper } = adapter.client.info.adapter;
  return {
    segment: last + 1,
    startedAt: startedAt.toISOString(),
    tool: { version: request.tool.version },
    adapter: {
      version: adapter.client.info.adapter.version,
      ...(helper === undefined ? {} : { helper }),
    },
    pricing: request.project.config.data.pricing,
    maxCostUsd: shared.ledger.maxCostUsd,
    concurrency: request.concurrency,
    toolPaths: [...checked.toolPaths],
    spentUsd: 0,
    resumeWarnings: [...checked.warnings],
  };
}

/**
 * The manifest of the new segment: `running` again, the current prices and cap, totals and the
 * spend of each earlier segment recounted, and the rules hash of the rules that grade it.
 */
async function beginResumed(
  checked: Checked,
  lines: readonly TrialLine[],
  lock: HeldLock,
  shared: SharedRun,
): Promise<ActiveRun> {
  const { request, records, adapter } = checked;
  const { manifest, runDir } = records;
  const config = request.project.config.data;
  const now = request.now ?? (() => new Date());
  const segment = newSegment(checked, shared, now());
  const earlier = manifest.segments.map((each) => ({
    ...each,
    spentUsd: segmentSpentUsd(lines, each.segment),
  }));
  const segments = [...earlier, segment];
  const rules = request.project.ruleFiles.flatMap((file) => file.data.rules);
  const hash = rulesHash(
    rules,
    checked.cases.map((spec) => spec.definition),
  );
  const { stopReason: _stopReason, ...kept } = manifest;
  const resumed: Manifest = {
    ...kept,
    rulesHash: hash,
    pricing: config.pricing,
    budget: { ...manifest.budget, maxCostUsd: shared.ledger.maxCostUsd },
    totals: recount(lines, manifest.totals.durationMs).totals,
    segments,
    status: 'running',
  };
  const log = await openTrialLog(path.join(runDir, RUN_FILES.trials));
  await adapter.adapterLog.open(path.join(runDir, RUN_FILES.adapterLog));
  const active = new ActiveRun({
    runId: request.runId,
    runDir,
    earlier: lines,
    startWarnings: startWarnings(manifest, segments, lines),
    config,
    rules,
    cases: checked.cases,
    plans: checked.rendered.plans,
    expectedPerTrial: checked.expected.perTrial,
    previous: checked.previous,
    client: adapter.client,
    router: adapter.router,
    book: resumedBook(checked, lines, request.random ?? Math.random),
    log,
    lock,
    ledger: shared.ledger,
    stop: shared.stop,
    manifest: resumed,
    rulesHash: hash,
    checkerVersion: request.tool.version,
    now,
    adapterLog: adapter.adapterLog,
    stderr: adapter.stderr,
    matchedToolPaths: () => matchedToolPaths(request.project),
    onAdapterFault: (fault) => {
      request.onAdapterFault?.(manifest.variant.id, fault);
    },
  });
  await active.writeSegmentStart();
  return active;
}

/** The re-estimate before sending: spent + remaining trials at measured means. */
export function resumeTotalUsd(runs: readonly PreparedResume[]): number | null {
  const spent = runs.reduce<number | null>(
    (total, run) => (total === null || run.spentUsd === null ? null : total + run.spentUsd),
    0,
  );
  return reestimate(
    spent,
    runs.map((run) => run.projection),
  );
}

export type ResumeResult =
  | { readonly ok: true; readonly end: RunEnd }
  | { readonly ok: false; readonly failure: ResumeFailure };

/**
 * `run --resume`: lock and repair, a new segment under a cap that includes earlier spend, the
 * re-estimate first (`budget-projected` without a send), then the remaining trials.
 */
export async function startResumedRun(
  run: PreparedResume,
  maxCostUsd: number | null,
): Promise<ResumeResult> {
  const claimed = await run.claim();
  if (!claimed.ok) {
    return { ok: false, failure: claimed.failure };
  }
  const shared: SharedRun = {
    ledger: createCapLedger(maxCostUsd, claimed.run.spentUsd),
    stop: createStopSignal(),
  };
  const active = await claimed.run.begin(shared);
  const watch = watchRuns(run.signals, shared, [active]);
  try {
    await sendAll([active], shared, watch, () => reestimateAtResume([active], shared));
    return { ok: true, end: await active.finish() };
  } finally {
    watch.dispose();
  }
}
