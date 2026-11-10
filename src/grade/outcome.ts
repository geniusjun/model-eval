import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { CallRecord } from '../adapter/protocol.js';
import type { AttemptLine, TrialLine } from '../run/records.js';

/**
 * The row of data-model §Trial Outcomes a trial falls in, plus `stopped`, which is outside the
 * table. Rows 1–5 are the error kinds; the rest name the shipped result.
 */
export type TrialOutcome =
  | 'stopped'
  | 'config'
  | 'adapter'
  | 'transient'
  | 'permanent'
  | 'timeout'
  | 'empty-raw'
  | 'discarded'
  | 'fallback'
  | 'empty-final'
  | 'cut'
  | 'complete';

/** The `completed` grade; `skip` stands for the table's "excluded" and "—". */
export type CompletedGrade = 'pass' | 'fail' | 'skip';

interface Columns {
  readonly completed: CompletedGrade;
  readonly raw: boolean;
  readonly final: boolean;
}

const COLUMNS: Readonly<Record<TrialOutcome, Columns>> = {
  stopped: { completed: 'skip', raw: false, final: false },
  config: { completed: 'skip', raw: false, final: false },
  adapter: { completed: 'skip', raw: false, final: false },
  transient: { completed: 'skip', raw: false, final: false },
  permanent: { completed: 'fail', raw: false, final: false },
  timeout: { completed: 'fail', raw: false, final: false },
  'empty-raw': { completed: 'fail', raw: false, final: false },
  discarded: { completed: 'fail', raw: true, final: false },
  fallback: { completed: 'fail', raw: true, final: false },
  'empty-final': { completed: 'fail', raw: true, final: false },
  cut: { completed: 'fail', raw: true, final: true },
  complete: { completed: 'pass', raw: true, final: true },
};

// The 25 Unicode White_Space code points, which is exactly the set \p{White_Space} matches.
const BLANK = /^\p{White_Space}*$/u;

/** Nothing remains after trimming White_Space from both ends. */
export function isEmptyText(text: string): boolean {
  return BLANK.test(text);
}

/**
 * A call with `errorKind` `config`, whatever its `outcome`: row 1 for the trial that carries it,
 * and a stop condition for the run (data-model §Trial Outcomes).
 */
export function hasConfigCall(calls: readonly CallRecord[] | undefined): boolean {
  return calls?.some((call) => call.errorKind === 'config') ?? false;
}

/** The first matching row decides. */
export function classifyTrial(line: AttemptLine): TrialOutcome {
  if (line.status === 'stopped') {
    return 'stopped';
  }
  // Row 1 whatever the adapter reported, so resume resends the trial after the fix.
  if (hasConfigCall(line.calls)) {
    return 'config';
  }
  if (line.status === 'error') {
    return line.error.kind;
  }
  if (line.answers === 1 && isEmptyText(line.raw)) {
    return 'empty-raw';
  }
  switch (line.finalKind) {
    case 'discarded':
      return 'discarded';
    case 'fallback':
      return 'fallback';
    case 'model':
      if (isEmptyText(line.final)) {
        return 'empty-final';
      }
      return line.finishReason === 'stop' ? 'complete' : 'cut';
  }
}

/** The `completed` check: the trial surface's grade. */
export function completedGrade(outcome: TrialOutcome): CompletedGrade {
  return COLUMNS[outcome].completed;
}

/**
 * The first answer when raw rules judge it. An empty raw answer is excluded too, because it
 * would pass every forbidding check.
 */
export function rawSurfaceText(line: AttemptLine): string | undefined {
  if (line.status !== 'ok' || !COLUMNS[classifyTrial(line)].raw || isEmptyText(line.raw)) {
    return undefined;
  }
  return line.raw;
}

/** The shipped text when final rules judge it: only the model's own, non-empty answer. */
export function finalSurfaceText(line: AttemptLine): string | undefined {
  if (line.status !== 'ok' || line.finalKind !== 'model' || !COLUMNS[classifyTrial(line)].final) {
    return undefined;
  }
  return line.final;
}

/**
 * Transient and adapter errors leave the denominators unless they concentrate on one case of
 * one variant (data-model §Systematic Failures); the comparison applies that, since it needs
 * both runs.
 */
export function mayBeSystematic(outcome: TrialOutcome): boolean {
  return outcome === 'adapter' || outcome === 'transient';
}

/** The effective line of every trial key, the last attempt line written, sorted by case and repeat. */
export function effectiveAttempts(lines: readonly TrialLine[]): AttemptLine[] {
  const byKey = new Map<string, AttemptLine>();
  for (const line of lines) {
    if ('status' in line) {
      byKey.set(`${line.caseId}:${String(line.repeat)}`, line);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => compareCodeUnits(a.caseId, b.caseId) || a.repeat - b.repeat,
  );
}
