import type { StopReason } from './status.js';
import type { FinishedCounts } from './trial-book.js';

// data-model §Stopping.

/** Error rates are checked only once this many trials have finished. */
export const STOP_RATE_MIN_FINISHED = 20;

/** One stop shared by every run that stops together; both runs of a swap record its reason. */
export interface StopSignal {
  /** `config-error` when it was raised, else the first reason raised. */
  readonly reason: StopReason | undefined;
  raise(reason: StopReason): void;
}

export function createStopSignal(): StopSignal {
  let reason: StopReason | undefined;
  return {
    get reason() {
      return reason;
    },
    raise(next) {
      if (reason === undefined || next === 'config-error') {
        reason = next;
      }
    },
  };
}

/** The transient error rate of finished trials is above `run.maxTransientRate`. */
export function exceedsTransientRate(counts: FinishedCounts, maxTransientRate: number): boolean {
  return (
    counts.finished >= STOP_RATE_MIN_FINISHED &&
    counts.transient / counts.finished > maxTransientRate
  );
}
