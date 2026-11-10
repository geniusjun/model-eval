import type { ActiveRun } from './active-run.js';
import { exceedsCap, reestimate, type CapLedger } from './cap.js';
import { pickVariant } from './order.js';
import type { StopSignal } from './stopping.js';

// The send loop over the runs that share one cap: one run for `run`, both variants of a swap,
// interleaved in the same order (data-model §Send Order 4, plan D8).

export interface DriveOptions {
  /** The cap every run of this drive shares. */
  readonly ledger: CapLedger;
  /** When one run stops, every run stops the same way. */
  readonly stop: StopSignal;
  /** Milliseconds for retry waits; `Date.now` unless a test sets it. */
  readonly now?: () => number;
}

function wait(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Re-estimates at the points each run reached: spent + remaining trials of every run at its
 * measured means, recorded in the run that reached the point. Above the cap, every run stops
 * with `budget-projected`.
 */
async function reestimateAt(runs: readonly ActiveRun[], options: DriveOptions): Promise<void> {
  // A run records the points it reached since the last pass also when another run's point of
  // this pass stopped the drive, since both reached them at once. Its points after its own stop,
  // and every point reached after an earlier stop, change nothing and are skipped.
  const stopped = options.stop.reason !== undefined;
  for (const run of runs) {
    for (const trigger of run.takeTriggers()) {
      if (stopped || !runs.some((each) => each.hasRemaining)) {
        continue;
      }
      const total = reestimate(
        options.ledger.spentUsd,
        runs.map((each) => each.projection()),
      );
      await run.recordProjection(trigger, total);
      if (exceedsCap(total, options.ledger.maxCostUsd)) {
        options.stop.raise('budget-projected');
        break;
      }
    }
  }
}

/**
 * Sends until every trial finished or a stop condition holds; once stopping, sends nothing new
 * and waits for the attempts in flight. Neither run gets ahead of another by the smallest
 * concurrency limit or more.
 */
export async function driveRuns(runs: readonly ActiveRun[], options: DriveOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const limit = Math.min(...runs.map((run) => run.concurrency));
  for (;;) {
    await reestimateAt(runs, options);
    const stopping = options.stop.reason !== undefined;
    if (!stopping) {
      const at = now();
      const index = pickVariant(
        runs.map((run) => run.progress(at)),
        limit,
      );
      const next = index === undefined ? undefined : runs[index];
      // A pick that sent nothing waits below, so the loop never turns without yielding.
      if (next !== undefined && (await next.sendNext(at))) {
        continue;
      }
    }
    const inFlight = runs.flatMap((run) => run.pending());
    // Read again: a send the cap refused has raised the stop since the read above.
    const retries =
      options.stop.reason !== undefined
        ? []
        : runs.flatMap((run) => {
            const at = run.nextRetryAt();
            return at === undefined ? [] : [at];
          });
    if (inFlight.length === 0 && retries.length === 0) {
      return;
    }
    const timer = retries.length === 0 ? undefined : wait(Math.min(...retries) - now());
    await Promise.race([...inFlight, ...(timer === undefined ? [] : [timer.promise])]);
    timer?.cancel();
  }
}
