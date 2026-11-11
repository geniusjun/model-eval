import type { Usage } from '../adapter/protocol.js';
import { classifyTrial, effectiveAttempts } from '../grade/outcome.js';
import { overrunUsd } from './cap.js';
import type { Totals } from './manifest.js';
import type { TrialLine } from './records.js';

// `totals` of the manifest (data-model §Manifest).

type Outcomes = Totals['outcomes'];

const USAGE_BUCKETS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;

/** Trials per outcome over the effective line of each key; every `ok` row counts as `ok`. */
export function outcomeCounts(lines: readonly TrialLine[]): Outcomes {
  const counts = {
    ok: 0,
    config: 0,
    adapter: 0,
    transient: 0,
    permanent: 0,
    timeout: 0,
    stopped: 0,
  };
  for (const line of effectiveAttempts(lines)) {
    const outcome = classifyTrial(line);
    switch (outcome) {
      case 'stopped':
      case 'config':
      case 'adapter':
      case 'transient':
      case 'permanent':
      case 'timeout':
        counts[outcome] += 1;
        break;
      default:
        counts.ok += 1;
    }
  }
  return counts;
}

/** Lines that carry tokens and cost: attempt and cost lines. */
function costedLines(lines: readonly TrialLine[]) {
  return lines.flatMap((line) => ('sending' in line ? [] : [line]));
}

/** Token buckets summed; a bucket none of them reported is left out. */
export function addUsages(usages: readonly (Usage | undefined)[]): Usage {
  const total: { -readonly [K in keyof Usage]: number } = {};
  for (const usage of usages) {
    for (const bucket of USAGE_BUCKETS) {
      const value = usage?.[bucket];
      if (value !== undefined) {
        total[bucket] = (total[bucket] ?? 0) + value;
      }
    }
  }
  return total;
}

/**
 * Outcomes, tokens and cost of every line, the part of the cost charged as reservations or
 * substitute prices (`costEstimated`), the overrun and the duration.
 */
export function runTotals(lines: readonly TrialLine[], durationMs: number): Totals {
  let costUsd: number | null = 0;
  let reservedUsd = 0;
  for (const line of costedLines(lines)) {
    costUsd = costUsd === null || line.costUsd === null ? null : costUsd + line.costUsd;
    if (line.costEstimated === true) {
      reservedUsd += line.costUsd ?? 0;
    }
  }
  return {
    outcomes: outcomeCounts(lines),
    tokens: addUsages(costedLines(lines).map((line) => line.usage)),
    costUsd,
    reservedUsd,
    overrunUsd: overrunUsd(lines),
    durationMs,
  };
}
