import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

import { compareCodeUnits, hashValue, shortHex } from '../adapter/canonical-json.js';
import type { JsonValue } from '../adapter/json-value.js';
import type { Sha256 } from '../config/identifiers.js';
import type { Rule } from '../config/schema.js';
import type { Redactor } from '../report/redact.js';
import { asJsonValue } from '../run/hashes.js';
import type { TrialLine } from '../run/records.js';
import { writeFileAtomic } from '../run/writer.js';
import { gradeRun, type RunCase } from './grade.js';
import { effectiveAttempts } from './outcome.js';
import { gradeSchema, gradeSetHeaderSchema, type Grade, type GradeSetHeader } from './record.js';

/** The five values that identify a grade set (data-model §Grade and GradeSet). */
export interface GradeSetIdentity {
  readonly runId: string;
  readonly rulesHash: Sha256;
  /** The tool version, so any tool change re-grades. */
  readonly checkerVersion: string;
  readonly trialsFingerprint: Sha256;
  readonly casesHash: Sha256;
}

export interface GradeSet {
  readonly header: GradeSetHeader;
  readonly grades: readonly Grade[];
}

export interface GradeSetInput extends Omit<GradeSetIdentity, 'casesHash' | 'trialsFingerprint'> {
  /** The run directory; grade sets live in its `grades/` folder. */
  readonly runDir: string;
  /** Every rule of the current rule files; `rulesHash` must be theirs. */
  readonly rules: readonly Rule[];
  /** Every case of the run's manifest with its current definition; gives `casesHash`. */
  readonly cases: readonly RunCase[];
  /** The complete lines of `trials.jsonl` in file order; give `trialsFingerprint`. */
  readonly lines: readonly TrialLine[];
  /** The config `redact` rules, applied to the evidence a new grade set writes (FR-031). */
  readonly redactor: Redactor;
}

export class GradeSetReadError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    detail: string,
  ) {
    super(`${file}:${String(line)}: ${detail}`);
    this.name = 'GradeSetReadError';
  }
}

export function gradeSetIdOf(identity: GradeSetIdentity): string {
  const { runId, rulesHash, checkerVersion, trialsFingerprint, casesHash } = identity;
  const hash = hashValue({ runId, rulesHash, checkerVersion, trialsFingerprint, casesHash });
  return `gs-${shortHex(hash)}`;
}

/** Every complete line of `trials.jsonl` in file order, send and cost lines included. */
export function trialsFingerprintOf(lines: readonly JsonValue[]): Sha256 {
  return hashValue(lines);
}

/** `{id, current case hash or null}` per case of the run, sorted by `id`. */
export function casesHashOf(cases: readonly RunCase[]): Sha256 {
  return hashValue(
    [...cases]
      .sort((a, b) => compareCodeUnits(a.id, b.id))
      .map((runCase) => ({ id: runCase.id, hash: runCase.current?.hash ?? null })),
  );
}

export function gradeSetPath(runDir: string, gradeSetId: string): string {
  return path.join(runDir, 'grades', `${gradeSetId}.jsonl`);
}

/**
 * Returns the grade set of these inputs, reusing `grades/<gradeSetId>.jsonl` when it exists and
 * otherwise grading the effective attempt lines and writing the file atomically (plan D6). The
 * returned grades are the ones written, evidence redacted, so a reused set reads the same.
 */
export async function ensureGradeSet(
  input: GradeSetInput,
): Promise<{ gradeSet: GradeSet; reused: boolean }> {
  const identity: GradeSetIdentity = {
    runId: input.runId,
    rulesHash: input.rulesHash,
    checkerVersion: input.checkerVersion,
    trialsFingerprint: trialsFingerprintOf(input.lines.map(asJsonValue)),
    casesHash: casesHashOf(input.cases),
  };
  const gradeSetId = gradeSetIdOf(identity);
  const existing = await readGradeSet(input.runDir, gradeSetId);
  if (existing !== undefined) {
    return { gradeSet: existing, reused: true };
  }
  const gradeSet: GradeSet = {
    header: { gradeSetId, ...identity },
    grades: gradeRun({
      rules: input.rules,
      cases: input.cases,
      trials: effectiveAttempts(input.lines),
    }).map((grade) => redactGrade(grade, input.redactor)),
  };
  const file = gradeSetPath(input.runDir, gradeSetId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(
    file,
    [gradeSet.header, ...gradeSet.grades].map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
  return { gradeSet, reused: false };
}

function redactGrade(grade: Grade, redactor: Redactor): Grade {
  return grade.evidence === undefined
    ? grade
    : { ...grade, evidence: grade.evidence.map((text) => redactor.text(text)) };
}

/** The stored grade set, or `undefined` when it was never written. */
export async function readGradeSet(
  runDir: string,
  gradeSetId: string,
): Promise<GradeSet | undefined> {
  const file = gradeSetPath(runDir, gradeSetId);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  const [first = '', ...rest] = text.split('\n');
  const header = parseLine(file, 1, first, gradeSetHeaderSchema);
  const grades = rest
    .map((line, index) => ({ line, number: index + 2 }))
    .filter(({ line }) => line !== '')
    .map(({ line, number }) => parseLine(file, number, line, gradeSchema));
  return { header, grades };
}

function parseLine<T>(file: string, number: number, line: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new GradeSetReadError(file, number, 'not JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new GradeSetReadError(file, number, 'not a grade set line');
  }
  return parsed.data;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
