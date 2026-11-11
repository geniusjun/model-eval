import { describe, expect, it } from 'vitest';

import type { ErrorKind } from '../../../src/adapter/protocol.js';
import type { AttemptLine } from '../../../src/run/records.js';
import {
  RETRY_WAIT_CEILING_MS,
  retryWaitMs,
  trialState,
  type TrialState,
} from '../../../src/run/retry.js';

const BASE = { caseId: 'greet-ko', repeat: 0, segment: 1, seed: 235035669, costUsd: 0 };

function ok(attempt: number): AttemptLine {
  return {
    ...BASE,
    attempt,
    status: 'ok',
    raw: 'hello',
    answers: 1,
    finalKind: 'model',
    final: 'hello',
    latencyMs: 10,
    finishReason: 'stop',
  };
}

function failed(attempt: number, kind: ErrorKind, retryAfterMs?: number): AttemptLine {
  return {
    ...BASE,
    attempt,
    status: 'error',
    error: { kind, message: kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  };
}

function stopped(attempt: number): AttemptLine {
  return { ...BASE, attempt, status: 'stopped' };
}

function stateOf(lines: readonly AttemptLine[], retries = 2): TrialState['kind'] {
  return trialState(lines, retries).kind;
}

describe('retry policy', () => {
  it('001 FR-009 retries only transient failures, per the retry column of the trial outcomes', () => {
    expect(stateOf([])).toBe('unsent');
    expect(stateOf([ok(1)])).toBe('finished');
    for (const kind of ['config', 'adapter', 'permanent', 'timeout'] as const) {
      expect(stateOf([failed(1, kind)])).toBe('finished');
    }
    expect(stateOf([failed(1, 'transient')])).toBe('retry');
  });

  it('001 FR-009 retries a transient trial run.retries times, then finishes it', () => {
    const lines = [failed(1, 'transient'), failed(2, 'transient')];
    expect(trialState(lines, 2, () => 1)).toEqual({ kind: 'retry', nextAttempt: 3, waitMs: 2000 });
    expect(stateOf([...lines, failed(3, 'transient')], 2)).toBe('finished');
    expect(stateOf([failed(1, 'transient')], 0)).toBe('finished');
    expect(stateOf([failed(1, 'transient'), ok(2)], 2)).toBe('finished');
  });

  it('001 FR-009 counts retries per key across attempts and segments, not renewed after a stop', () => {
    const lines = [failed(1, 'transient'), stopped(2)];
    expect(trialState(lines, 1)).toEqual({ kind: 'stopped', nextAttempt: 3 });
    expect(stateOf([...lines, failed(3, 'transient')], 1)).toBe('finished');
    expect(stateOf([...lines, failed(3, 'transient')], 2)).toBe('retry');
  });

  it('001 FR-009 waits retryAfterMs when given, never more than 120 s', () => {
    expect(RETRY_WAIT_CEILING_MS).toBe(120_000);
    const random = () => 0;
    expect(retryWaitMs(2000, 1, random)).toBe(2000);
    expect(retryWaitMs(0, 1, random)).toBe(0);
    expect(retryWaitMs(86_400_000, 1, random)).toBe(120_000);
    expect(trialState([failed(1, 'transient', 2500)], 2, random)).toEqual({
      kind: 'retry',
      nextAttempt: 2,
      waitMs: 2500,
    });
  });

  it('001 FR-009 otherwise doubles 1 s per retry, drawing each wait between half and all of it', () => {
    expect(retryWaitMs(undefined, 1, () => 1)).toBe(1000);
    expect(retryWaitMs(undefined, 1, () => 0)).toBe(500);
    expect(retryWaitMs(undefined, 2, () => 0.5)).toBe(1500);
    expect(retryWaitMs(undefined, 3, () => 1)).toBe(4000);
    expect(retryWaitMs(undefined, 3, () => 0)).toBe(2000);
    expect(retryWaitMs(undefined, 30, () => 0)).toBe(120_000);
    for (let draw = 0; draw < 20; draw += 1) {
      const wait = retryWaitMs(undefined, 2);
      expect(wait >= 1000 && wait <= 2000).toBe(true);
    }
  });
});
