import type { RunCase } from '../grade/grade.js';
import type { PerRole } from '../stats/interval.js';

/** A case both runs sent and whose content is still the same (FR-027). */
export interface CommonCase {
  readonly id: string;
  /** Language key from the baseline manifest. */
  readonly lang: string;
}

const unchanged = (runCase: RunCase): boolean => runCase.current?.hash === runCase.hash;

/**
 * Cases in both runs whose current hash still equals the hash each manifest recorded, in baseline
 * manifest order. Cells, metrics and warnings use these cases only.
 */
export function commonCases(cases: PerRole<readonly RunCase[]>): CommonCase[] {
  const candidate = new Map(cases.candidate.map((runCase) => [runCase.id, runCase]));
  return cases.baseline.flatMap((baseline) => {
    const other = candidate.get(baseline.id);
    return other !== undefined && unchanged(baseline) && unchanged(other)
      ? [{ id: baseline.id, lang: baseline.lang }]
      : [];
  });
}
