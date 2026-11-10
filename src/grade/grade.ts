import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { JsonObject } from '../adapter/json-value.js';
import { runCheck } from '../checks/registry.js';
import type { Sha256 } from '../config/identifiers.js';
import type { CaseValues } from '../config/paths.js';
import type { Case, GradingCheck, Rule, Surface } from '../config/schema.js';
import type { AttemptLine } from '../run/records.js';
import { classifyTrial, completedGrade, finalSurfaceText, rawSurfaceText } from './outcome.js';
import type { Grade } from './record.js';

/** The language key of cases without a language (data-model §Target). */
export const NO_LANGUAGE = '*';

/** A case of the run as its manifest records it, with its current definition. */
export interface RunCase {
  readonly id: string;
  /** Target from the manifest; it picks the `global` rules a deleted case gets `skip` for. */
  readonly target: string;
  /** Language key from the manifest, {@link NO_LANGUAGE} for a case without a language. */
  readonly lang: string;
  /** Case hash in the manifest. */
  readonly hash: Sha256;
  /** The case in the current case files and its hash; absent when the case was deleted. */
  readonly current?: { readonly definition: Case; readonly hash: Sha256 } | undefined;
}

export interface ApplicableRule {
  readonly rule: Rule;
  /** Values for `params.…` paths, from the case's `rules` list. */
  readonly params?: JsonObject | undefined;
}

export interface GradeRunInput {
  readonly rules: readonly Rule[];
  readonly cases: readonly RunCase[];
  /** The effective attempt line of each trial key. */
  readonly trials: readonly AttemptLine[];
}

type GradeKey = Pick<Grade, 'caseId' | 'repeat' | 'ruleId'>;

/**
 * Active `global` rules whose targets and languages match, plus the case's listed rules that
 * match. Rules with `languages` never apply to a case without a language.
 */
export function applicableRules(
  rules: readonly Rule[],
  testCase: Case,
  lang: string,
): ApplicableRule[] {
  const listed = new Map<string, JsonObject | undefined>();
  for (const entry of testCase.rules) {
    const [id, params] = typeof entry === 'string' ? [entry, undefined] : [entry.id, entry.params];
    if (!listed.has(id)) {
      listed.set(id, params);
    }
  }
  return rules
    .filter(
      (rule) =>
        (rule.scope === 'global' || listed.has(rule.id)) && matches(rule, testCase.target, lang),
    )
    .map((rule) => ({ rule, params: listed.get(rule.id) }));
}

/**
 * Grades every applicable rule on every trial of one run: text rules on the raw and final
 * surfaces, `completed` on the trial surface, `review` not at all. Trials of a case whose hash
 * changed get `skip` for every rule that applies to the case as defined now, and trials of a
 * deleted case for every `global` rule matching its target and language. Sorted by case,
 * repeat, rule and surface.
 */
export function gradeRun(input: GradeRunInput): Grade[] {
  const cases = new Map(input.cases.map((runCase) => [runCase.id, runCase]));
  return input.trials
    .flatMap((line) => {
      const runCase = cases.get(line.caseId);
      return runCase === undefined ? [] : gradeTrial(line, runCase, input.rules);
    })
    .sort(compareGrades);
}

function gradeTrial(line: AttemptLine, runCase: RunCase, rules: readonly Rule[]): Grade[] {
  const { current } = runCase;
  const keyOf = (rule: Rule): GradeKey => ({
    caseId: line.caseId,
    repeat: line.repeat,
    ruleId: rule.id,
  });
  if (current?.hash !== runCase.hash) {
    const skipped =
      current === undefined
        ? rules.filter(
            (rule) => rule.scope === 'global' && matches(rule, runCase.target, runCase.lang),
          )
        : applicableRules(rules, current.definition, runCase.lang).map(({ rule }) => rule);
    return skipped.flatMap((rule) =>
      surfacesOf(rule).map((surface): Grade => ({ ...keyOf(rule), surface, outcome: 'skip' })),
    );
  }
  return applicableRules(rules, current.definition, runCase.lang).flatMap(
    ({ rule, params }): Grade[] => {
      const key = keyOf(rule);
      const { check } = rule;
      switch (check.type) {
        case 'review':
          return [];
        case 'completed':
          return [{ ...key, surface: 'trial', outcome: completedGrade(classifyTrial(line)) }];
        default: {
          const values: CaseValues = { input: current.definition.input, params };
          return [
            gradeText(key, 'raw', check, rawSurfaceText(line), values),
            gradeText(key, 'final', check, finalSurfaceText(line), values),
          ];
        }
      }
    },
  );
}

/** An active rule whose targets and languages cover the case. */
function matches(rule: Rule, target: string, lang: string): boolean {
  return (
    rule.status === 'active' &&
    (rule.targets.length === 0 || rule.targets.includes(target)) &&
    (rule.languages.length === 0 || (lang !== NO_LANGUAGE && rule.languages.includes(lang)))
  );
}

function surfacesOf(rule: Rule): readonly Surface[] {
  switch (rule.check.type) {
    case 'review':
      return [];
    case 'completed':
      return ['trial'];
    default:
      return ['raw', 'final'];
  }
}

/** `text` is undefined when the surface is excluded for this trial. */
function gradeText(
  key: GradeKey,
  surface: 'raw' | 'final',
  check: GradingCheck,
  text: string | undefined,
  values: CaseValues,
): Grade {
  if (text === undefined) {
    return { ...key, surface, outcome: 'skip' };
  }
  const result = runCheck(check, text, values);
  switch (result.outcome) {
    case 'pass':
      return { ...key, surface, outcome: 'pass' };
    case 'fail':
      return result.evidence.length === 0
        ? { ...key, surface, outcome: 'fail' }
        : { ...key, surface, outcome: 'fail', evidence: [...result.evidence] };
    case 'error':
      return { ...key, surface, outcome: 'error' };
  }
}

function compareGrades(a: Grade, b: Grade): number {
  return (
    compareCodeUnits(a.caseId, b.caseId) ||
    a.repeat - b.repeat ||
    compareCodeUnits(a.ruleId, b.ruleId) ||
    compareCodeUnits(a.surface, b.surface)
  );
}
