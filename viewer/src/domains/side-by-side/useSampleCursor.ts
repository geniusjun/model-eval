import { useCallback, useMemo } from 'react';

import type { Samples, SampleText } from '../../../../src/report/schema.js';
import { useHashParam } from '../../hooks/useHashParam.js';
import { findSampleText, ruleSampleKeys } from '../../report/sampleKeys.js';
import type { SideView } from '../../utils/hash.js';

/** A place in the side-by-side view: one case and repeat, shown for both variants. */
export interface SamplePosition {
  readonly caseId: string;
  readonly repeat: number;
}

export interface SampleCursor {
  readonly ruleId: string;
  readonly position: SamplePosition;
  /** 1-based, among the rule's cases. */
  readonly caseNumber: number;
  readonly caseCount: number;
  /** 1-based, among the repeats of this case. */
  readonly repeatNumber: number;
  readonly repeatCount: number;
  readonly baseline: SampleText | undefined;
  readonly candidate: SampleText | undefined;
  /** The first repeat of the case before or after, or undefined at the ends. */
  readonly previousCase: SamplePosition | undefined;
  readonly nextCase: SamplePosition | undefined;
  /** The repeat before or after in the same case, or undefined at the ends. */
  readonly previousRepeat: SamplePosition | undefined;
  readonly nextRepeat: SamplePosition | undefined;
}

/** Case IDs in UTF-16 code unit order, the order feature 001 sorts samples in. */
function compareCases(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function comparePositions(a: SamplePosition, b: SamplePosition): number {
  return compareCases(a.caseId, b.caseId) || a.repeat - b.repeat;
}

/**
 * The (case, repeat) pairs of a rule's `review` samples and failing examples, each once, by case
 * then repeat. A failing example of any of the rule's cells counts, so cells sharing a case and
 * repeat show it once.
 */
export function samplePositions(samples: Samples, ruleId: string): SamplePosition[] {
  const unique = new Map<string, SamplePosition>();
  for (const { caseId, repeat } of ruleSampleKeys(samples, ruleId)) {
    unique.set(JSON.stringify([caseId, repeat]), { caseId, repeat });
  }
  return [...unique.values()].sort(comparePositions);
}

/** The cursor at the position `view` names, or undefined when the rule has no such position. */
export function sampleCursor(samples: Samples, view: SideView): SampleCursor | undefined {
  const positions = samplePositions(samples, view.ruleId);
  const position = positions.find(
    (candidate) => candidate.caseId === view.caseId && candidate.repeat === view.repeat,
  );
  if (position === undefined) {
    return undefined;
  }
  const cases = [...new Set(positions.map((candidate) => candidate.caseId))];
  const caseIndex = cases.indexOf(position.caseId);
  const repeats = positions.filter((candidate) => candidate.caseId === position.caseId);
  const repeatIndex = repeats.indexOf(position);
  const firstOfCase = (caseId: string | undefined) =>
    positions.find((candidate) => candidate.caseId === caseId);
  const text = (variant: SampleText['variant']) =>
    findSampleText(samples.texts, { variant, caseId: position.caseId, repeat: position.repeat });
  return {
    ruleId: view.ruleId,
    position,
    caseNumber: caseIndex + 1,
    caseCount: cases.length,
    repeatNumber: repeatIndex + 1,
    repeatCount: repeats.length,
    baseline: text('baseline'),
    candidate: text('candidate'),
    previousCase: firstOfCase(cases[caseIndex - 1]),
    nextCase: firstOfCase(cases[caseIndex + 1]),
    previousRepeat: repeats[repeatIndex - 1],
    nextRepeat: repeats[repeatIndex + 1],
  };
}

export interface SampleCursorState {
  /** The cursor at the hash's position, or undefined when the hash names none. */
  readonly cursor: SampleCursor | undefined;
  /** Moves to another position of the same rule. */
  readonly go: (position: SamplePosition) => void;
  /** Opens a rule at its first position. */
  readonly chooseRule: (ruleId: string) => void;
}

/** The side-by-side position the page resolved from the hash, moved through the hash. */
export function useSampleCursor(samples: Samples, view: SideView | undefined): SampleCursorState {
  const [hash, setHash] = useHashParam();
  const { lang } = hash;
  const cursor = useMemo(
    () => (view === undefined ? undefined : sampleCursor(samples, view)),
    [samples, view],
  );
  const open = useCallback(
    (ruleId: string, position: SamplePosition) => {
      setHash({ view: { kind: 'side', ruleId, ...position }, lang });
    },
    [setHash, lang],
  );
  const ruleId = cursor?.ruleId;
  const go = useCallback(
    (position: SamplePosition) => {
      if (ruleId !== undefined) {
        open(ruleId, position);
      }
    },
    [open, ruleId],
  );
  const chooseRule = useCallback(
    (chosen: string) => {
      const [first] = samplePositions(samples, chosen);
      if (first !== undefined) {
        open(chosen, first);
      }
    },
    [open, samples],
  );
  return { cursor, go, chooseRule };
}
