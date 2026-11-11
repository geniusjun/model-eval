import { indexTrialLines, type PerTrialUsd } from './cost.js';
import type { CostProfile } from './manifest.js';
import type { TrialLine } from './records.js';
import type { Warning } from './warning.js';

// data-model §Cap Check. Scope: spend the tool counted over both runs of a swap and every earlier
// segment of a resumed run.

export interface CapCheck {
  /** `null` values are unknown because no price is configured (only possible without a cap). */
  readonly spentUsd: number | null;
  /** `reservedUsd` of the send lines of attempts still in flight. */
  readonly inFlightUsd: number | null;
  readonly reservationUsd: number | null;
  /** `null` means no cap. */
  readonly maxCostUsd: number | null;
}

/** spent + in-flight reservations + this reservation ≤ cap; an unknown amount never fits a cap. */
export function fitsCap(check: CapCheck): boolean {
  if (check.maxCostUsd === null) {
    return true;
  }
  const total = addUsd(addUsd(check.spentUsd, check.inFlightUsd), check.reservationUsd);
  return total !== null && total <= check.maxCostUsd;
}

function addUsd(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** The cap or `null`, and whether a re-estimated total is above it (`budget-projected`). */
export function exceedsCap(totalUsd: number | null, maxCostUsd: number | null): boolean {
  return maxCostUsd !== null && (totalUsd === null || totalUsd > maxCostUsd);
}

/** One attempt's reservation while it is in flight. */
export interface Reservation {
  /** `null` only without a cap and without any configured price. */
  readonly reservedUsd: number | null;
  /**
   * Ends the reservation with the attempt line's cost. An attempt that ended without an answer is
   * charged its reservation here, so it is counted in spent once and not added again.
   */
  settle(costUsd: number | null): void;
}

/** Spend and in-flight reservations shared by every run under one cap. */
export interface CapLedger {
  readonly maxCostUsd: number | null;
  readonly spentUsd: number | null;
  readonly inFlightUsd: number | null;
  /** The check before every attempt, tool retries included; `undefined` means stop with `budget`. */
  trySend(reservationUsd: number | null): Reservation | undefined;
  /** Adds the cost of a cost line. */
  charge(costUsd: number | null): void;
}

/** `spentUsd` is the spend recounted from earlier segments (0 for a new run). */
export function createCapLedger(maxCostUsd: number | null, spentUsd: number | null): CapLedger {
  let spent = spentUsd;
  const inFlight = new Set<Reservation>();
  const add = (costUsd: number | null): void => {
    spent = addUsd(spent, costUsd);
  };
  const inFlightUsd = (): number | null =>
    [...inFlight].reduce<number | null>(
      (total, reservation) => addUsd(total, reservation.reservedUsd),
      0,
    );
  return {
    maxCostUsd,
    get spentUsd() {
      return spent;
    },
    get inFlightUsd() {
      return inFlightUsd();
    },
    trySend(reservationUsd) {
      const check = { spentUsd: spent, inFlightUsd: inFlightUsd(), reservationUsd, maxCostUsd };
      if (!fitsCap(check)) {
        return undefined;
      }
      const reservation: Reservation = {
        reservedUsd: reservationUsd,
        settle(costUsd) {
          if (inFlight.delete(reservation)) {
            add(costUsd);
          }
        },
      };
      inFlight.add(reservation);
      return reservation;
    },
    charge: add,
  };
}

export interface GroupCounts {
  readonly repeat0: number;
  readonly repeatN: number;
}

/** One variant's inputs to a re-estimate, per language key. */
export interface VariantProjection {
  readonly firstBatchFinished: boolean;
  /** Measured means of the finished keys so far (`costProfiles` of the run's lines). */
  readonly measured: Readonly<
    Record<string, Pick<CostProfile, 'repeat0MeanUsd' | 'repeatNMeanUsd'>>
  >;
  /** The pre-start expected value per trial (`expectedEstimate(...).perTrial`). */
  readonly expected: Readonly<Record<string, PerTrialUsd>>;
  /** Trials not finished yet. */
  readonly remaining: Readonly<Record<string, GroupCounts>>;
}

function groupUsd(
  trials: number,
  measured: number | null | undefined,
  expected: number | null | undefined,
): number | null {
  if (trials === 0) {
    return 0;
  }
  const perTrial = measured ?? expected;
  return perTrial === undefined || perTrial === null ? null : trials * perTrial;
}

/**
 * spent + remaining trials × measured mean per variant and language, repeat 0 and later repeats
 * separate. A variant whose first batch has not finished, and a group nothing has measured yet,
 * use the pre-start expected value per trial, so spent cost is not counted twice.
 */
export function reestimate(
  spentUsd: number | null,
  variants: readonly VariantProjection[],
): number | null {
  let total = spentUsd;
  for (const variant of variants) {
    for (const [lang, counts] of Object.entries(variant.remaining)) {
      const measured = variant.firstBatchFinished ? variant.measured[lang] : undefined;
      const expected = variant.expected[lang];
      for (const usd of [
        groupUsd(counts.repeat0, measured?.repeat0MeanUsd, expected?.repeat0),
        groupUsd(counts.repeatN, measured?.repeatNMeanUsd, expected?.repeatN),
      ]) {
        total = total === null || usd === null ? null : total + usd;
      }
    }
  }
  return total;
}

/**
 * `totals.overrunUsd` of one run: per attempt, the cost of its attempt and cost lines minus its
 * reservation at send, positive amounts only; calls that belong to no known trial are all overrun.
 */
export function overrunUsd(lines: readonly TrialLine[]): number {
  const index = indexTrialLines(lines);
  let total = 0;
  for (const key of index.keys.values()) {
    const attempts = new Set(
      [...key.sends, ...key.attempts, ...key.costLines].map((line) => line.attempt),
    );
    for (const attempt of attempts) {
      const send = key.sends.find((line) => line.attempt === attempt);
      const reserved = send === undefined ? 0 : send.reservedUsd;
      const costs = [...key.attempts, ...key.costLines]
        .filter((line) => line.attempt === attempt)
        .map((line) => line.costUsd);
      if (reserved !== null && costs.length > 0 && costs.every((cost) => cost !== null)) {
        total += Math.max(0, costs.reduce((sum, cost) => sum + cost, 0) - reserved);
      }
    }
  }
  for (const line of index.unkeyed) {
    total += line.costUsd ?? 0;
  }
  return total;
}

export function budgetOverrunWarning(variantId: string, overrun: number): Warning | undefined {
  return overrun > 0
    ? {
        code: 'budget-overrun',
        params: { overrunUsd: { [variantId]: overrun } },
        variants: [variantId],
      }
    : undefined;
}
