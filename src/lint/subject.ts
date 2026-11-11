import path from 'node:path';

import type { Target } from '../adapter/protocol.js';
import type { PathSegment, Project, SourceFile } from '../config/load.js';
import type { Case, CasesFile, Rule, RulesFile } from '../config/schema.js';
import { NO_LANGUAGE } from '../grade/grade.js';
import type { RenderSpec } from '../run/render-cases.js';
import { requestLang } from '../run/run-cases.js';

// What every lint check reads: the rules and cases with where they were written, and the
// adapter's targets when the adapter was started.

/** Where a finding points, as `file`, `line` and `column` of a lint finding. */
export interface Place {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface LintRule {
  readonly rule: Rule;
  /** Position of a field of this rule, `[]` for the rule itself. */
  readonly at: (segments?: readonly PathSegment[]) => Place;
}

export interface LintCase {
  readonly definition: Case;
  /**
   * The language key a run records (`*` for a case sent without a language), or `null` when it
   * is unknown: a case without `lang` whose target is not known (no adapter targets, or an
   * undeclared target) or has several languages. Language checks leave such a case out.
   */
  readonly lang: string | null;
  /** The adapter target the case names; absent without targets or for an undeclared target. */
  readonly target?: Target | undefined;
  /** The render request a run would send; absent when a run could not send the case. */
  readonly render?: RenderSpec | undefined;
  /** Absolute path of the case file. */
  readonly sourcePath: string;
  /** Position of a field of this case, `[]` for the case itself. */
  readonly at: (segments?: readonly PathSegment[]) => Place;
}

export interface LintSubject {
  readonly project: Project;
  readonly rules: readonly LintRule[];
  readonly cases: readonly LintCase[];
  /** The targets the adapter declared; absent when it was not started or failed. */
  readonly targets?: readonly Target[] | undefined;
  /** Position of a config field. */
  readonly configAt: (segments: readonly PathSegment[]) => Place;
}

/** File paths in findings are relative to `cwd`, like the loader's `schema` findings. */
export function lintSubject(
  project: Project,
  cwd: string,
  targets?: readonly Target[],
): LintSubject {
  const placer =
    <T>(source: SourceFile<T>, prefix: readonly PathSegment[]) =>
    (segments: readonly PathSegment[] = []): Place => {
      const { line, column } = source.locate([...prefix, ...segments]);
      return { file: path.relative(cwd, source.path) || source.path, line, column };
    };
  return {
    project,
    rules: project.ruleFiles.flatMap((source: SourceFile<RulesFile>) =>
      source.data.rules.map((rule, index) => ({ rule, at: placer(source, ['rules', index]) })),
    ),
    cases: project.caseFiles.flatMap((source: SourceFile<CasesFile>) =>
      source.data.cases.map((definition, index): LintCase => {
        const target = targets?.find((item) => item.name === definition.target);
        const sent = target === undefined ? null : requestLang(definition, target);
        return {
          definition,
          lang: sent === null ? (definition.lang ?? null) : (sent ?? NO_LANGUAGE),
          target,
          render:
            target === undefined || sent === null
              ? undefined
              : {
                  id: definition.id,
                  target: target.name,
                  ...(sent === undefined ? {} : { requestLang: sent }),
                  definition,
                },
          sourcePath: source.path,
          at: placer(source, ['cases', index]),
        };
      }),
    ),
    targets,
    configAt: placer(project.config, []),
  };
}

/** A case whose language is known. */
export type KnownLanguageCase = LintCase & { readonly lang: string };

/** The cases checks that depend on the language can judge. */
export function knownLanguageCases(cases: readonly LintCase[]): KnownLanguageCase[] {
  return cases.filter((lintCase): lintCase is KnownLanguageCase => lintCase.lang !== null);
}

/** The first rule of each ID, as grading and reports see it. */
export function rulesById(subject: LintSubject): ReadonlyMap<string, LintRule> {
  const byId = new Map<string, LintRule>();
  for (const entry of subject.rules) {
    if (!byId.has(entry.rule.id)) {
      byId.set(entry.rule.id, entry);
    }
  }
  return byId;
}

/** The IDs a case's `rules` list names, with their position in that list. */
export function listedRuleIds(testCase: Case): { readonly id: string; readonly index: number }[] {
  return testCase.rules.map((entry, index) => ({
    id: typeof entry === 'string' ? entry : entry.id,
    index,
  }));
}
