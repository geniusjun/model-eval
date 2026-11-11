import type {
  AdapterClient,
  AdapterFault,
  LateResponse,
  ShutdownOutcome,
} from '../adapter/client.js';
import type { AdapterLog, LogGroup, StderrTail } from '../adapter/logs.js';
import type { CallRecord, CallsParams, Usage } from '../adapter/protocol.js';
import type { Sha256 } from '../config/identifiers.js';
import type { Config, Rule } from '../config/schema.js';
import type { RunCase } from '../grade/grade.js';
import { ensureGradeSet, type GradeSet } from '../grade/grade-set.js';
import { classifyTrial, hasConfigCall } from '../grade/outcome.js';
import { finishedTrials } from '../compare/finished.js';
import { createRedactor } from '../report/redact.js';
import { trialWarnings } from '../compare/warnings.js';
import { budgetOverrunWarning, overrunUsd, type CapLedger, type VariantProjection } from './cap.js';
import type { CallsRouter, RequestTrial } from './calls-router.js';
import {
  attemptCharge,
  attemptReservation,
  costProfiles,
  indexTrialLines,
  initialReservationState,
  lateCostLineUsd,
  observeAttempt,
  pricingWarnings,
  reservationTokens,
  type CasePlan,
  type Charge,
  type ChargeContext,
  type KeyedCostLine,
  type PerTrialUsd,
  type ProfileMap,
  type ReservationState,
} from './cost.js';
import { trialKeyId, trialSeed, type TrialKey } from './ids.js';
import type { HeldLock } from './lock.js';
import type { Manifest, RunStatus, StopReason } from './manifest.js';
import type { VariantProgress } from './order.js';
import type { AttemptLine, CostLine, SendLine, TrialLine } from './records.js';
import { mergeListWarnings } from './merge-warnings.js';
import { segmentSpentUsd } from './resume.js';
import { joinedToolPaths } from './resume-check.js';
import { lateCosts, recordAttempt, stoppedAttempt, type RecordedAttempt } from './attempt.js';
import type { RunCaseSpec } from './run-cases.js';
import { exceedsAdapterErrorRate, exceedsTransientRate, type StopSignal } from './stopping.js';
import { addUsages, runTotals } from './totals.js';
import type { TrialBook } from './trial-book.js';
import type { Warning } from './warning.js';
import { LiveWarningCodes } from './live-warnings.js';
import { hasNewWarningCode, writeManifest, type TrialLog } from './writer.js';

// One run of one variant while it sends (data-model §Send Order, §Trial, §Stopping, §Cost).

/** A re-estimate point of data-model §Cap Check. */
export type ProjectionTrigger =
  | { readonly trigger: 'first-batch' }
  | { readonly trigger: 'repeat-round'; readonly repeat: number }
  | { readonly trigger: 'resume' };

/** A fault that stops the run: the loss limit, or a new process that failed or changed. */
export type StoppingFault = Extract<
  AdapterFault,
  { readonly kind: 'crashed' | 'restart-failed' | 'restart-changed' }
>;

/** Why this run's adapter stopped the run, for the failure report. */
export interface AdapterFailure {
  /** Absent when the adapter error rate stopped the run. */
  readonly fault?: StoppingFault;
  /** The last lines of adapter stderr, as written. */
  readonly stderrTail: readonly string[];
}

export interface RunEnd {
  readonly runId: string;
  readonly runDir: string;
  readonly status: RunStatus;
  readonly stopReason?: StopReason;
  readonly manifest: Manifest;
  readonly gradeSetId: string;
  /** Every line written to `trials.jsonl`, in file order. */
  readonly lines: readonly TrialLine[];
  readonly gradeSet: GradeSet;
  /** `warn` and `error` logs of the adapter, grouped by redacted message. */
  readonly adapterLogs: readonly LogGroup[];
  /** Present when this run's adapter raised the stop. */
  readonly adapterFailure?: AdapterFailure;
}

export interface ActiveRunSetup {
  readonly runId: string;
  /**
   * Lines of earlier segments, closing lines included, for a resumed run; empty for a new one.
   * The last of `manifest.segments` is the segment this run writes.
   */
  readonly earlier: readonly TrialLine[];
  /**
   * Warnings this segment's lines do not raise: `estimate-low-accuracy`, and for a resumed run
   * the resume warnings of every segment and the pricing warnings of earlier segments, which
   * depend on the prices and cap each segment had.
   */
  readonly startWarnings: readonly Warning[];
  readonly runDir: string;
  readonly config: Config;
  readonly rules: readonly Rule[];
  readonly cases: readonly RunCaseSpec[];
  readonly plans: ReadonlyMap<string, CasePlan>;
  readonly expectedPerTrial: Readonly<Record<string, PerTrialUsd>>;
  readonly previous: ProfileMap;
  readonly client: AdapterClient;
  readonly router: CallsRouter;
  readonly book: TrialBook;
  readonly log: TrialLog;
  readonly lock: HeldLock;
  readonly ledger: CapLedger;
  readonly stop: StopSignal;
  readonly manifest: Manifest;
  readonly rulesHash: Sha256;
  readonly checkerVersion: string;
  readonly now: () => Date;
  /** Receives the adapter's `log` notifications; opened in the run directory. */
  readonly adapterLog: AdapterLog;
  readonly stderr: StderrTail;
  /** The paths the config's globs match when called, for the `toolPaths` of a restarted adapter. */
  readonly matchedToolPaths: () => Promise<readonly string[]>;
  readonly onAdapterFault?: (fault: AdapterFault) => void;
}

interface AttemptRecord {
  readonly line: AttemptLine;
  readonly costLines: KeyedCostLine[];
}

/** An attempt in flight, which a second interrupt records as `stopped`. */
interface Flying {
  cut(): void;
}

/** The duration of the segments that ended; a killed segment has no end and adds nothing. */
function earlierDurationMs(segments: Manifest['segments']): number {
  return segments.reduce(
    (total, segment) =>
      segment.endedAt === undefined
        ? total
        : total + Date.parse(segment.endedAt) - Date.parse(segment.startedAt),
    0,
  );
}

/** A cost line's usage is the sum of its calls' usage; none when no call reported any. */
function callsUsage(calls: readonly CallRecord[]): Usage | undefined {
  const usages = calls.flatMap((call) => (call.usage === undefined ? [] : [call.usage]));
  return usages.length === 0 ? undefined : addUsages(usages);
}

export class ActiveRun {
  readonly runId: string;
  readonly variantId: string;
  private readonly lines: TrialLine[] = [];
  private readonly attempts = new Map<string, AttemptRecord>();
  /** The charge context of each attempt at its send, keyed like {@link attempts}. */
  private readonly sendContexts = new Map<string, ChargeContext>();
  private readonly liveCodes: LiveWarningCodes;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly flying = new Set<Flying>();
  private readonly specs: ReadonlyMap<string, RunCaseSpec>;
  private reservation: ReservationState;
  private readonly unpricedModels = new Set<string>();
  private readonly cachedInputUnpricedModels = new Set<string>();
  private manifest: Manifest;
  private writtenWarnings: readonly Warning[];
  private manifestWrites: Promise<void> = Promise.resolve();
  /**
   * The first failed write or late response that could not be recorded; `finish` reports it,
   * since later lines may be missing.
   */
  private writeError: Error | undefined;
  private firstBatchReported: boolean;
  private roundsReported = 0;
  /** The segment this run writes; 1 for a new run. */
  private readonly segment: number;
  private readonly startedAt: Date;
  /** Duration of the earlier segments that ended. */
  private readonly earlierMs: number;
  /** Set when this run's adapter raised the stop. */
  private adapterStop: { readonly fault?: StoppingFault } | undefined;

  constructor(private readonly setup: ActiveRunSetup) {
    this.runId = setup.runId;
    this.variantId = setup.manifest.variant.id;
    this.specs = new Map(setup.cases.map((spec) => [spec.id, spec]));
    this.liveCodes = new LiveWarningCodes({
      retries: setup.manifest.limits.retries,
      caseIds: new Set(this.specs.keys()),
      prompts: setup.manifest.prompts ?? {},
      transientRate: setup.config.report.warn.transientRate,
    });
    this.manifest = setup.manifest;
    this.writtenWarnings = setup.manifest.warnings;
    const { segments } = setup.manifest;
    const current = segments.at(-1);
    if (current === undefined) {
      throw new RangeError('a manifest has at least one segment');
    }
    this.segment = current.segment;
    this.startedAt = new Date(current.startedAt);
    this.earlierMs = earlierDurationMs(segments.slice(0, -1));
    this.reservation = this.seedEarlier(setup);
    // Re-estimate points an earlier segment passed are not reached again.
    this.firstBatchReported = setup.book.firstBatchFinished();
    while (
      this.roundsReported < this.manifest.sampling.repeats &&
      setup.book.roundFinished(this.roundsReported)
    ) {
      this.roundsReported += 1;
    }
    setup.router.attach({
      keyed: (trial, params) => {
        this.costLine(trial, params.calls);
      },
      unkeyed: (params) => {
        this.unkeyedCostLine(params);
      },
    });
    setup.client.supervise({
      toolPaths: () => this.restartToolPaths(),
      onFault: (fault) => {
        this.onAdapterFault(fault);
      },
    });
  }

  /**
   * Writes the manifest of a resumed segment's start, its warnings recounted from every line, so a
   * run killed again still has them.
   */
  writeSegmentStart(): Promise<void> {
    this.manifest = { ...this.manifest, warnings: this.warnings() };
    return this.writeManifest();
  }

  get concurrency(): number {
    return this.setup.client.concurrency;
  }

  get hasRemaining(): boolean {
    return this.setup.book.hasRemaining;
  }

  /** What the interleaving of data-model §Send Order reads. */
  progress(now: number): VariantProgress {
    const { book } = this.setup;
    return {
      finished: book.finished,
      started: book.started,
      hasSendable: this.canSend() && book.next(now) !== undefined,
      hasRemaining: book.hasRemaining,
    };
  }

  /** Attempts in flight; each settles once its attempt line is written. */
  pending(): readonly Promise<void>[] {
    return [...this.inFlight];
  }

  nextRetryAt(): number | undefined {
    return this.setup.book.nextRetryAt();
  }

  /**
   * Sends the next trial in order through the cap check: the send line is written before the
   * attempt goes to the adapter. A failed cap check stops every run with `budget`. Resolves to
   * whether an attempt went out.
   */
  async sendNext(now: number): Promise<boolean> {
    const { book, ledger, stop, client } = this.setup;
    const key = this.canSend() ? book.next(now) : undefined;
    if (key === undefined) {
      return false;
    }
    const spec = this.spec(key.caseId);
    const context = this.chargeContext(spec);
    const reserved = attemptReservation(context);
    const reservation = ledger.trySend(reserved.costUsd);
    if (reservation === undefined) {
      stop.raise('budget');
      return false;
    }
    const attempt = book.nextAttempt(key);
    book.markSent(key);
    // Without usage, the attempt and its unanswered calls are charged the reservation made here.
    this.sendContexts.set(this.attemptId(key, attempt), context);
    const send: SendLine = {
      caseId: key.caseId,
      repeat: key.repeat,
      attempt,
      segment: this.segment,
      reservedUsd: reservation.reservedUsd,
      sending: true,
    };
    const seed = trialSeed(this.manifest.sampling.seed, key.caseId, key.repeat);
    const base = { caseId: key.caseId, repeat: key.repeat, attempt, segment: this.segment, seed };
    let requestId: number | undefined;
    /** Whether the attempt line was written, and whether the request went to the adapter. */
    const progress = { recorded: false, reachedAdapter: false };
    let release: () => void = () => undefined;
    let fail: (reason: unknown) => void = () => undefined;
    const settled = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    // The attempt line is written once: from the adapter's answer, or as `stopped` on a cut.
    const record = (attemptRecord: RecordedAttempt): void => {
      if (progress.recorded) {
        return;
      }
      progress.recorded = true;
      reservation.settle(attemptRecord.charge.costUsd);
      this.attemptLine(attemptRecord.line, attemptRecord.charge, spec);
      if (requestId !== undefined) {
        this.setup.router.written(requestId);
      }
      release();
    };
    const flying: Flying = {
      // Cut while its send line was being written, the attempt never reached the adapter and
      // costs nothing; once sent, it is charged its reservation.
      cut: () => {
        record(
          progress.reachedAdapter
            ? stoppedAttempt(base, context)
            : recordAttempt(base, { kind: 'refused', message: 'cut before it was sent' }, context),
        );
      },
    };
    const tracked = settled.finally(() => {
      this.inFlight.delete(tracked);
      this.flying.delete(flying);
    });
    this.inFlight.add(tracked);
    this.flying.add(flying);
    await this.append(send);
    if (progress.recorded) {
      return true;
    }
    progress.reachedAdapter = true;
    void client
      .generate(
        {
          target: spec.target,
          ...(spec.requestLang === undefined ? {} : { lang: spec.requestLang }),
          input: spec.definition.input,
          caseId: key.caseId,
          repeat: key.repeat,
          seed,
        },
        {
          onRequest: (id) => {
            requestId = id;
            this.setup.router.bind(id, { key, attempt });
          },
          // The attempt line is written as soon as the time limit passes, so it precedes this.
          onLate: (response) => {
            try {
              this.lateLine({ key, attempt }, response);
            } catch (error) {
              this.writeError ??= error instanceof Error ? error : new Error(String(error));
            }
          },
        },
      )
      .then((outcome) => {
        record(recordAttempt(base, outcome, context));
      })
      .catch(fail);
    return true;
  }

  /**
   * The second interrupt: every attempt in flight becomes `stopped`, charged its reservation, and
   * the adapter is told to give its requests up; their answers are not awaited.
   */
  cut(): void {
    for (const flying of [...this.flying]) {
      flying.cut();
    }
    this.setup.client.cancel();
  }

  /** Re-estimate points reached since the last call. */
  takeTriggers(): ProjectionTrigger[] {
    const { book } = this.setup;
    const triggers: ProjectionTrigger[] = [];
    if (!this.firstBatchReported && book.firstBatchFinished()) {
      this.firstBatchReported = true;
      triggers.push({ trigger: 'first-batch' });
    }
    while (
      this.roundsReported < this.manifest.sampling.repeats &&
      book.roundFinished(this.roundsReported)
    ) {
      triggers.push({ trigger: 'repeat-round', repeat: this.roundsReported });
      this.roundsReported += 1;
    }
    return triggers;
  }

  /** This run's part of a re-estimate. */
  projection(): VariantProjection {
    const profiles = costProfiles(this.lines, (caseId) => this.spec(caseId).lang, this.retries);
    return {
      firstBatchFinished: this.setup.book.firstBatchFinished(),
      measured: profiles,
      expected: this.setup.expectedPerTrial,
      remaining: this.setup.book.remaining(),
    };
  }

  recordProjection(trigger: ProjectionTrigger, totalUsd: number | null): Promise<void> {
    const { estimate } = this.manifest;
    this.manifest = {
      ...this.manifest,
      estimate: { ...estimate, projected: [...estimate.projected, { ...trigger, totalUsd }] },
    };
    return this.writeManifest();
  }

  /** Sends `shutdown`; `calls` notifications the adapter sends before answering are recorded. */
  shutdown(): Promise<ShutdownOutcome> {
    return this.setup.client.shutdown();
  }

  /**
   * After the in-flight attempts and the shutdown: the final status and `totals`, the run graded
   * into a grade set, and the lock released.
   */
  async finish(): Promise<RunEnd> {
    const { setup } = this;
    try {
      await setup.log.close();
      await setup.adapterLog.close();
      if (this.writeError !== undefined) {
        throw this.writeError;
      }
      const stopReason = setup.stop.reason;
      const status: RunStatus = stopReason === undefined ? 'complete' : 'partial';
      const endedAt = setup.now();
      const totals = runTotals(
        this.lines,
        this.earlierMs + endedAt.getTime() - this.startedAt.getTime(),
      );
      this.manifest = {
        ...this.manifest,
        status,
        ...(stopReason === undefined ? {} : { stopReason }),
        totals,
        costProfile: costProfiles(this.lines, (caseId) => this.spec(caseId).lang, this.retries),
        warnings: this.warnings(),
        segments: this.manifest.segments.map((segment) =>
          segment.segment === this.segment
            ? {
                ...segment,
                endedAt: endedAt.toISOString(),
                spentUsd: segmentSpentUsd(this.lines, this.segment),
              }
            : segment,
        ),
      };
      await this.writeManifest();
      const { gradeSet } = await ensureGradeSet({
        runDir: setup.runDir,
        runId: setup.runId,
        rulesHash: setup.rulesHash,
        checkerVersion: setup.checkerVersion,
        rules: setup.rules,
        cases: this.runCases(),
        lines: this.lines,
        redactor: createRedactor(setup.config.redact),
      });
      return {
        runId: setup.runId,
        runDir: setup.runDir,
        status,
        ...(stopReason === undefined ? {} : { stopReason }),
        manifest: this.manifest,
        gradeSetId: gradeSet.header.gradeSetId,
        lines: [...this.lines],
        gradeSet,
        adapterLogs: setup.adapterLog.groups(),
        ...this.adapterFailure(stopReason),
      };
    } finally {
      await setup.lock.release();
    }
  }

  /** Earlier segments' lines, and what the reservation saw in them. */
  private seedEarlier(setup: ActiveRunSetup): ReservationState {
    for (const line of setup.earlier) {
      this.lines.push(line);
      this.liveCodes.add(line);
    }
    let state = initialReservationState(setup.previous);
    for (const { key, attempts, costLines } of indexTrialLines(setup.earlier).keys.values()) {
      const lang = this.specs.get(key.caseId)?.lang;
      if (lang === undefined) {
        continue;
      }
      for (const attempt of attempts) {
        const own = costLines.filter((line) => line.attempt === attempt.attempt);
        state = observeAttempt(state, lang, attempt, own);
      }
    }
    return state;
  }

  private get retries(): number {
    return this.manifest.limits.retries;
  }

  private canSend(): boolean {
    return this.setup.stop.reason === undefined && this.setup.book.inFlight < this.concurrency;
  }

  private spec(caseId: string): RunCaseSpec {
    const spec = this.specs.get(caseId);
    if (spec === undefined) {
      throw new RangeError(`no case ${caseId} in this run`);
    }
    return spec;
  }

  private plan(caseId: string): CasePlan {
    const plan = this.setup.plans.get(caseId);
    if (plan === undefined) {
      throw new RangeError(`no render estimate for case ${caseId}`);
    }
    return plan;
  }

  private chargeContext(spec: RunCaseSpec): ChargeContext {
    const plan = this.plan(spec.id);
    return {
      pricing: this.manifest.pricing,
      variantModel: this.manifest.variant.model,
      tokens: reservationTokens(this.reservation, plan, this.setup.config.estimate.outputTokens),
      billedCalls: this.reservation.maxBilledCalls[spec.lang] ?? 1,
    };
  }

  /** Reservations of calls outside any trial use the largest case estimate. */
  private unkeyedContext(): ChargeContext {
    const largest = [...this.specs.values()].reduce<RunCaseSpec | undefined>(
      (best, spec) =>
        best === undefined || this.plan(spec.id).inputTokens > this.plan(best.id).inputTokens
          ? spec
          : best,
      undefined,
    );
    if (largest === undefined) {
      throw new RangeError('a run has at least one case');
    }
    return this.chargeContext(largest);
  }

  private append(line: TrialLine): Promise<void> {
    this.lines.push(line);
    this.liveCodes.add(line);
    return this.setup.log.append(line);
  }

  /** Appends without waiting; lines are written in call order. */
  private appendLater(line: TrialLine): void {
    this.append(line).catch((error: unknown) => {
      this.writeError ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  private attemptLine(line: AttemptLine, charge: Charge, spec: RunCaseSpec): void {
    this.appendLater(line);
    this.attempts.set(this.attemptId(line, line.attempt), { line, costLines: [] });
    this.reservation = observeAttempt(this.reservation, spec.lang, line, []);
    this.noteCharge(charge);
    this.setup.book.record(line, this.setup.now().getTime());
    if (classifyTrial(line) === 'config') {
      this.setup.stop.raise('config-error');
    }
    const finished = this.setup.book.finishedIn(this.segment);
    if (exceedsTransientRate(finished, this.setup.config.run.maxTransientRate)) {
      this.setup.stop.raise('transient-errors');
    }
    if (exceedsAdapterErrorRate(finished, this.setup.config.run.maxAdapterErrorRate)) {
      this.stopForAdapter('adapter-errors');
    }
    this.rewriteOnNewWarning();
  }

  /**
   * A late response to an abandoned attempt is never graded: it only corrects the attempt's
   * cost to the larger of its cost and the reservation, and stops the run like a `calls`
   * notification (adapter-protocol §Time Limits and Recovery).
   */
  private lateLine(trial: RequestTrial, response: LateResponse): void {
    // A `config` failure result stops the run even without calls (data-model §Stopping).
    if (
      response.kind === 'result' &&
      'error' in response.value &&
      response.value.error.kind === 'config'
    ) {
      this.setup.stop.raise('config-error');
    }
    const costs = lateCosts(response);
    if (costs === undefined) {
      return;
    }
    const id = this.attemptId(trial.key, trial.attempt);
    const record = this.attempts.get(id);
    const context = this.sendContexts.get(id);
    if (record === undefined || context === undefined) {
      throw new RangeError(`no abandoned attempt ${id} in this run`);
    }
    const charge = attemptCharge({ answered: true, ...costs }, context);
    const reservedUsd = record.line.costUsd;
    const usage = costs.calls === undefined ? costs.usage : callsUsage(costs.calls);
    const line: KeyedCostLine = {
      caseId: trial.key.caseId,
      repeat: trial.key.repeat,
      attempt: trial.attempt,
      segment: this.segment,
      source: 'late',
      costUsd: reservedUsd === null ? null : lateCostLineUsd(charge, reservedUsd),
      ...(charge.estimated ? { costEstimated: true } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(costs.calls === undefined ? {} : { calls: [...costs.calls] }),
      costCorrection: true,
    };
    this.appendLater(line);
    record.costLines.push(line);
    const { lang } = this.spec(trial.key.caseId);
    this.reservation = observeAttempt(this.reservation, lang, record.line, record.costLines);
    this.chargeLine(line, charge, costs.calls ?? []);
  }

  private onAdapterFault(fault: AdapterFault): void {
    this.setup.onAdapterFault?.(fault);
    switch (fault.kind) {
      case 'restarting':
        return;
      case 'restarted':
        this.recordToolPaths(fault.toolPaths);
        return;
      case 'crashed':
        this.stopForAdapter('adapter-errors', fault);
        return;
      case 'restart-failed':
      case 'restart-changed':
        // One run would mix trials of two code versions (adapter-protocol §Time Limits).
        this.stopForAdapter('config-error', fault);
    }
  }

  /**
   * The failure report of a run its adapter stopped: by adapter errors (the error rate or the
   * loss limit) or by a restart that failed to start, which is a start failure. Other stops,
   * a changed restarted adapter among them, get none (adapter-protocol §Transport 3).
   */
  private adapterFailure(stopReason: StopReason | undefined): {
    adapterFailure?: AdapterFailure;
  } {
    const stop = this.adapterStop;
    const attached =
      stop !== undefined &&
      (stopReason === 'adapter-errors' ||
        (stopReason === 'config-error' && stop.fault?.kind === 'restart-failed'));
    return attached ? { adapterFailure: { ...stop, stderrTail: this.setup.stderr.lines() } } : {};
  }

  private stopForAdapter(reason: StopReason, fault?: StoppingFault): void {
    this.setup.stop.raise(reason);
    if (fault !== undefined || this.adapterStop === undefined) {
      this.adapterStop = fault === undefined ? {} : { fault };
    }
  }

  /** The paths every earlier start of this run was sent, and those the globs match again. */
  private async restartToolPaths(): Promise<readonly string[]> {
    return joinedToolPaths(this.manifest.segments, await this.setup.matchedToolPaths());
  }

  private recordToolPaths(toolPaths: readonly string[]): void {
    this.manifest = {
      ...this.manifest,
      segments: this.manifest.segments.map((segment) =>
        segment.segment === this.segment ? { ...segment, toolPaths: [...toolPaths] } : segment,
      ),
    };
    this.writeManifest().catch((error: unknown) => {
      this.writeError ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  private costLine(trial: RequestTrial, calls: readonly CallRecord[]): void {
    const spec = this.spec(trial.key.caseId);
    const context = this.sendContexts.get(this.attemptId(trial.key, trial.attempt));
    if (context === undefined) {
      throw new RangeError(`no send of ${this.attemptId(trial.key, trial.attempt)} in this run`);
    }
    const charge = attemptCharge({ answered: true, calls }, context);
    const usage = callsUsage(calls);
    const line: KeyedCostLine = {
      caseId: trial.key.caseId,
      repeat: trial.key.repeat,
      attempt: trial.attempt,
      segment: this.segment,
      source: 'calls',
      costUsd: charge.costUsd,
      ...(charge.estimated ? { costEstimated: true } : {}),
      ...(usage === undefined ? {} : { usage }),
      calls: [...calls],
      costCorrection: true,
    };
    this.appendLater(line);
    const record = this.attempts.get(this.attemptId(trial.key, trial.attempt));
    if (record !== undefined) {
      record.costLines.push(line);
      this.reservation = observeAttempt(this.reservation, spec.lang, record.line, record.costLines);
    }
    this.chargeLine(line, charge, calls);
  }

  private unkeyedCostLine(params: CallsParams): void {
    const charge = attemptCharge({ answered: true, calls: params.calls }, this.unkeyedContext());
    const usage = callsUsage(params.calls);
    const line: CostLine = {
      segment: this.segment,
      source: 'calls',
      costUsd: charge.costUsd,
      ...(charge.estimated ? { costEstimated: true } : {}),
      ...(usage === undefined ? {} : { usage }),
      calls: [...params.calls],
      costCorrection: true,
    };
    this.appendLater(line);
    this.chargeLine(line, charge, params.calls);
  }

  /** Calls reported outside a result never change a trial; they only stop the run. */
  private chargeLine(line: CostLine, charge: Charge, calls: readonly CallRecord[]): void {
    this.setup.ledger.charge(line.costUsd);
    this.noteCharge(charge);
    if (hasConfigCall(calls)) {
      this.setup.stop.raise('config-error');
    }
    this.rewriteOnNewWarning();
  }

  /** With a cap, a call to an unpriced model stops the run as a configuration error. */
  private noteCharge(charge: Charge): void {
    for (const model of charge.unpricedModels) {
      this.unpricedModels.add(model);
    }
    for (const model of charge.cachedInputUnpricedModels) {
      this.cachedInputUnpricedModels.add(model);
    }
    if (charge.unpricedModels.length > 0 && this.setup.ledger.maxCostUsd !== null) {
      this.setup.stop.raise('config-error');
    }
  }

  private attemptId(key: TrialKey, attempt: number): string {
    return `${trialKeyId(key)}:${String(attempt)}`;
  }

  /**
   * Warnings this run raises from its own records (data-model §Warnings), after those of the
   * start (`estimate-low-accuracy`).
   */
  private warnings(): Warning[] {
    const overrun = budgetOverrunWarning(this.variantId, overrunUsd(this.lines));
    const finished = finishedTrials(this.lines, this.retries, new Set(this.specs.keys()));
    return mergeListWarnings([
      ...this.setup.startWarnings,
      ...trialWarnings(
        { manifest: this.manifest, lines: this.lines, finished },
        this.setup.config.report,
      ),
      ...(overrun === undefined ? [] : [overrun]),
      ...this.pricingWarnings(),
    ]);
  }

  private pricingWarnings(): Warning[] {
    return pricingWarnings({
      variantId: this.variantId,
      maxCostUsd: this.setup.ledger.maxCostUsd,
      unpricedModels: [...this.unpricedModels],
      cachedInputUnpricedModels: [...this.cachedInputUnpricedModels],
    });
  }

  /**
   * Rewrites the manifest when a code appears that the written warnings lack. The codes come
   * from {@link LiveWarningCodes}, so only a rewrite counts the warnings over every line.
   */
  private rewriteOnNewWarning(): void {
    const codes = [
      ...this.setup.startWarnings.map((warning) => warning.code),
      ...this.liveCodes.codes(),
      ...this.pricingWarnings().map((warning) => warning.code),
    ];
    if (hasNewWarningCode(this.writtenWarnings, codes)) {
      const current = this.warnings();
      this.manifest = { ...this.manifest, warnings: current };
      this.writeManifest().catch((error: unknown) => {
        this.writeError ??= error instanceof Error ? error : new Error(String(error));
      });
    }
  }

  /** Manifest writes go one after another, each writing the latest manifest. */
  private writeManifest(): Promise<void> {
    this.writtenWarnings = this.manifest.warnings;
    const written = this.manifestWrites.then(() => writeManifest(this.setup.runDir, this.manifest));
    this.manifestWrites = written.catch(() => undefined);
    return written;
  }

  private runCases(): RunCase[] {
    return this.setup.cases.map((spec) => ({
      id: spec.id,
      target: spec.target,
      lang: spec.lang,
      hash: spec.hash,
      current: { definition: spec.definition, hash: spec.hash, lang: spec.lang },
    }));
  }
}
