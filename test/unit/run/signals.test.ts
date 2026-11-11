import { describe, expect, it } from 'vitest';

import {
  processInterrupts,
  watchInterrupts,
  type Cuttable,
  type SignalTarget,
} from '../../../src/run/signals.js';
import { createStopSignal } from '../../../src/run/stopping.js';

type Signal = 'SIGINT' | 'SIGTERM';

/** A process stand-in that records its handlers and can deliver a signal to them. */
function fakeTarget() {
  const handlers = new Map<Signal, Set<() => void>>([
    ['SIGINT', new Set()],
    ['SIGTERM', new Set()],
  ]);
  const target: SignalTarget = {
    on(signal, handler) {
      handlers.get(signal)?.add(handler);
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler);
    },
  };
  return {
    target,
    installed: (signal: Signal): number => handlers.get(signal)?.size ?? 0,
    deliver: (signal: Signal): void => {
      for (const handler of [...(handlers.get(signal) ?? [])]) {
        handler();
      }
    },
  };
}

function cuttable() {
  let cuts = 0;
  const run: Cuttable = {
    cut: () => {
      cuts += 1;
    },
  };
  return { run, cuts: () => cuts };
}

describe('processInterrupts', () => {
  it('001 FR-013 listens to SIGINT and SIGTERM only while someone subscribes', () => {
    const fake = fakeTarget();
    const interrupts = processInterrupts(fake.target);
    expect(fake.installed('SIGINT')).toBe(0);
    const first = interrupts.subscribe(() => undefined);
    const second = interrupts.subscribe(() => undefined);
    expect([fake.installed('SIGINT'), fake.installed('SIGTERM')]).toEqual([1, 1]);
    first();
    expect(fake.installed('SIGINT')).toBe(1);
    second();
    expect([fake.installed('SIGINT'), fake.installed('SIGTERM')]).toEqual([0, 0]);
  });

  it('001 FR-013 counts SIGINT and SIGTERM together and starts again for a new subscription', () => {
    const fake = fakeTarget();
    const interrupts = processInterrupts(fake.target);
    const counts: number[] = [];
    const stop = interrupts.subscribe((count) => counts.push(count));
    fake.deliver('SIGINT');
    fake.deliver('SIGTERM');
    stop();
    const again = interrupts.subscribe((count) => counts.push(count));
    fake.deliver('SIGTERM');
    again();
    expect(counts).toEqual([1, 2, 1]);
  });
});

describe('watchInterrupts', () => {
  it('001 FR-013 stops on the first interrupt while sending and cuts every run on the second', () => {
    const fake = fakeTarget();
    const stop = createStopSignal();
    const runs = [cuttable(), cuttable()];
    const heard: number[] = [];
    const watch = watchInterrupts(
      processInterrupts(fake.target),
      stop,
      runs.map((each) => each.run),
      (count) => heard.push(count),
    );
    fake.deliver('SIGINT');
    expect(stop.reason).toBe('interrupted');
    expect(watch.cut).toBe(false);
    expect(runs.map((each) => each.cuts())).toEqual([0, 0]);
    fake.deliver('SIGTERM');
    expect(watch.cut).toBe(true);
    expect(runs.map((each) => each.cuts())).toEqual([1, 1]);
    expect(heard).toEqual([1, 2]);
    watch.dispose();
    expect(fake.installed('SIGINT')).toBe(0);
  });

  it('001 FR-013 while grading and comparing, lets the first interrupt pass and quits on the second without changing the records', () => {
    const fake = fakeTarget();
    const stop = createStopSignal();
    const run = cuttable();
    const watch = watchInterrupts(processInterrupts(fake.target), stop, [run.run]);
    watch.finishing();
    fake.deliver('SIGINT');
    expect(stop.reason).toBeUndefined();
    expect(watch.quit).toBe(false);
    fake.deliver('SIGINT');
    // Runs that finished every trial stay complete: no stop reason, no cut, only the quit.
    expect(watch.quit).toBe(true);
    expect(watch.cut).toBe(false);
    expect(stop.reason).toBeUndefined();
    expect(run.cuts()).toBe(0);
    watch.dispose();
  });

  it('001 FR-013 a second interrupt while sending both cuts and quits', () => {
    const fake = fakeTarget();
    const stop = createStopSignal();
    const watch = watchInterrupts(processInterrupts(fake.target), stop, [cuttable().run]);
    fake.deliver('SIGINT');
    fake.deliver('SIGINT');
    expect([watch.cut, watch.quit, stop.reason]).toEqual([true, true, 'interrupted']);
    watch.dispose();
  });

  it('001 FR-013 keeps the reason of a stop already under way', () => {
    const fake = fakeTarget();
    const stop = createStopSignal();
    stop.raise('budget');
    const watch = watchInterrupts(processInterrupts(fake.target), stop, []);
    fake.deliver('SIGINT');
    expect(stop.reason).toBe('budget');
    watch.dispose();
  });
});
