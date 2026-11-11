import type { LintFinding } from '../config/diagnostics.js';
import { textListAt, type CaseValues } from '../config/paths.js';
import type { Check, Rule } from '../config/schema.js';
import { applicableRules, matches, NO_LANGUAGE, type ApplicableRule } from '../grade/grade.js';
import {
  knownLanguageCases,
  listedRuleIds,
  rulesById,
  type LintCase,
  type LintRule,
  type LintSubject,
} from './subject.js';

// FR-001, FR-002 and FR-004: IDs, the rules cases name, the case values checks read, and
// rules or languages without cases (data-model §Validation Rules). One function per code.

/** Later occurrences of an ID already seen, in order. */
function repeated<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = idOf(item);
    const again = seen.has(id);
    seen.add(id);
    return again;
  });
}

export function duplicateIds(subject: LintSubject): LintFinding[] {
  const variants = subject.project.config.data.variants.map((variant, index) => ({
    id: variant.id,
    index,
  }));
  return [
    ...repeated(variants, (variant) => variant.id).map(({ id, index }): LintFinding => ({
      code: 'duplicate-id',
      params: { kind: 'variant', id },
      ...subject.configAt(['variants', index, 'id']),
    })),
    ...repeated(subject.rules, ({ rule }) => rule.id).map(({ rule, at }): LintFinding => ({
      code: 'duplicate-id',
      params: { kind: 'rule', id: rule.id },
      ...at(['id']),
    })),
    ...repeated(subject.cases, ({ definition }) => definition.id).map(
      ({ definition, at }): LintFinding => ({
        code: 'duplicate-id',
        params: { kind: 'case', id: definition.id },
        ...at(['id']),
      }),
    ),
  ];
}

export function unknownRules(subject: LintSubject): LintFinding[] {
  const known = rulesById(subject);
  return subject.cases.flatMap(({ definition, at }) =>
    listedRuleIds(definition)
      .filter(({ id }) => !known.has(id))
      .map(({ id, index }): LintFinding => ({
        code: 'unknown-rule',
        ruleId: id,
        caseIds: [definition.id],
        ...at(['rules', index]),
      })),
  );
}

/** Needs the adapter's targets, which say how many languages each target has. */
export function missingLangs(subject: LintSubject): LintFinding[] {
  return subject.cases
    .filter(
      ({ definition, target }) =>
        definition.lang === undefined && (target?.languages ?? []).length >= 2,
    )
    .map(({ definition, at }) => ({
      code: 'missing-lang',
      params: { target: definition.target },
      caseIds: [definition.id],
      ...at(),
    }));
}

/** Needs the adapter's targets; `run` refuses these cases too. */
export function unknownTargets(subject: LintSubject): LintFinding[] {
  if (subject.targets === undefined) {
    return [];
  }
  return subject.cases
    .filter(({ target }) => target === undefined)
    .map(({ definition, at }) => ({
      code: 'unknown-target',
      params: { target: definition.target },
      caseIds: [definition.id],
      ...at(['target']),
    }));
}

/** A `…From` path; `required` for `anyFrom`, whose missing value leaves nothing to check. */
interface CaseRef {
  readonly path: string;
  readonly required: boolean;
}

/** The `…From` references of a check and its children. */
function caseRefs(check: Check): CaseRef[] {
  switch (check.type) {
    case 'script':
      return check.ignoreFrom === undefined ? [] : [{ path: check.ignoreFrom, required: false }];
    case 'phrases':
      return check.anyFrom === undefined ? [] : [{ path: check.anyFrom, required: true }];
    case 'overlap':
      return check.withFrom === undefined ? [] : [{ path: check.withFrom, required: false }];
    case 'all':
    case 'any':
      return check.checks.flatMap(caseRefs);
    case 'not':
      return caseRefs(check.check);
    default:
      return [];
  }
}

/** Each path once, required when any reference to it is. */
function uniqueRefs(refs: readonly CaseRef[]): CaseRef[] {
  const required = new Map<string, boolean>();
  for (const ref of refs) {
    required.set(ref.path, (required.get(ref.path) ?? false) || ref.required);
  }
  return [...required].map(([path, isRequired]) => ({ path, required: isRequired }));
}

/**
 * A value grading cannot read (`not-text`, the same lookup grading uses), or a missing
 * required value or one whose strings are all empty, which leaves a forbid list empty.
 */
function unresolved({ path, required }: CaseRef, values: CaseValues): boolean {
  const list = textListAt(path, values);
  switch (list.kind) {
    case 'not-text':
      return true;
    case 'missing':
      return required;
    case 'list':
      return required && list.values.every((value) => value === '');
  }
}

/**
 * The rules that apply to a case. For a case whose language is unknown, only rules that are not
 * limited by language, since the others may or may not apply.
 */
function rulesFor(rules: readonly Rule[], { definition, lang }: LintCase): ApplicableRule[] {
  return lang === null
    ? applicableRules(
        rules.filter((rule) => rule.languages.length === 0),
        definition,
        NO_LANGUAGE,
      )
    : applicableRules(rules, definition, lang);
}

/** `…From` values the rule cannot use in the cases it applies to (data-model §Check). */
export function unresolvedRefs(subject: LintSubject): LintFinding[] {
  const rules = subject.rules.map(({ rule }) => rule);
  return subject.cases.flatMap((lintCase) =>
    rulesFor(rules, lintCase).flatMap(({ rule, params }) =>
      uniqueRefs(caseRefs(rule.check))
        .filter((ref) => unresolved(ref, { input: lintCase.definition.input, params }))
        .map(({ path }): LintFinding => ({
          code: 'unresolved-ref',
          ruleId: rule.id,
          params: { path },
          caseIds: [lintCase.definition.id],
          ...lintCase.at(),
        })),
    ),
  );
}

/** Active listed rules whose targets or languages do not cover the case; they are not graded. */
export function ruleFilterMismatches(subject: LintSubject): LintFinding[] {
  const known = rulesById(subject);
  return knownLanguageCases(subject.cases).flatMap(({ definition, lang, at }) =>
    listedRuleIds(definition).flatMap(({ id, index }): LintFinding[] => {
      const rule = known.get(id)?.rule;
      if (rule?.status !== 'active' || matches(rule, definition.target, lang)) {
        return [];
      }
      return [
        {
          code: 'rule-filter-mismatch',
          ruleId: id,
          caseIds: [definition.id],
          ...at(['rules', index]),
        },
      ];
    }),
  );
}

function isActiveListed({ rule }: LintRule): boolean {
  return rule.status === 'active' && rule.scope === 'listed';
}

function namedRuleIds(cases: readonly LintCase[]): ReadonlySet<string> {
  return new Set(cases.flatMap(({ definition }) => listedRuleIds(definition).map(({ id }) => id)));
}

export function rulesWithoutCases(subject: LintSubject): LintFinding[] {
  const named = namedRuleIds(subject.cases);
  return subject.rules
    .filter((entry) => isActiveListed(entry) && !named.has(entry.rule.id))
    .map(({ rule, at }) => ({ code: 'rule-without-case', ruleId: rule.id, ...at() }));
}

/**
 * A language of an active rule that no case of that language covers. A listed rule that no case
 * names is `rule-without-case` alone, so each gap is reported once. A case of unknown language
 * that the rule would otherwise apply to leaves every language of the rule undecided.
 */
export function languageGaps(subject: LintSubject): LintFinding[] {
  const named = namedRuleIds(subject.cases);
  return subject.rules
    .filter(
      (entry) =>
        entry.rule.status === 'active' && !(isActiveListed(entry) && !named.has(entry.rule.id)),
    )
    .flatMap(({ rule, at }) =>
      [...new Set(rule.languages)]
        .filter(
          (language) =>
            !subject.cases.some(({ definition, lang }) =>
              // A case of unknown language may be in this language, so no gap can be claimed.
              lang === null
                ? applicableRules([{ ...rule, languages: [] }], definition, NO_LANGUAGE).length > 0
                : lang === language && applicableRules([rule], definition, lang).length > 0,
            ),
        )
        .map((language): LintFinding => ({
          code: 'language-gap',
          ruleId: rule.id,
          lang: language,
          ...at(),
        })),
    );
}
