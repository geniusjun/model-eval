import type { GenerateOutcome, LateResponse } from '../adapter/client.js';
import type { CallRecord, GenerateResult, Usage } from '../adapter/protocol.js';
import { hasConfigCall } from '../grade/outcome.js';
import { attemptCharge, type AttemptReport, type Charge, type ChargeContext } from './cost.js';
import type { AttemptLine, ErrorAttempt, OkAttempt } from './records.js';

// One attempt line from the adapter's answer to `generate` (data-model §Trial, Attempt Line).

export interface AttemptBase {
  readonly caseId: string;
  readonly repeat: number;
  readonly attempt: number;
  readonly segment: number;
  readonly seed: number;
}

export interface RecordedAttempt {
  readonly line: AttemptLine;
  readonly charge: Charge;
}

export interface CostFields {
  readonly usage?: Usage | undefined;
  readonly calls?: readonly CallRecord[] | undefined;
}

function costFields({ usage, calls }: CostFields): { usage?: Usage; calls?: CallRecord[] } {
  return {
    ...(usage === undefined ? {} : { usage }),
    ...(calls === undefined ? {} : { calls: [...calls] }),
  };
}

function chargeFields(charge: Charge): Pick<AttemptLine, 'costUsd' | 'costEstimated'> {
  return charge.estimated
    ? { costUsd: charge.costUsd, costEstimated: true }
    : { costUsd: charge.costUsd };
}

/** What the adapter reported, kept in the message of a trial a `config` call turns into row 1. */
function reportedSummary(line: AttemptLine): string {
  switch (line.status) {
    case 'ok':
      return `reported ${line.finalKind}`;
    case 'error':
      return `reported ${line.error.kind}: ${line.error.message}`;
    case 'stopped':
      return 'reported stopped';
  }
}

/**
 * A trial with any call that failed with kind `config` is a `config` error whatever the adapter
 * reported, so resume resends it after the fix (data-model §Trial Outcomes).
 */
function enforceConfig(line: AttemptLine): AttemptLine {
  if (!hasConfigCall(line.calls) || (line.status === 'error' && line.error.kind === 'config')) {
    return line;
  }
  const { caseId, repeat, attempt, segment, seed, costUsd, costEstimated, usage, calls, warnings } =
    line;
  return {
    caseId,
    repeat,
    attempt,
    segment,
    seed,
    status: 'error',
    error: { kind: 'config', message: reportedSummary(line) },
    costUsd,
    ...(costEstimated === undefined ? {} : { costEstimated }),
    ...costFields({ usage, calls }),
    ...(warnings === undefined ? {} : { warnings }),
  };
}

function resultLine(base: AttemptBase, result: GenerateResult, charge: Charge): AttemptLine {
  if ('error' in result) {
    const line: ErrorAttempt = {
      ...base,
      status: 'error',
      error: result.error,
      ...chargeFields(charge),
      ...costFields(result),
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
    };
    return line;
  }
  const line: OkAttempt = { ...result, ...base, status: 'ok', ...chargeFields(charge) };
  return line;
}

function adapterError(
  base: AttemptBase,
  error: ErrorAttempt['error'],
  charge: Charge,
  cost: CostFields = {},
): AttemptLine {
  return { ...base, status: 'error', error, ...chargeFields(charge), ...costFields(cost) };
}

function reportOf(outcome: GenerateOutcome): AttemptReport {
  switch (outcome.kind) {
    case 'result':
      return { answered: true, usage: outcome.value.usage, calls: outcome.value.calls };
    case 'rpc-error':
      return { answered: true, usage: outcome.data?.usage, calls: outcome.data?.calls };
    case 'invalid':
      return { answered: true };
    case 'lost':
    case 'timed-out':
      return { answered: false };
    case 'refused':
      // Nothing reached an adapter, so no model was called.
      return { answered: true, calls: [] };
  }
}

/** What a late response reports about cost; none when it has neither `usage` nor `calls`. */
export function lateCosts(response: LateResponse): CostFields | undefined {
  const report = reportOf(response);
  return report.answered && (report.usage !== undefined || report.calls !== undefined)
    ? report
    : undefined;
}

/**
 * Results and failure results keep what the adapter reported; JSON-RPC errors and broken
 * results are adapter errors; a request without an answer within the time limit is abandoned
 * with `timeout`, one whose process was lost with `restart`, both charged their reservation. A
 * request that reached no adapter is `stopped` at no cost, so a resume sends it.
 */
export function recordAttempt(
  base: AttemptBase,
  outcome: GenerateOutcome,
  context: ChargeContext,
): RecordedAttempt {
  const charge = attemptCharge(reportOf(outcome), context);
  switch (outcome.kind) {
    case 'refused':
      // An empty `calls` records that no model was called, so it counts no billed call.
      return { line: { ...base, status: 'stopped', ...chargeFields(charge), calls: [] }, charge };
    case 'result':
      return { line: enforceConfig(resultLine(base, outcome.value, charge)), charge };
    case 'rpc-error': {
      const { data } = outcome;
      const error = {
        kind: 'adapter' as const,
        message: outcome.message,
        ...(data?.capturedRaw === undefined ? {} : { capturedRaw: data.capturedRaw }),
      };
      return { line: enforceConfig(adapterError(base, error, charge, data)), charge };
    }
    case 'invalid':
      return {
        line: adapterError(base, { kind: 'adapter', message: outcome.message }, charge),
        charge,
      };
    case 'lost':
    case 'timed-out':
      return {
        line: adapterError(
          base,
          {
            kind: 'adapter',
            message: outcome.message,
            abandoned: outcome.kind === 'lost' ? 'restart' : 'timeout',
          },
          charge,
        ),
        charge,
      };
  }
}

/**
 * An attempt the tool stopped waiting for on a second interrupt: `stopped`, charged its
 * reservation since the request reached the adapter, and sent again on resume.
 */
export function stoppedAttempt(base: AttemptBase, context: ChargeContext): RecordedAttempt {
  const charge = attemptCharge({ answered: false }, context);
  return { line: { ...base, status: 'stopped', ...chargeFields(charge) }, charge };
}
