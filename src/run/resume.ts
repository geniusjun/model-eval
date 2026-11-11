import path from 'node:path';

import { classifyTrial } from '../grade/outcome.js';
import { indexTrialLines } from './cost.js';
import { trialKeyId, trialSeed, type TrialKey } from './ids.js';
import type { Totals } from './manifest.js';
import type { AttemptLine, StoppedAttempt, TrialLine } from './records.js';
import { trialState, type TrialState } from './retry.js';
import type { RunRecords } from './run-records.js';
import { runTotals } from './totals.js';
import { truncateCutLine } from './trial-log.js';
import { openTrialLog, RUN_FILES } from './writer.js';

// Repairing a stopped or killed run and choosing what it sends when it resumes (data-model
// §Resume and Locking, §Trial).

/**
 * A `stopped` attempt line for every send line without its attempt line, in the send line's
 * segment and charged its reservation, so the next segment does not reserve it again.
 */
export function closingLines(lines: readonly TrialLine[], seed: number): StoppedAttempt[] {
  const closing: StoppedAttempt[] = [];
  for (const { sends, attempts } of indexTrialLines(lines).keys.values()) {
    const answered = new Set(attempts.map((line) => line.attempt));
    for (const send of sends) {
      if (!answered.has(send.attempt)) {
        closing.push({
          caseId: send.caseId,
          repeat: send.repeat,
          attempt: send.attempt,
          segment: send.segment,
          seed: trialSeed(seed, send.caseId, send.repeat),
          status: 'stopped',
          costUsd: send.reservedUsd,
          costEstimated: true,
        });
      }
    }
  }
  return closing;
}

/** The lines a resumed segment starts from: the complete lines and the closing lines. */
export function repairedLines(records: RunRecords): TrialLine[] {
  return [...records.lines, ...closingLines(records.lines, records.manifest.sampling.seed)];
}

/**
 * Writes what {@link repairedLines} reads: the cut last line truncated and the closing lines
 * appended and flushed. Call it only while holding the run's lock.
 */
export async function repairRunRecords(records: RunRecords): Promise<TrialLine[]> {
  const file = path.join(records.runDir, RUN_FILES.trials);
  await truncateCutLine(file, records.log);
  const lines = repairedLines(records);
  const closing = lines.slice(records.lines.length);
  if (closing.length > 0) {
    const log = await openTrialLog(file);
    try {
      await Promise.all(closing.map((line) => log.append(line)));
    } finally {
      await log.close();
    }
  }
  return lines;
}

/**
 * Where a trial key stands when a segment starts. `resend` is a trial whose effective line is
 * `stopped` or a `config` error: it goes out again, under its next attempt number. A transient
 * trial with retries left may go out at once, since the wait has passed while the run was
 * stopped.
 */
export type ResumedState =
  | Exclude<TrialState, { readonly kind: 'stopped' }>
  | { readonly kind: 'resend'; readonly nextAttempt: number };

/**
 * Finished trials that ended in other errors stay as they are: an uninterrupted run would not
 * resend them either, and resending could erase systematic failures. `config` errors are
 * environment problems and go out again once fixed.
 */
export function resumedState(attempts: readonly AttemptLine[], retries: number): ResumedState {
  const state = trialState(attempts, retries);
  switch (state.kind) {
    case 'unsent':
      return state;
    case 'stopped':
      return { kind: 'resend', nextAttempt: state.nextAttempt };
    case 'retry':
      return { ...state, waitMs: 0 };
    case 'finished':
      return classifyTrial(state.effective) === 'config'
        ? { kind: 'resend', nextAttempt: state.effective.attempt + 1 }
        : state;
  }
}

/** The keys of `keys`, in their order, that a resumed segment sends. */
export function trialsToSend(
  lines: readonly TrialLine[],
  keys: readonly TrialKey[],
  retries: number,
): TrialKey[] {
  const index = indexTrialLines(lines).keys;
  return keys.filter(
    (trial) =>
      resumedState(index.get(trialKeyId(trial))?.attempts ?? [], retries).kind !== 'finished',
  );
}

function addUsd(total: number | null, value: number | null): number | null {
  return total === null || value === null ? null : total + value;
}

/** Spend of the lines `segment` wrote; the closing line of a send counts in the send's segment. */
export function segmentSpentUsd(lines: readonly TrialLine[], segment: number): number | null {
  return lines
    .flatMap((line) => ('sending' in line || line.segment !== segment ? [] : [line.costUsd]))
    .reduce<number | null>(addUsd, 0);
}

export interface Recount {
  readonly spentUsd: number | null;
  readonly totals: Totals;
}

/**
 * Spend and `totals` from the lines alone, since a kill may have left the manifest's summaries
 * behind the last line.
 */
export function recount(lines: readonly TrialLine[], durationMs: number): Recount {
  const totals = runTotals(lines, durationMs);
  return { spentUsd: totals.costUsd, totals };
}
