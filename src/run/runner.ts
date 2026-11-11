import { rmdir } from 'node:fs/promises';
import path from 'node:path';

import {
  startAdapter,
  type AdapterClient,
  type AdapterFault,
  type StartFailure as AdapterStartFailure,
} from '../adapter/client.js';
import { AdapterLog, StderrTail } from '../adapter/logs.js';
import { PROTOCOL_VERSION, type LogParams } from '../adapter/protocol.js';
import { expandGlob, type Project } from '../config/load.js';
import type { Sha256 } from '../config/identifiers.js';
import type { Price, Rule, Variant } from '../config/schema.js';
import { NO_LANGUAGE } from '../grade/grade.js';
import { createRedactor } from '../report/redact.js';
import { ActiveRun, type RunEnd } from './active-run.js';
import { createCapLedger, exceedsCap, type CapLedger } from './cap.js';
import { createCallsRouter, type CallsRouter } from './calls-router.js';
import {
  attemptReservation,
  conservativeEstimate,
  estimateLowAccuracyWarning,
  expectedEstimate,
  initialReservationState,
  maxBilledCalls,
  plannedUsage,
  priceFor,
  refusesUnpricedVariant,
  reservationTokens,
  type CasePlan,
  type EstimateBasis,
  type ExpectedEstimate,
  type PlannedUsage,
  type ProfileMap,
} from './cost.js';
import { driveRuns } from './drive.js';
import { launchHash, rulesHash, variantFingerprint } from './hashes.js';
import { previousProfiles } from './history.js';
import { newRunId, type SuffixSource } from './ids.js';
import { acquireRunLock, type HeldLock, type LockRefusal } from './lock.js';
import type { Manifest } from './manifest.js';
import { sendOrder } from './order.js';
import { renderCases, type RenderedCases, type RenderFailure } from './render-cases.js';
import type { RandomSource } from './retry.js';
import { runCases, targetLanguages, type CaseProblem, type RunCaseSpec } from './run-cases.js';
import { createStopSignal, type StopSignal } from './stopping.js';
import { runTotals } from './totals.js';
import { TrialBook } from './trial-book.js';
import type { Warning } from './warning.js';
import { createRunDirectory, openTrialLog, RUN_FILES, writeManifest } from './writer.js';

// One run of one variant: the start (T067), the send loop (T068) and the end (T069).

export interface ToolVersion {
  readonly name: string;
  readonly version: string;
}

export interface RunRequest {
  readonly project: Project;
  readonly variant: Variant;
  /** `--repeats`, else `sampling.repeats`. */
  readonly repeats: number;
  /** The `--cases` glob over case IDs; `null` runs every case. */
  readonly caseFilter: string | null;
  /** `--concurrency`, else `run.concurrency`. */
  readonly concurrency: number;
  /** `--max-cost-usd`, else `budget.maxCostUsd`; `null` means no cap. */
  readonly maxCostUsd: number | null;
  readonly tool: ToolVersion;
  /** Set on the two runs of a swap check. */
  readonly swapId?: string;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  /** The 4 hex digits that end the run ID; random unless a test sets them. */
  readonly runIdSuffix?: SuffixSource;
  readonly onLog?: (params: LogParams) => void;
  readonly onStderr?: (line: string) => void;
  /** Restarts and stops of the adapter while the run sends. */
  readonly onAdapterFault?: (variantId: string, fault: AdapterFault) => void;
}

/** Why a run did not start. Each ends as a configuration error (exit code 4) before any call. */
export type RunStartFailure =
  | { readonly kind: 'unpriced-variant'; readonly model: string }
  | {
      readonly kind: 'adapter';
      readonly error: AdapterStartFailure;
      /** The last lines of adapter stderr, as written. */
      readonly stderrTail: readonly string[];
    }
  | { readonly kind: 'cases'; readonly problems: readonly CaseProblem[] }
  | { readonly kind: 'no-cases'; readonly caseFilter: string | null }
  | { readonly kind: 'render'; readonly failures: readonly RenderFailure[] }
  | { readonly kind: 'lock'; readonly refusal: LockRefusal };

/** The pre-start estimates of data-model §Cost, Three Estimates. */
export interface StartEstimate {
  readonly expected: ExpectedEstimate;
  readonly conservativeUsd: number | null;
}

/** One variant's entry of the `--dry-run` plan (contracts/cli.md §`--json` Output). */
export interface VariantPlan extends PlannedUsage {
  readonly variant: string;
  readonly trials: number;
  readonly basis: Readonly<Record<string, EstimateBasis>>;
  /** The largest attempt reservation at the start; `null` without any configured price. */
  readonly reservationUsd: number | null;
}

/** A started and rendered adapter whose run has written nothing yet. */
export interface PreparedRun {
  readonly variantId: string;
  readonly estimate: StartEstimate;
  /** Trials this run will send. */
  readonly trials: number;
  /** The cases this run will send, in file order. */
  readonly cases: readonly RunCaseSpec[];
  readonly plan: VariantPlan;
  /**
   * Creates the run directory under a run ID no other run has and takes `run.lock`; nothing else
   * is written yet. A failure shuts the adapter down.
   */
  claim(): Promise<ClaimResult>;
  /** Shuts the adapter down without writing anything, after a refused start. */
  abandon(): Promise<void>;
}

/** A run whose directory and lock are held and whose manifest is not written yet. */
export interface ClaimedRun {
  readonly runId: string;
  /**
   * Writes the first manifest and opens `trials.jsonl`. `ledger` and `stop` are shared by every
   * run under one cap. A failure releases the lock and shuts the adapter down.
   */
  begin(shared: SharedRun): Promise<ActiveRun>;
  /** Releases the lock, removes the still empty run directory and shuts the adapter down. */
  abandon(): Promise<void>;
}

export interface SharedRun {
  readonly ledger: CapLedger;
  readonly stop: StopSignal;
}

export type PrepareResult =
  | { readonly ok: true; readonly run: PreparedRun }
  | { readonly ok: false; readonly failure: RunStartFailure };

export type ClaimResult =
  | { readonly ok: true; readonly run: ClaimedRun }
  | { readonly ok: false; readonly failure: RunStartFailure };

/** The config file, the files the rule and case globs match, and the output directory. */
export function toolPaths(project: Project): string[] {
  return [
    ...new Set([
      project.paths.configFile,
      ...project.ruleFiles.map((file) => file.path),
      ...project.caseFiles.map((file) => file.path),
      project.paths.outputDir,
    ]),
  ];
}

/** {@link toolPaths} with the rule and case globs matched again, for a restarted adapter. */
async function matchedToolPaths(project: Project): Promise<string[]> {
  const { files } = project.config.data;
  const { configFile, configDir, outputDir } = project.paths;
  const [rules, cases] = await Promise.all([
    expandGlob(files.rules, configDir),
    expandGlob(files.cases, configDir),
  ]);
  return [...new Set([configFile, ...rules, ...cases, outputDir])];
}

function variantPrice(pricing: Readonly<Record<string, Price>>, model: string): Price | undefined {
  const choice = priceFor(pricing, model);
  return choice.kind === 'none' ? undefined : choice.price;
}

/** The largest attempt reservation over the cases, before anything was measured. */
function startReservationUsd(
  pricing: Readonly<Record<string, Price>>,
  variant: Variant,
  plans: readonly CasePlan[],
  outputTokens: number,
  previous: ProfileMap,
): number | null {
  const state = initialReservationState(previous);
  const reservations = plans.map(
    (plan) =>
      attemptReservation({
        pricing,
        variantModel: variant.model,
        tokens: reservationTokens(state, plan, outputTokens),
        billedCalls: maxBilledCalls(state, plan.lang),
      }).costUsd,
  );
  return reservations.some((usd) => usd === null)
    ? null
    : Math.max(0, ...reservations.filter((usd) => usd !== null));
}

interface Started {
  readonly request: RunRequest;
  readonly startedAt: Date;
  readonly client: AdapterClient;
  readonly router: CallsRouter;
  readonly toolPaths: readonly string[];
  readonly cases: readonly RunCaseSpec[];
  readonly rules: readonly Rule[];
  readonly rulesHash: Sha256;
  readonly rendered: RenderedCases;
  readonly previous: ProfileMap;
  readonly estimate: StartEstimate;
  readonly adapterLog: AdapterLog;
  readonly stderr: StderrTail;
}

/**
 * Starts the adapter and `initialize`s it, then renders every case before the first model call:
 * a failed render ends as a configuration error naming the cases. Nothing is written yet, so a
 * run refused by the pre-start cost check leaves no directory.
 */
export async function prepareRun(request: RunRequest): Promise<PrepareResult> {
  const { project, variant } = request;
  const config = project.config.data;
  if (refusesUnpricedVariant(config.pricing, variant.model, request.maxCostUsd)) {
    return { ok: false, failure: { kind: 'unpriced-variant', model: variant.model } };
  }
  const now = request.now ?? (() => new Date());
  const startedAt = now();
  const paths = toolPaths(project);
  const router = createCallsRouter();
  const adapterLog = new AdapterLog(createRedactor(config.redact), now);
  const stderr = new StderrTail();
  const started = await startAdapter({
    launch: {
      command: config.adapter.command,
      cwd: project.paths.adapterCwd,
      env: config.adapter.env,
    },
    initialize: {
      client: { name: request.tool.name, version: request.tool.version },
      variant: {
        id: variant.id,
        model: variant.model,
        ...(variant.params === undefined ? {} : { params: variant.params }),
      },
      timeoutMs: config.adapter.timeoutMs,
      toolPaths: paths,
    },
    concurrency: request.concurrency,
    onCalls: (params) => {
      router.receive(params);
    },
    onLog: (params) => {
      adapterLog.record(params);
      request.onLog?.(params);
    },
    onStderr: (line) => {
      stderr.push(line);
      request.onStderr?.(line);
    },
  });
  if (!started.ok) {
    return {
      ok: false,
      failure: { kind: 'adapter', error: started.error, stderrTail: stderr.lines() },
    };
  }
  const { client } = started;
  try {
    return await renderedRun(request, startedAt, paths, { client, router, adapterLog, stderr });
  } catch (error) {
    await client.shutdown();
    throw error;
  }
}

/** The running adapter and what listens to it. */
interface Listened {
  readonly client: AdapterClient;
  readonly router: CallsRouter;
  readonly adapterLog: AdapterLog;
  readonly stderr: StderrTail;
}

/** The steps of {@link prepareRun} after the adapter started; refusals shut it down. */
async function renderedRun(
  request: RunRequest,
  startedAt: Date,
  paths: readonly string[],
  adapter: Listened,
): Promise<PrepareResult> {
  const { client } = adapter;
  const { project, variant } = request;
  const config = project.config.data;
  const refuse = async (failure: RunStartFailure): Promise<PrepareResult> => {
    await client.shutdown();
    return { ok: false, failure };
  };
  const selected = runCases(project, client.info.targets, request.caseFilter);
  if (!selected.ok) {
    return refuse({ kind: 'cases', problems: selected.problems });
  }
  if (selected.cases.length === 0) {
    return refuse({ kind: 'no-cases', caseFilter: request.caseFilter });
  }
  const rendered = await renderCases(
    client,
    selected.cases,
    config.sampling.seed,
    config.estimate.inputTokens,
  );
  if (!rendered.ok) {
    return refuse({ kind: 'render', failures: rendered.failures });
  }
  const previous = await previousProfiles(project.paths.outputDir, variantFingerprint(variant));
  const estimateInput = {
    cases: [...rendered.rendered.plans.values()],
    repeats: request.repeats,
    outputTokens: config.estimate.outputTokens,
    price: variantPrice(config.pricing, variant.model),
    previous,
  };
  const rules = project.ruleFiles.flatMap((file) => file.data.rules);
  const expected = expectedEstimate(estimateInput);
  const prepared: Started = {
    request,
    startedAt,
    ...adapter,
    toolPaths: paths,
    cases: selected.cases,
    rules,
    rulesHash: rulesHash(
      rules,
      selected.cases.map((spec) => spec.definition),
    ),
    rendered: rendered.rendered,
    previous,
    estimate: { expected, conservativeUsd: conservativeEstimate(estimateInput) },
  };
  const trials = selected.cases.length * request.repeats;
  return {
    ok: true,
    run: {
      variantId: variant.id,
      estimate: prepared.estimate,
      trials,
      cases: selected.cases,
      plan: {
        variant: variant.id,
        trials,
        ...plannedUsage(estimateInput),
        basis: expected.basis,
        reservationUsd: startReservationUsd(
          config.pricing,
          variant,
          estimateInput.cases,
          config.estimate.outputTokens,
          previous,
        ),
      },
      claim: () => claimRun(prepared),
      abandon: async () => {
        await client.shutdown();
      },
    },
  };
}

function startWarnings(started: Started): Warning[] {
  const { inputTokens } = started.request.project.config.data.estimate;
  return started.rendered.lowAccuracy && inputTokens !== undefined
    ? [estimateLowAccuracyWarning(started.request.variant.id, inputTokens)]
    : [];
}

function firstManifest(started: Started, runId: string, shared: SharedRun): Manifest {
  const { request, client, rendered } = started;
  const { project, variant } = request;
  const config = project.config.data;
  const { info } = client;
  const startedAt = started.startedAt.toISOString();
  const helper = info.adapter.helper === undefined ? {} : { helper: info.adapter.helper };
  return {
    runId,
    ...(request.swapId === undefined ? {} : { swapId: request.swapId }),
    tool: { ...request.tool, protocolVersion: PROTOCOL_VERSION, startedAt },
    adapter: {
      name: info.adapter.name,
      version: info.adapter.version,
      protocolVersion: info.protocolVersion,
      launchHash: launchHash({
        command: config.adapter.command,
        env: config.adapter.env,
        cwd: project.paths.adapterCwd,
      }),
      ...helper,
      capabilities: info.capabilities,
    },
    service: info.service ?? {},
    variant: {
      id: variant.id,
      model: variant.model,
      ...(variant.params === undefined ? {} : { params: variant.params }),
      fingerprint: variantFingerprint(variant),
    },
    cases: started.cases.map(({ id, target, lang, hash }) => ({ id, target, lang, hash })),
    rulesHash: started.rulesHash,
    ...(info.capabilities.render ? { prompts: rendered.prompts } : {}),
    sampling: { repeats: request.repeats, seed: config.sampling.seed, cases: request.caseFilter },
    limits: { retries: config.run.retries, timeoutMs: config.adapter.timeoutMs },
    pricing: config.pricing,
    budget: {
      maxCostUsd: shared.ledger.maxCostUsd,
      scope: request.swapId === undefined ? 'run' : 'swap',
    },
    estimate: {
      expected: started.estimate.expected.usd,
      conservative: started.estimate.conservativeUsd,
      basis: started.estimate.expected.basis,
      projected: [],
    },
    totals: runTotals([], 0),
    segments: [
      {
        segment: 1,
        startedAt,
        tool: { version: request.tool.version },
        adapter: { version: info.adapter.version, ...helper },
        pricing: config.pricing,
        maxCostUsd: shared.ledger.maxCostUsd,
        concurrency: request.concurrency,
        toolPaths: [...started.toolPaths],
        spentUsd: 0,
        resumeWarnings: [],
      },
    ],
    warnings: startWarnings(started),
    status: 'running',
  };
}

async function claimRun(started: Started): Promise<ClaimResult> {
  const { request, client } = started;
  const { variant } = request;
  try {
    const { runId, runDir } = await createRunDirectory(request.project.paths.outputDir, () =>
      newRunId(variant.id, started.startedAt, request.runIdSuffix),
    );
    const locked = await acquireRunLock(runDir, { now: started.startedAt });
    if (!locked.ok) {
      // Another process took the new folder first; its lock stays, and the refusal is reported.
      await rmdir(runDir).catch(() => undefined);
      await client.shutdown();
      return { ok: false, failure: { kind: 'lock', refusal: locked.refusal } };
    }
    const { lock } = locked;
    return {
      ok: true,
      run: {
        runId,
        begin: async (shared) => {
          try {
            return await beginRun(started, { runId, runDir, lock }, shared);
          } catch (error) {
            try {
              await lock.release();
            } finally {
              await client.shutdown();
            }
            throw error;
          }
        },
        abandon: async () => {
          try {
            await lock.release();
            await rmdir(runDir);
          } finally {
            await client.shutdown();
          }
        },
      },
    };
  } catch (error) {
    await client.shutdown();
    throw error;
  }
}

interface RunDirectory {
  readonly runId: string;
  readonly runDir: string;
  readonly lock: HeldLock;
}

async function beginRun(
  started: Started,
  { runId, runDir, lock }: RunDirectory,
  shared: SharedRun,
): Promise<ActiveRun> {
  const { request, client } = started;
  const config = request.project.config.data;
  const manifest = firstManifest(started, runId, shared);
  await writeManifest(runDir, manifest);
  const log = await openTrialLog(path.join(runDir, RUN_FILES.trials));
  await started.adapterLog.open(path.join(runDir, RUN_FILES.adapterLog));
  const langOf = new Map(started.cases.map((spec) => [spec.id, spec.lang]));
  const plan = sendOrder(started.cases, targetLanguages(client.info.targets), request.repeats);
  return new ActiveRun({
    runId,
    runDir,
    config,
    rules: started.rules,
    cases: started.cases,
    plans: started.rendered.plans,
    expectedPerTrial: started.estimate.expected.perTrial,
    previous: started.previous,
    client,
    router: started.router,
    book: new TrialBook(
      plan,
      (caseId) => langOf.get(caseId) ?? NO_LANGUAGE,
      config.run.retries,
      request.random ?? Math.random,
    ),
    log,
    lock,
    ledger: shared.ledger,
    stop: shared.stop,
    manifest,
    rulesHash: started.rulesHash,
    checkerVersion: request.tool.version,
    now: request.now ?? (() => new Date()),
    adapterLog: started.adapterLog,
    stderr: started.stderr,
    matchedToolPaths: () => matchedToolPaths(request.project),
    onAdapterFault: (fault) => {
      request.onAdapterFault?.(request.variant.id, fault);
    },
  });
}

/** The expected estimate exceeds the cap: no model is called (exit code 5). */
export interface OverBudget {
  readonly kind: 'over-budget';
  readonly expectedUsd: number | null;
  readonly maxCostUsd: number;
}

export type RunResult =
  | {
      readonly ok: true;
      readonly end: RunEnd;
      /** Pre-start warnings for the `--json` envelope: `conservative-over-budget`. */
      readonly startWarnings: readonly Warning[];
    }
  | { readonly ok: false; readonly failure: RunStartFailure | OverBudget };

/** The `conservative-over-budget` warning before the start, or none. */
export function conservativeWarning(
  conservativeUsd: number | null,
  maxCostUsd: number | null,
): Warning[] {
  return conservativeUsd !== null && maxCostUsd !== null && conservativeUsd > maxCostUsd
    ? [{ code: 'conservative-over-budget', params: { conservativeUsd, maxCostUsd } }]
    : [];
}

/**
 * `model-eval run`: start, refuse above the cap before any model call, send every trial, end and
 * grade. The cap covers this run alone.
 */
export async function executeRun(request: RunRequest): Promise<RunResult> {
  const prepared = await prepareRun(request);
  return prepared.ok ? startRun(prepared.run, request.maxCostUsd) : prepared;
}

/** The steps of {@link executeRun} after `prepareRun`, for callers that look at the plan first. */
export async function startRun(run: PreparedRun, maxCostUsd: number | null): Promise<RunResult> {
  if (maxCostUsd !== null && exceedsCap(run.estimate.expected.usd, maxCostUsd)) {
    await run.abandon();
    return {
      ok: false,
      failure: { kind: 'over-budget', expectedUsd: run.estimate.expected.usd, maxCostUsd },
    };
  }
  const claimed = await run.claim();
  if (!claimed.ok) {
    return claimed;
  }
  const shared: SharedRun = { ledger: createCapLedger(maxCostUsd, 0), stop: createStopSignal() };
  const active = await claimed.run.begin(shared);
  try {
    await driveRuns([active], shared);
  } finally {
    await active.shutdown();
  }
  return {
    ok: true,
    end: await active.finish(),
    startWarnings: conservativeWarning(run.estimate.conservativeUsd, maxCostUsd),
  };
}
