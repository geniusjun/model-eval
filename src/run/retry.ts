import type { AttemptLine } from './records.js';

// The retry column of data-model §Trial Outcomes, §Transient Failures and §Stopping.

/** No tool retry waits longer, so a daily-limit `retry-after` cannot freeze the run. */
export const RETRY_WAIT_CEILING_MS = 120_000;
/** The first backoff without `retryAfterMs`; each further transient attempt doubles it. */
export const BACKOFF_BASE_MS = 1_000;

/** A uniform draw in [0, 1), `Math.random` unless a test injects one. */
export type RandomSource = () => number;

/**
 * Where a trial key stands, from its attempt lines over all segments in order:
 * - `unsent`: no attempt line yet;
 * - `finished`: the effective line leaves no tool retry;
 * - `retry`: a transient effective line with retries left, sent again after `waitMs`;
 * - `stopped`: the tool did not wait for the attempt; never finished, resent on resume.
 */
export type TrialState =
  | { readonly kind: 'unsent' }
  | { readonly kind: 'finished'; readonly effective: AttemptLine }
  | { readonly kind: 'retry'; readonly nextAttempt: number; readonly waitMs: number }
  | { readonly kind: 'stopped'; readonly nextAttempt: number };

function isTransient(line: AttemptLine): boolean {
  return line.status === 'error' && line.error.kind === 'transient';
}

/**
 * `retryAfterMs` when the failure asked for a wait, else 1 s doubled per retry with the wait drawn
 * between half and all of it, so trials that hit the same 429 do not retry together; both capped.
 */
export function retryWaitMs(
  retryAfterMs: number | undefined,
  transientAttempts: number,
  random: RandomSource = Math.random,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, RETRY_WAIT_CEILING_MS);
  }
  const backoff = BACKOFF_BASE_MS * 2 ** Math.max(0, transientAttempts - 1);
  return Math.min(backoff * (0.5 + random() / 2), RETRY_WAIT_CEILING_MS);
}

/**
 * `retries` is the run's recorded `run.retries`. Transient attempts are counted across every
 * segment, so a resumed trial never gets more retries than an uninterrupted one.
 */
export function trialState(
  attempts: readonly AttemptLine[],
  retries: number,
  random: RandomSource = Math.random,
): TrialState {
  const effective = attempts.at(-1);
  if (effective === undefined) {
    return { kind: 'unsent' };
  }
  const nextAttempt = effective.attempt + 1;
  if (effective.status === 'stopped') {
    return { kind: 'stopped', nextAttempt };
  }
  if (effective.status === 'error' && effective.error.kind === 'transient') {
    const transientAttempts = attempts.filter(isTransient).length;
    if (transientAttempts < retries + 1) {
      const waitMs = retryWaitMs(effective.error.retryAfterMs, transientAttempts, random);
      return { kind: 'retry', nextAttempt, waitMs };
    }
  }
  return { kind: 'finished', effective };
}
