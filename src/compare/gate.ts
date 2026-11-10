import type { z } from 'zod';

import type { ExitName } from '../cli/exit-codes.js';
import type { GateConfig, Rule, Surface } from '../config/schema.js';
import { classifyTrial, completedGrade } from '../grade/outcome.js';
import type { Cell, Comparison, Gate, GateReason } from '../report/schema.js';
import { trialKeyId } from '../run/ids.js';
import type { AttemptLine } from '../run/records.js';
import type { RunStatus, StopReason } from '../run/status.js';
import type { abandonedCountsSchema, Warning } from '../run/warning.js';
import type { PerRole } from '../stats/interval.js';
import { isUndecided } from '../stats/verdict.js';
import { baselineRate, isNotApplicable, type CellEvidence, type CellKey } from './cells.js';
import type { CommonCase } from './common-cases.js';

// data-model §Gate: gated rules and cells, the completion rate and the row order.

export type ExcludedRule = Gate['excluded'][number];
export type LanguageCompletion = Comparison['completion'][number];
type AbandonedCounts = z.infer<typeof abandonedCountsSchema>;

type Role = keyof PerRole<unknown>;

const ROLES: readonly Role[] = ['baseline', 'candidate'];

/** Row 3 is a premise check, not a statistical threshold. */
const BASELINE_COMPLETION_FLOOR = 0.5;

/** `dominant-error` compares messages on their first 200 characters. */
const DOMINANT_MESSAGE_LENGTH = 200;
const DOMINANT_SHARE = 0.8;

export interface GateRules {
  /** Gated rules, in rule order. */
  readonly gated: readonly Rule[];
  /** Rules of a gated severity removed from the gate. */
  readonly excluded: readonly ExcludedRule[];
}

/**
 * Active rules applicable to the compared targets whose severity is in `gate.severities`;
 * `review` rules among them go to `excluded` (constitution III).
 */
export function gateRules(
  rules: readonly Rule[],
  targets: readonly string[],
  gate: GateConfig,
): GateRules {
  const candidates = rules.filter(
    (rule) =>
      rule.status === 'active' &&
      gate.severities.includes(rule.severity) &&
      (rule.targets.length === 0 || rule.targets.some((target) => targets.includes(target))),
  );
  return {
    gated: candidates.filter((rule) => rule.check.type !== 'review'),
    excluded: candidates
      .filter((rule) => rule.check.type === 'review')
      .map((rule) => ({ ruleId: rule.id, cause: 'review' })),
  };
}

/** The `excluded-from-gate` warning of each excluded rule. */
export function excludedFromGateWarnings(excluded: readonly ExcludedRule[]): Warning[] {
  return excluded.map(({ ruleId, cause }) => ({
    code: 'excluded-from-gate',
    ruleId,
    params: { cause },
  }));
}

/** The surface the gate reads: `trial` for `completed`, else the rule's `gateOn`. */
export function gatesSurface(rule: Rule, surface: Surface): boolean {
  if (rule.check.type === 'completed') {
    return surface === 'trial';
  }
  return rule.gateOn === 'both' ? surface !== 'trial' : surface === rule.gateOn;
}

/**
 * The gated-cell test over a cell's evidence. Cells need it before their verdicts, because G
 * sets z_U. A low-baseline cell (a rule other than `completed` whose baseline rate is below
 * `report.lowBaseline`) has no held behaviour to protect; `completed` has its own premise
 * check (row 3).
 */
export function gatedCellTest(
  gated: readonly Rule[],
  lowBaseline: number,
): (evidence: CellEvidence) => boolean {
  const byId = new Map(gated.map((rule) => [rule.id, rule]));
  return (evidence) => {
    const rule = byId.get(evidence.ruleId);
    if (rule === undefined || isNotApplicable(evidence) || !gatesSurface(rule, evidence.surface)) {
      return false;
    }
    const rate = baselineRate(evidence);
    return rule.check.type === 'completed' || rate === null || rate >= lowBaseline;
  };
}

/**
 * Per variant and language, the share of `pass` among judged trials on the common cases:
 * every finished trial the outcome table's `completed` column grades, plus systematic
 * failures as fails. It needs no `completed` rule. Languages follow case order.
 */
export function completionRates(
  cases: readonly CommonCase[],
  finished: PerRole<readonly AttemptLine[]>,
  systematic: PerRole<readonly AttemptLine[]>,
): PerRole<LanguageCompletion[]> {
  const languages = [...new Set(cases.map((testCase) => testCase.lang))];
  const rates = (role: Role): LanguageCompletion[] => {
    const failed = new Set(systematic[role].map(trialKeyId));
    const counts = new Map(languages.map((key) => [key, { trials: 0, passes: 0 }]));
    const byCase = new Map(cases.map((testCase) => [testCase.id, counts.get(testCase.lang)]));
    for (const line of finished[role]) {
      const entry = byCase.get(line.caseId);
      const grade = failed.has(trialKeyId(line)) ? 'fail' : completedGrade(classifyTrial(line));
      if (entry !== undefined && grade !== 'skip') {
        entry.trials += 1;
        entry.passes += grade === 'pass' ? 1 : 0;
      }
    }
    return [...counts].map(([key, { trials, passes }]) => ({
      lang: key,
      trials,
      passes,
      rate: trials === 0 ? null : passes / trials,
    }));
  };
  return { baseline: rates('baseline'), candidate: rates('candidate') };
}

/** A run as the gate reads it. */
export interface GateRun {
  readonly variant: string;
  readonly status: RunStatus;
  readonly stopReason?: StopReason | undefined;
  /** The run's `adapter.timeoutMs` from the manifest `limits`. */
  readonly timeoutMs: number;
}

/** A failing judged trial of the candidate in one cell, systematic failures included. */
export interface FailingTrial {
  readonly caseId: string;
  readonly repeat: number;
  /** Evidence of the failing grade. */
  readonly evidence?: readonly string[] | undefined;
  /** The redacted error message when the trial ended in an error. */
  readonly message?: string | undefined;
}

/** What the gate and the summary read about one cell's trials beyond the Cell itself. */
export interface CellTrials extends CellKey {
  readonly candidateFailures: readonly FailingTrial[];
  /** `completed` cells: abandoned trials among the systematic failures. */
  readonly abandonedInSystematic?: PerRole<AbandonedCounts> | undefined;
}

export interface GateInput {
  readonly runs: PerRole<GateRun>;
  /** {@link completionRates} of the comparison. */
  readonly completion: PerRole<readonly LanguageCompletion[]>;
  /** The active rules applicable to the compared targets. */
  readonly rules: readonly Rule[];
  readonly targets: readonly string[];
  readonly gate: GateConfig;
  readonly cells: readonly Cell[];
  readonly cellTrials: readonly CellTrials[];
}

/** The first matching row of data-model §Gate decides. */
export function decideGate(input: GateInput): Gate {
  const { gated, excluded } = gateRules(input.rules, input.targets, input.gate);
  const gatedCells = input.cells.filter((cell) => cell.gated);
  const regressed = gatedCells.filter((cell) => cell.verdict === 'regressed');
  const regressedReasons = regressed.map((cell): GateReason => ({
    code: 'regressed',
    ...keyOf(cell),
  }));

  // A premise failure never blocks, but regressed cells stay visible in the reasons.
  const premise = premiseReasons(input);
  if (premise.length > 0) {
    return {
      outcome: 'undecided',
      reasons: [...premise, ...regressedReasons],
      blocking: [],
      undecided: [],
      excluded: [...excluded],
    };
  }
  if (input.gate.severities.length === 0) {
    return {
      outcome: 'no-gate',
      reasons: [{ code: 'no-gate' }],
      blocking: [],
      undecided: [],
      excluded: [],
    };
  }

  const undecidedCells = gatedCells.filter((cell) => isUndecided(cell.verdict));
  const notJudged = gated.filter(
    (rule) =>
      !input.cells.some(
        (cell) =>
          cell.ruleId === rule.id &&
          gatesSurface(rule, cell.surface) &&
          cell.verdict !== 'not-applicable',
      ),
  );
  const trials = new Map(input.cellTrials.map((entry) => [cellId(entry), entry]));
  const reasons: GateReason[] = [
    ...dominantError(regressed, trials),
    ...(gatedCells.length === 0 ? [{ code: 'no-gated-cells' } as const] : []),
    ...regressedReasons,
    ...undecidedCells.map((cell): GateReason => ({ code: 'cell-undecided', ...keyOf(cell) })),
    ...notJudged.map((rule): GateReason => ({ code: 'rule-not-judged', ruleId: rule.id })),
    ...abandonedInSystematic(gatedCells, trials, input.runs),
  ];
  return {
    outcome: outcomeOf(
      gatedCells.length,
      regressed.length,
      undecidedCells.length + notJudged.length,
    ),
    reasons,
    blocking: regressed.map(keyOf),
    undecided: [
      ...undecidedCells.map((cell) => ({
        ...keyOf(cell),
        ...(cell.needed === undefined ? {} : { needed: cell.needed }),
      })),
      ...notJudged.map((rule) => ({ ruleId: rule.id })),
    ],
    excluded: [...excluded],
  };
}

const EXIT_BY_OUTCOME: Readonly<Record<Gate['outcome'], ExitName>> = {
  pass: 'ok',
  'no-gate': 'ok',
  block: 'failed',
  undecided: 'undecided',
};

/** The exit name of a gate outcome (contracts/cli.md §Exit Codes). */
export function gateExit(outcome: Gate['outcome']): ExitName {
  return EXIT_BY_OUTCOME[outcome];
}

function outcomeOf(gatedCells: number, regressed: number, undecided: number): Gate['outcome'] {
  if (gatedCells === 0) {
    return 'undecided';
  }
  if (regressed > 0) {
    return 'block';
  }
  return undecided > 0 ? 'undecided' : 'pass';
}

/** Rows 1–3, the premise of the comparison; empty when it holds. */
function premiseReasons({ runs, completion }: GateInput): GateReason[] {
  const unfinished = ROLES.flatMap((role) => {
    const { variant, status, stopReason } = runs[role];
    return status === 'complete'
      ? []
      : [[variant, { status, stopReason: stopReason ?? null }] as const];
  });
  if (unfinished.length > 0) {
    return [{ code: 'partial-run', params: { runs: Object.fromEntries(unfinished) } }];
  }
  const unjudged = ROLES.filter((role) =>
    completion[role].every((language) => language.trials === 0),
  ).map((role) => runs[role].variant);
  if (unjudged.length > 0) {
    return [{ code: 'no-judged-trials', params: { variants: unjudged } }];
  }
  return completion.baseline.flatMap(({ lang, rate }): GateReason[] =>
    rate !== null && rate < BASELINE_COMPLETION_FLOOR
      ? [{ code: 'baseline-incomplete', lang, params: { rate } }]
      : [],
  );
}

/**
 * A new shape of billing or quota error classified as a rejection would otherwise look like a
 * worse model. Each candidate trial counts once, however many blocking cells it fails.
 */
function dominantError(
  blocking: readonly Cell[],
  trials: ReadonlyMap<string, CellTrials>,
): GateReason[] {
  const messages = new Map<string, string | undefined>();
  for (const cell of blocking) {
    for (const trial of trials.get(cellId(cell))?.candidateFailures ?? []) {
      messages.set(trialKeyId(trial), trial.message);
    }
  }
  const counts = new Map<string, number>();
  for (const message of messages.values()) {
    if (message !== undefined) {
      const head = Array.from(message).slice(0, DOMINANT_MESSAGE_LENGTH).join('');
      counts.set(head, (counts.get(head) ?? 0) + 1);
    }
  }
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  if (top === undefined) {
    return [];
  }
  const share = top[1] / messages.size;
  return share >= DOMINANT_SHARE
    ? [{ code: 'dominant-error', params: { message: top[0], share } }]
    : [];
}

function abandonedInSystematic(
  gatedCells: readonly Cell[],
  trials: ReadonlyMap<string, CellTrials>,
  runs: PerRole<GateRun>,
): GateReason[] {
  return gatedCells.flatMap((cell): GateReason[] => {
    const counts = trials.get(cellId(cell))?.abandonedInSystematic;
    if (counts === undefined) {
      return [];
    }
    const roles = ROLES.filter((role) => counts[role].timeout + counts[role].restart > 0);
    if (roles.length === 0) {
      return [];
    }
    return [
      {
        code: 'abandoned-in-systematic',
        ...keyOf(cell),
        params: {
          trials: Object.fromEntries(roles.map((role) => [runs[role].variant, counts[role]])),
          timeoutMs: Object.fromEntries(
            roles.map((role) => [runs[role].variant, runs[role].timeoutMs]),
          ),
        },
      },
    ];
  });
}

export function keyOf(cell: CellKey): CellKey {
  return { ruleId: cell.ruleId, lang: cell.lang, surface: cell.surface };
}

/** A map key for a cell. */
export function cellId(cell: CellKey): string {
  return `${cell.ruleId}\u0000${cell.lang}\u0000${cell.surface}`;
}
