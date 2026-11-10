import { matchesGlob, relative } from 'node:path';

import type { Target } from '../adapter/protocol.js';
import type { Project } from '../config/load.js';
import type { Sha256 } from '../config/identifiers.js';
import type { Case } from '../config/schema.js';
import { NO_LANGUAGE } from '../grade/grade.js';
import { caseHash } from './hashes.js';
import type { OrderedCase } from './order.js';

// The cases one run sends, with what the send order, the requests and the manifest need.

export interface RunCaseSpec extends OrderedCase {
  readonly definition: Case;
  readonly target: string;
  /** The language sent to the adapter; absent for a case without a language. */
  readonly requestLang?: string;
  readonly hash: Sha256;
}

/** Cases the run cannot send; each is a configuration error before any model call. */
export interface CaseProblem {
  readonly caseId: string;
  readonly cause: 'unknown-target' | 'missing-lang';
  readonly target: string;
}

export type RunCasesResult =
  | { readonly ok: true; readonly cases: readonly RunCaseSpec[] }
  | { readonly ok: false; readonly problems: readonly CaseProblem[] };

/** The case's language, else the target's only language; two or more need `lang`. */
function requestLang(testCase: Case, target: Target): string | undefined | null {
  if (testCase.lang !== undefined) {
    return testCase.lang;
  }
  const languages = target.languages ?? [];
  if (languages.length >= 2) {
    return null;
  }
  return languages[0];
}

/**
 * Every case of the case files, or those whose ID matches `filter` (`--cases`), checked against
 * the targets the adapter declared.
 */
export function runCases(
  project: Project,
  targets: readonly Target[],
  filter: string | null,
): RunCasesResult {
  const cases: RunCaseSpec[] = [];
  const problems: CaseProblem[] = [];
  for (const file of project.caseFiles) {
    const shown = relative(project.paths.configDir, file.path);
    file.data.cases.forEach((definition, position) => {
      if (filter !== null && !matchesGlob(definition.id, filter)) {
        return;
      }
      const target = targets.find((item) => item.name === definition.target);
      if (target === undefined) {
        problems.push({
          caseId: definition.id,
          cause: 'unknown-target',
          target: definition.target,
        });
        return;
      }
      const lang = requestLang(definition, target);
      if (lang === null) {
        problems.push({ caseId: definition.id, cause: 'missing-lang', target: target.name });
        return;
      }
      const key = lang ?? NO_LANGUAGE;
      cases.push({
        id: definition.id,
        lang: key,
        file: shown,
        position,
        definition,
        target: target.name,
        ...(lang === undefined ? {} : { requestLang: lang }),
        hash: caseHash(target.name, key, definition.input),
      });
    });
  }
  return problems.length === 0 ? { ok: true, cases } : { ok: false, problems };
}

/** The target languages in declaration order, for the first batch's language rotation. */
export function targetLanguages(targets: readonly Target[]): string[] {
  return [...new Set(targets.flatMap((target) => target.languages ?? []))];
}
