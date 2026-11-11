import { describe, expect, it } from 'vitest';

import { RUN_ID_PATTERN, SWAP_ID_PATTERN } from '../../../src/run/manifest.js';
import { newRunId, newSwapId, trialSeed, type TrialKey } from '../../../src/run/ids.js';
import {
  nextKey,
  pickVariant,
  sendOrder,
  type OrderedCase,
  type VariantProgress,
} from '../../../src/run/order.js';

const AT = new Date('2026-11-05T10:15:00.000Z');

describe('identifiers', () => {
  it('001 FR-016 derives the per-trial seed of the data-model example', () => {
    expect(trialSeed(1729, 'greet-ko', 0)).toBe(235035669);
  });

  it('001 FR-016 gives an unsigned 32-bit seed that depends only on seed, case and repeat', () => {
    const seeds = [0, 1, 2, 3].map((repeat) => trialSeed(1729, 'greet-ko', repeat));
    for (const seed of seeds) {
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff).toBe(true);
    }
    expect(new Set(seeds).size).toBe(4);
    expect(trialSeed(1729, 'greet-ko', 2)).toBe(seeds[2]);
    expect(trialSeed(1730, 'greet-ko', 0)).not.toBe(seeds[0]);
  });

  it('001 FR-016 formats runId and swapId from the UTC start time and a 4-hex suffix', () => {
    expect(newRunId('next', AT, () => 'a1b2')).toBe('20261105-101500-next-a1b2');
    expect(newSwapId(AT, () => 'c3d4')).toBe('20261105-101500-swap-c3d4');
    expect(newRunId('current', AT)).toMatch(RUN_ID_PATTERN);
    expect(newSwapId(AT)).toMatch(SWAP_ID_PATTERN);
  });
});

function cases(file: string, lang: string, count: number): OrderedCase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${lang}${String(index + 1)}`,
    lang,
    file,
    position: index,
  }));
}

function keys(spec: string): TrialKey[] {
  return spec.split(' ').map((item) => {
    const [caseId = '', repeat = ''] = item.split(':');
    return { caseId, repeat: Number(repeat) };
  });
}

// Given out of file order on purpose: the order comes from paths and positions.
const CASES: readonly OrderedCase[] = [
  ...cases('cases/ko.yaml', 'ko', 5),
  ...cases('cases/en.yaml', 'en', 5),
  ...cases('cases/ja.yaml', 'ja', 5),
].reverse();

describe('send order', () => {
  it('001 FR-032 sends a first batch of 10 cases alternating languages, repeat 0 then 1, then repeat-major', () => {
    const plan = sendOrder(CASES, ['ko', 'en', 'ja'], 3);
    const batch = 'ko1 en1 ja1 ko2 en2 ja2 ko3 en3 ja3 ko4'.split(' ');
    expect(plan.firstBatch).toBe(20);
    expect(plan.keys).toEqual([
      ...batch.map((caseId) => ({ caseId, repeat: 0 })),
      ...batch.map((caseId) => ({ caseId, repeat: 1 })),
      ...keys('en4:0 en5:0 ja4:0 ja5:0 ko5:0'),
      ...keys('en4:1 en5:1 ja4:1 ja5:1 ko5:1'),
      ...keys(
        'en1:2 en2:2 en3:2 en4:2 en5:2 ja1:2 ja2:2 ja3:2 ja4:2 ja5:2 ko1:2 ko2:2 ko3:2 ko4:2 ko5:2',
      ),
    ]);
  });

  it('001 FR-032 picks 20 cases for repeat 0 with one repeat, and uses what exists when fewer', () => {
    const plan = sendOrder(CASES, ['ko', 'en', 'ja'], 1);
    expect(plan.firstBatch).toBe(15);
    expect(plan.keys).toEqual(
      keys(
        'ko1:0 en1:0 ja1:0 ko2:0 en2:0 ja2:0 ko3:0 en3:0 ja3:0 ko4:0 en4:0 ja4:0 ko5:0 en5:0 ja5:0',
      ),
    );
  });

  it('001 FR-032 orders languages the target does not list by their sorted codes', () => {
    const plan = sendOrder([...cases('a.yaml', 'ja', 1), ...cases('b.yaml', 'en', 1)], [], 1);
    expect(plan.keys).toEqual(keys('en1:0 ja1:0'));
  });

  it('001 FR-032 sends repeat r of a case only after repeat r - 1 of that case finished', () => {
    const plan = sendOrder(cases('a.yaml', 'ko', 2), ['ko'], 2);
    expect(plan.keys).toEqual(keys('ko1:0 ko2:0 ko1:1 ko2:1'));
    const sent = new Set<string>(['ko1:0', 'ko2:0']);
    const finished = new Set<string>(['ko2:0']);
    const progress = {
      isFinished: (key: TrialKey) => finished.has(`${key.caseId}:${String(key.repeat)}`),
      isSendable: (key: TrialKey) => !sent.has(`${key.caseId}:${String(key.repeat)}`),
    };
    expect(nextKey(plan.keys, progress)).toEqual({ caseId: 'ko2', repeat: 1 });
    sent.add('ko2:1');
    expect(nextKey(plan.keys, progress)).toBeUndefined();
    finished.add('ko1:0');
    expect(nextKey(plan.keys, progress)).toEqual({ caseId: 'ko1', repeat: 1 });
  });
});

function variant(finished: number, started: number, more = true): VariantProgress {
  return { finished, started, hasSendable: more, hasRemaining: more };
}

describe('variant interleaving', () => {
  it('001 FR-032 makes a variant wait once it has finished the concurrency limit more trials', () => {
    expect(pickVariant([variant(4, 6), variant(0, 4)], 4)).toBe(1);
    const bBusy = { ...variant(0, 4), hasSendable: false };
    expect(pickVariant([variant(4, 6), bBusy], 4)).toBeUndefined();
    expect(pickVariant([variant(3, 6), bBusy], 4)).toBe(0);
  });

  it('001 FR-032 ignores a variant with nothing left', () => {
    expect(pickVariant([variant(40, 40), variant(0, 0, false)], 4)).toBe(0);
  });

  it('001 FR-032 alternates variants, the one that started fewer trials first', () => {
    expect(pickVariant([variant(0, 0), variant(0, 0)], 4)).toBe(0);
    expect(pickVariant([variant(0, 1), variant(0, 0)], 4)).toBe(1);
  });

  it('001 FR-032 tells runs with equal progress apart by position', () => {
    const same = variant(2, 3);
    expect(pickVariant([same, { ...same }], 4)).toBe(0);
    expect(pickVariant([{ ...same, started: 4 }, same], 4)).toBe(1);
  });

  it('001 FR-032 sends both variants the same plan with neither ahead by the limit', () => {
    const plan = sendOrder(CASES, ['ko', 'en', 'ja'], 2);
    const limit = 2;
    const state = new Map(
      ['a', 'b'].map((id) => [id, { sent: [] as TrialKey[], finished: new Set<string>() }]),
    );
    const label = (key: TrialKey): string => `${key.caseId}:${String(key.repeat)}`;
    const progressOf = (id: string) => {
      const own = state.get(id);
      if (own === undefined) {
        throw new Error(id);
      }
      return {
        own,
        order: {
          isFinished: (key: TrialKey) => own.finished.has(label(key)),
          isSendable: (key: TrialKey) => !own.sent.some((sent) => label(sent) === label(key)),
        },
      };
    };
    // Variant a finishes every trial at once; b finishes its oldest trial every third step.
    for (let step = 0; step < 400; step += 1) {
      const views = ['a', 'b'].map((id) => {
        const { own, order } = progressOf(id);
        const next = nextKey(plan.keys, order);
        return {
          id,
          progress: {
            finished: own.finished.size,
            started: own.sent.length,
            hasSendable: next !== undefined,
            hasRemaining: own.finished.size < plan.keys.length,
          },
          next,
        };
      });
      const picked = pickVariant(
        views.map((view) => view.progress),
        limit,
      );
      const view = picked === undefined ? undefined : views[picked];
      if (view?.next !== undefined) {
        const { own } = progressOf(view.id);
        const other = views.find((item) => item !== view)?.progress;
        if (other?.hasRemaining === true) {
          expect(view.progress.finished - other.finished).toBeLessThan(limit);
        }
        own.sent.push(view.next);
        if (view.id === 'a') {
          own.finished.add(label(view.next));
        }
      }
      const b = progressOf('b').own;
      const oldest = b.sent.find((key) => !b.finished.has(label(key)));
      if (oldest !== undefined && (step % 3 === 0 || picked === undefined)) {
        b.finished.add(label(oldest));
      }
    }
    const a = progressOf('a').own;
    const b = progressOf('b').own;
    expect(a.sent).toEqual(plan.keys);
    expect(b.sent.map(label).sort()).toEqual(plan.keys.map(label).sort());
  });
});
