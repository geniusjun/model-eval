import { describe, expect, it } from 'vitest';

import { createCapLedger } from '../../../src/run/cap.js';
import { createStopSignal } from '../../../src/run/stopping.js';
import { beginRuns } from '../../../src/run/swap.js';

/** A run whose steps write what happened to `log`. */
function fakeRun(role: string, log: string[]) {
  return {
    shutdown: () => {
      log.push(`${role} shutdown`);
      return Promise.resolve();
    },
    finish: () => {
      log.push(`${role} finish`);
      return Promise.resolve(`${role} end`);
    },
  };
}

function fakeClaim(role: string, log: string[], fails = false) {
  return {
    begin: () => {
      log.push(`${role} begin`);
      return fails
        ? Promise.reject(new Error(`${role} did not begin`))
        : Promise.resolve(fakeRun(role, log));
    },
    abandon: () => {
      log.push(`${role} abandon`);
      return Promise.resolve();
    },
  };
}

const shared = () => ({ ledger: createCapLedger(1, 0), stop: createStopSignal() });

/** Writes the swap record of a stop to `log`, or fails to. */
function closeSwap(log: string[], fails = false) {
  return (baseline: string): Promise<void> => {
    log.push(`close record after ${baseline}`);
    return fails ? Promise.reject(new Error('the record was not written')) : Promise.resolve();
  };
}

describe('beginning both runs of a swap', () => {
  it('001 FR-032 begins the baseline, then the candidate', async () => {
    const log: string[] = [];
    const runs = await beginRuns(
      { baseline: fakeClaim('baseline', log), candidate: fakeClaim('candidate', log) },
      shared(),
      closeSwap(log),
    );
    expect(Object.keys(runs)).toEqual(['baseline', 'candidate']);
    expect(log).toEqual(['baseline begin', 'candidate begin']);
  });

  it('001 FR-032 abandons the candidate when the baseline does not begin', async () => {
    const log: string[] = [];
    await expect(
      beginRuns(
        { baseline: fakeClaim('baseline', log, true), candidate: fakeClaim('candidate', log) },
        shared(),
        closeSwap(log),
      ),
    ).rejects.toThrow('baseline did not begin');
    expect(log).toEqual(['baseline begin', 'candidate abandon']);
  });

  it('001 FR-032 ends a begun baseline as a config-error stop when the candidate does not begin', async () => {
    const log: string[] = [];
    const swap = shared();
    await expect(
      beginRuns(
        { baseline: fakeClaim('baseline', log), candidate: fakeClaim('candidate', log, true) },
        swap,
        closeSwap(log),
      ),
    ).rejects.toThrow('candidate did not begin');
    expect(log).toEqual([
      'baseline begin',
      'candidate begin',
      'baseline shutdown',
      'baseline finish',
      'close record after baseline end',
    ]);
    expect(swap.stop.reason).toBe('config-error');
  });

  it('001 FR-032 reports the begin failure when closing the swap record fails too', async () => {
    const log: string[] = [];
    await expect(
      beginRuns(
        { baseline: fakeClaim('baseline', log), candidate: fakeClaim('candidate', log, true) },
        shared(),
        closeSwap(log, true),
      ),
    ).rejects.toThrow('candidate did not begin');
    expect(log.at(-1)).toBe('close record after baseline end');
  });
});
