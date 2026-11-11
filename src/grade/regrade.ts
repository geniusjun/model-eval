import { SHA256_PATTERN, type Sha256 } from '../config/identifiers.js';
import type { Case, Rule } from '../config/schema.js';
import { caseHash, rulesHash } from '../run/hashes.js';
import type { Manifest } from '../run/manifest.js';
import type { RunRecords } from '../run/run-records.js';
import type { CurrentCase, RunCase } from './grade.js';
import { ensureGradeSet, type GradeSet } from './grade-set.js';

// Grading saved runs with the current rules and case files, without calling a model (FR-019).

const isSha256 = (value: string): value is Sha256 => SHA256_PATTERN.test(value);

/**
 * The cases the run recorded that the case files still hold, with their current hash and
 * language key. A case without `lang` keeps the key the run recorded (the target's only language,
 * or `*`), since these commands do not start the adapter to read its targets again.
 */
export function currentCases(
  definitions: readonly Case[],
  manifest: Manifest,
): Map<string, CurrentCase> {
  const recorded = new Map(manifest.cases.map((runCase) => [runCase.id, runCase.lang]));
  const current = new Map<string, CurrentCase>();
  for (const definition of definitions) {
    const recordedLang = recorded.get(definition.id);
    if (recordedLang !== undefined && !current.has(definition.id)) {
      const lang = definition.lang ?? recordedLang;
      const hash = caseHash(definition.target, lang, definition.input);
      current.set(definition.id, { definition, hash, lang });
    }
  }
  return current;
}

/** Manifest case hashes are validated as Sha256 on read, so a mismatch is a broken invariant. */
export function runCasesOf(
  manifest: Manifest,
  current: ReadonlyMap<string, CurrentCase>,
): RunCase[] {
  return manifest.cases.map(({ hash, ...runCase }) => {
    if (!isSha256(hash)) {
      throw new RangeError(`manifest case ${runCase.id} has no case hash`);
    }
    return { ...runCase, hash, current: current.get(runCase.id) };
  });
}

export interface RegradeInput {
  readonly run: RunRecords;
  /** Every rule of the current rule files. */
  readonly rules: readonly Rule[];
  /** The run's cases in the current case files ({@link currentCases} of this run). */
  readonly current: ReadonlyMap<string, CurrentCase>;
  /** The tool version. */
  readonly checkerVersion: string;
}

/**
 * The grade set of a saved run under the current rules: the stored one when its five inputs are
 * unchanged, else a new one graded from the records.
 */
export function regradeRun(input: RegradeInput): Promise<{ gradeSet: GradeSet; reused: boolean }> {
  const { run, rules, current } = input;
  const cases = runCasesOf(run.manifest, current);
  return ensureGradeSet({
    runDir: run.runDir,
    runId: run.manifest.runId,
    rulesHash: rulesHash(
      rules,
      cases.flatMap((runCase) =>
        runCase.current === undefined ? [] : [runCase.current.definition],
      ),
    ),
    checkerVersion: input.checkerVersion,
    rules,
    cases,
    lines: run.lines,
  });
}
