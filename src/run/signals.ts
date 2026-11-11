import type { StopSignal } from './stopping.js';

// Interrupts (data-model §Stopping): SIGINT and SIGTERM. The first starts stopping, or keeps
// waiting when a stop is already under way; the second cuts the attempts in flight.

/** Hears each interrupt with how many arrived so far, from 1. */
export type InterruptListener = (count: number) => void;

export interface Interrupts {
  /** Listens until the returned function is called. */
  subscribe(listener: InterruptListener): () => void;
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** What {@link processInterrupts} needs of `process`. */
export interface SignalTarget {
  on(signal: (typeof SIGNALS)[number], handler: () => void): unknown;
  off(signal: (typeof SIGNALS)[number], handler: () => void): unknown;
}

/**
 * SIGINT and SIGTERM of `target`. The handlers are installed only while someone listens, so the
 * signals end the process as usual outside a run.
 */
export function processInterrupts(target: SignalTarget): Interrupts {
  const listeners = new Set<InterruptListener>();
  let count = 0;
  const handler = (): void => {
    count += 1;
    for (const listener of [...listeners]) {
      listener(count);
    }
  };
  return {
    subscribe(listener) {
      if (listeners.size === 0) {
        for (const signal of SIGNALS) {
          target.on(signal, handler);
        }
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          for (const signal of SIGNALS) {
            target.off(signal, handler);
          }
          count = 0;
        }
      };
    },
  };
}

/** Runs that can be cut by a second interrupt. */
export interface Cuttable {
  /** Records every attempt in flight as `stopped` and gives the adapter's requests up. */
  cut(): void;
}

export interface InterruptWatch {
  /** A second interrupt while sending cut the runs, which stopped as `interrupted`. */
  readonly cut: boolean;
  /**
   * A second interrupt came: the command compares and writes nothing more and ends. While
   * grading or comparing it changes no record, so finished runs stay complete and an unfinished
   * swap stays `running`, which `swap --resume` compares without sending.
   */
  readonly quit: boolean;
  /**
   * Sending is over and the command grades, compares and writes: a first interrupt now has
   * nothing to stop and lets it finish.
   */
  finishing(): void;
  dispose(): void;
}

/**
 * From the first send until the command ends. While runs send, the first interrupt raises
 * `interrupted`, which never cuts an attempt, since people press it without knowing a stop is in
 * progress and resent attempts would get extra chances, and the second cuts every run. Once
 * sending is over, the first lets the command finish and the second only quits.
 */
export function watchInterrupts(
  interrupts: Interrupts | undefined,
  stop: StopSignal,
  runs: readonly Cuttable[],
  onInterrupt?: InterruptListener,
): InterruptWatch {
  let cut = false;
  let quit = false;
  let sending = true;
  const dispose =
    interrupts?.subscribe((count) => {
      if (sending) {
        stop.raise('interrupted');
      }
      onInterrupt?.(count);
      if (count < 2 || quit) {
        return;
      }
      quit = true;
      if (sending) {
        cut = true;
        for (const run of runs) {
          run.cut();
        }
      }
    }) ?? (() => undefined);
  return {
    get cut() {
      return cut;
    },
    get quit() {
      return quit;
    },
    finishing: () => {
      sending = false;
    },
    dispose,
  };
}
