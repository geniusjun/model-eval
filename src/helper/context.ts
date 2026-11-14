import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from '../adapter/canonical-json.js';
import type { JsonValue } from '../adapter/json-types.js';
import type { CapturedCall } from './capture.js';
import type { Case, Target, Variant } from './outcome.js';

// helper-api §Trial Context; data-model §Outside the Trial Context, §After the Function Returned.

/** data-model §Unfinished Calls: the wait keeps this much of the tool's time limit. */
export const KEPT_MS = 5000;
const POLL_MS = 10;

/** One `generate` or `render` request and the calls of its context. */
export class Trial {
  readonly started = performance.now();
  functionEndedAt: number | undefined;
  /**
   * running: the function runs; waiting: it returned and unfinished calls are awaited; sent: the
   * result was sent.
   */
  state: 'running' | 'waiting' | 'sent' = 'running';
  readonly calls: CapturedCall[] = [];
  cancelled = false;
  outsideContext = false;
  /** A `render` request (helper-api §Render Mode): no captured request is sent. */
  readonly rendering: boolean;

  constructor(
    readonly requestId: JsonValue,
    readonly target: Target,
    readonly testCase: Case,
    readonly variant: Variant,
    readonly timeoutMs: number,
  ) {
    this.rendering = testCase.rendering;
  }

  /**
   * When the wait for unfinished calls ends: the tool's time limit minus the time spent, keeping
   * 5 s for the result to reach the tool.
   */
  deadline(): number {
    return this.started + this.timeoutMs - KEPT_MS;
  }
}

/** The key of a JSON-RPC request ID in `HUB.trials`. */
export function trialKey(requestId: JsonValue): string {
  return canonicalJson(requestId);
}

/** The trial of the running async context. */
export const CURRENT_TRIAL = new AsyncLocalStorage<Trial>();

/** Where captured requests find their trial. */
class Hub {
  /** Sends the `calls` notifications that can go out now; set while the adapter listens. */
  flush: (() => void) | undefined;
  /** Trials in progress by `trialKey` of their request ID. */
  readonly trials = new Map<string, Trial>();
  /** Calls reported as `calls` notifications: late requests and requests of no trial. */
  private notified: CapturedCall[] = [];
  private flushScheduled = false;

  /**
   * Registers a captured request; false when it must not be sent (its trial was cancelled,
   * helper-api §Cancel).
   */
  start(call: CapturedCall): boolean {
    if (this.flush === undefined) {
      return true;
    }
    const trial = CURRENT_TRIAL.getStore() ?? this.trialWithoutContext(call);
    if (trial?.rendering === true) {
      // Render mode: the request gets the render-mode 400, and joins the render's calls while
      // its function runs, a request that joined it from outside any context included.
      call.renderOnly = true;
      if (trial.state === 'running') {
        trial.calls.push(call);
      }
      return true;
    }
    if (call.renderOnly) {
      return true;
    }
    if (trial?.cancelled === true) {
      return false;
    }
    call.trial = trial;
    if (trial?.state === 'running') {
      trial.calls.push(call);
    } else {
      call.notify = true;
      this.notified.push(call);
    }
    return true;
  }

  /**
   * data-model §Outside the Trial Context: the one trial in progress (a running render included);
   * with two or more, all of them end as A10, and the request gets the render-mode 400 when one
   * is a render; with none, the one trial waiting to send its result.
   */
  private trialWithoutContext(call: CapturedCall): Trial | undefined {
    const trials = [...this.trials.values()];
    const running = trials.filter((trial) => trial.state === 'running');
    if (running.length === 1) {
      return running[0];
    }
    if (running.length > 1) {
      for (const trial of running) {
        trial.outsideContext = true;
      }
      call.renderOnly = running.some((trial) => trial.rendering);
      return undefined;
    }
    const waiting = trials.filter((trial) => trial.state === 'waiting');
    return waiting.length === 1 ? waiting[0] : undefined;
  }

  /** A notified call that finished may be reported now. */
  callChanged(call: CapturedCall): void {
    if (!call.notify || !call.finished() || this.flush === undefined || this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flush?.();
    });
  }

  /**
   * Notified calls whose notification can go out now: finished (or all, with `force`), and their
   * trial's result already sent.
   */
  unreported(force: boolean): CapturedCall[] {
    const ready = this.notified.filter(
      (call) =>
        !call.recordSent &&
        (force || (call.finished() && (call.trial === undefined || call.trial.state === 'sent'))),
    );
    for (const call of ready) {
      call.recordSent = true;
    }
    this.notified = this.notified.filter((call) => !call.recordSent);
    return ready;
  }

  /** Whether a notified call is still in flight, for the wait at `shutdown`. */
  notifiedInFlight(): boolean {
    return this.notified.some((call) => call.inFlight());
  }
}

export const HUB = new Hub();

/** Resolves once the event loop has run its pending I/O callbacks (one `setImmediate`). */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Waits until the condition holds or the deadline (a `performance.now()` time) passes. */
export async function waitFor(condition: () => boolean, deadline: number): Promise<void> {
  while (performance.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
