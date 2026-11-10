import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { TrialKey } from './ids.js';

// data-model §Send Order and plan D8.

/** Cases in the first batch with two or more repeats; it sends their repeats 0 and 1. */
const FIRST_BATCH_CASES = 10;
/** Cases in the first batch with one repeat. */
const FIRST_BATCH_CASES_ONE_REPEAT = 20;

export interface OrderedCase {
  readonly id: string;
  /** The language key: the case's language, `*` without one. */
  readonly lang: string;
  /** The case file path; cases sort by it, then by `position` in the file. */
  readonly file: string;
  readonly position: number;
}

export interface SendPlan {
  /** Every trial of one variant in send order. */
  readonly keys: readonly TrialKey[];
  /** The first `firstBatch` keys are the first batch, re-estimated once they finish. */
  readonly firstBatch: number;
}

function byFileThenPosition(a: OrderedCase, b: OrderedCase): number {
  return compareCodeUnits(a.file, b.file) || a.position - b.position;
}

/** The target's languages first, then languages it does not list in sorted order. */
function languageOrder(preferred: readonly string[], cases: readonly OrderedCase[]): string[] {
  const rest = [...new Set(cases.map((item) => item.lang))]
    .filter((lang) => !preferred.includes(lang))
    .sort(compareCodeUnits);
  return [...preferred, ...rest];
}

/** Up to `count` cases, one per language in turn, each language in file order. */
function roundRobin(
  cases: readonly OrderedCase[],
  languages: readonly string[],
  count: number,
): OrderedCase[] {
  const queues = languages.map((lang) => cases.filter((item) => item.lang === lang));
  const picked: OrderedCase[] = [];
  for (
    let round = 0;
    picked.length < count && queues.some((queue) => round < queue.length);
    round += 1
  ) {
    for (const queue of queues) {
      const next = queue[round];
      if (next !== undefined && picked.length < count) {
        picked.push(next);
      }
    }
  }
  return picked;
}

/**
 * The send order of one variant. Both variants of a swap use the same plan; `languages` is the
 * target's `languages` (empty when it declares none).
 */
export function sendOrder(
  cases: readonly OrderedCase[],
  languages: readonly string[],
  repeats: number,
): SendPlan {
  const ordered = [...cases].sort(byFileThenPosition);
  const batchRepeats = Math.min(repeats, 2);
  const batchSize = batchRepeats === 1 ? FIRST_BATCH_CASES_ONE_REPEAT : FIRST_BATCH_CASES;
  const batchCases = roundRobin(ordered, languageOrder(languages, ordered), batchSize);
  const batch: TrialKey[] = [];
  for (let repeat = 0; repeat < batchRepeats; repeat += 1) {
    batch.push(...batchCases.map((item) => ({ caseId: item.id, repeat })));
  }
  const inBatch = new Set(batchCases.map((item) => item.id));
  const rest: TrialKey[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const item of ordered) {
      if (repeat >= batchRepeats || !inBatch.has(item.id)) {
        rest.push({ caseId: item.id, repeat });
      }
    }
  }
  return { keys: [...batch, ...rest], firstBatch: batch.length };
}

export interface KeyProgress {
  isFinished(key: TrialKey): boolean;
  /** Not finished, not in flight and not waiting for a retry. */
  isSendable(key: TrialKey): boolean;
}

/** The first sendable key in order whose previous repeat has finished. */
export function nextKey(keys: readonly TrialKey[], progress: KeyProgress): TrialKey | undefined {
  return keys.find(
    (key) =>
      progress.isSendable(key) &&
      (key.repeat === 0 || progress.isFinished({ caseId: key.caseId, repeat: key.repeat - 1 })),
  );
}

export interface VariantProgress {
  readonly id: string;
  /** Finished trials over all segments. */
  readonly finished: number;
  /** Trials sent at least once. */
  readonly started: number;
  /** `nextKey` has a key for this variant now. */
  readonly hasSendable: boolean;
  /** Some trial of this variant is not finished yet. */
  readonly hasRemaining: boolean;
}

/**
 * The variant whose next trial goes out, or `undefined` when every variant waits. A variant that
 * finished `limit` or more trials than another variant with trials left waits for it; among the
 * rest, the one that started fewer trials goes first, then the first listed.
 */
export function pickVariant(
  variants: readonly VariantProgress[],
  limit: number,
): string | undefined {
  const ahead = (variant: VariantProgress): boolean =>
    variants.some(
      (other) =>
        other !== variant && other.hasRemaining && variant.finished - other.finished >= limit,
    );
  const ready = variants.filter((variant) => variant.hasSendable && !ahead(variant));
  const first = ready.reduce<VariantProgress | undefined>(
    (best, variant) => (best === undefined || variant.started < best.started ? variant : best),
    undefined,
  );
  return first?.id;
}
