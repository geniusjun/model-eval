import type { CallOutcome } from '../adapter/client.js';
import type { CallRecord, GenerateResult, Usage } from '../adapter/protocol.js';
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

interface CostFields {
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

/** A call failed with kind `config` (adapter-protocol §Reporting Model Failures, rule 6). */
export function hasConfigCall(calls: readonly CallRecord[] | undefined): boolean {
  return calls?.some((call) => call.outcome !== 'ok' && call.errorKind === 'config') ?? false;
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

function reportOf(outcome: CallOutcome<GenerateResult>): AttemptReport {
  switch (outcome.kind) {
    case 'result':
      return { answered: true, usage: outcome.value.usage, calls: outcome.value.calls };
    case 'rpc-error':
      return { answered: true, usage: outcome.data?.usage, calls: outcome.data?.calls };
    case 'invalid':
      return { answered: true };
    case 'lost':
      return { answered: false };
  }
}

/**
 * Results and failure results keep what the adapter reported; JSON-RPC errors and broken
 * results are adapter errors; a request whose process died is abandoned with `restart` and
 * charged its reservation.
 */
export function recordAttempt(
  base: AttemptBase,
  outcome: CallOutcome<GenerateResult>,
  context: ChargeContext,
): RecordedAttempt {
  const charge = attemptCharge(reportOf(outcome), context);
  switch (outcome.kind) {
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
      return {
        line: adapterError(
          base,
          { kind: 'adapter', message: outcome.message, abandoned: 'restart' },
          charge,
        ),
        charge,
      };
  }
}
