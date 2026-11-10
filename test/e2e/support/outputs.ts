import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { z } from 'zod';

import { envelopeSchema, resultSchemas } from '../../../src/cli/results.js';
import { gradeSchema, gradeSetHeaderSchema, type Grade } from '../../../src/grade/record.js';
import type { Surface } from '../../../src/config/schema.js';
import { comparisonSchema, type Cell, type Comparison } from '../../../src/report/schema.js';
import {
  manifestSchema,
  swapRecordSchema,
  type Manifest,
  type SwapRecord,
} from '../../../src/run/manifest.js';
import {
  trialLineSchema,
  type AttemptLine,
  type CostLine,
  type SendLine,
  type TrialLine,
} from '../../../src/run/records.js';
import { ROOT } from './cli.js';

const SCHEMAS = path.join(ROOT, 'schemas');

const validators = new Map<string, ValidateFunction>();

function validator(schemaFile: string): ValidateFunction {
  const cached = validators.get(schemaFile);
  if (cached !== undefined) {
    return cached;
  }
  // The same options as test/contract/schemas.test.ts, which checks the committed schemas.
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    allErrors: true,
    validateFormats: false,
  });
  const schema: unknown = JSON.parse(readFileSync(path.join(SCHEMAS, schemaFile), 'utf8'));
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`${schemaFile} is not a JSON Schema`);
  }
  const compiled = ajv.compile(schema);
  validators.set(schemaFile, compiled);
  return compiled;
}

/** The problems a published JSON Schema finds in a value; empty when it is valid. */
export function schemaErrors(schemaFile: string, value: unknown): string[] {
  const validate = validator(schemaFile);
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`);
}

function checked<T>(schemaFile: string, zodSchema: z.ZodType<T>, value: unknown, what: string): T {
  const errors = schemaErrors(schemaFile, value);
  if (errors.length > 0) {
    throw new Error(`${what} violates ${schemaFile}: ${errors.join('; ')}`);
  }
  return zodSchema.parse(value);
}

// `envelopeSchema(command)` types `result` as the union of every command's result, so the
// envelopes read here pin it to their command's schema.
const swapEnvelopeSchema = envelopeSchema('swap').extend({
  result: resultSchemas.swap.nullable(),
});
const runEnvelopeSchema = envelopeSchema('run').extend({ result: resultSchemas.run.nullable() });

export type SwapEnvelope = z.infer<typeof swapEnvelopeSchema>;
export type RunEnvelope = z.infer<typeof runEnvelopeSchema>;

/** The `swap --json` document on stdout, checked against `schemas/swap.schema.json`. */
export function parseSwapEnvelope(stdout: string): SwapEnvelope {
  return checked('swap.schema.json', swapEnvelopeSchema, JSON.parse(stdout), 'swap --json');
}

/** The `run --json` document on stdout, checked against `schemas/run.schema.json`. */
export function parseRunEnvelope(stdout: string): RunEnvelope {
  return checked('run.schema.json', runEnvelopeSchema, JSON.parse(stdout), 'run --json');
}

type SwapResult = NonNullable<SwapEnvelope['result']>;
export type SwapRun = Exclude<SwapResult, { plan: unknown }>;
export type DryRunPlan = Extract<SwapResult, { plan: unknown }>['plan'];

/** The result of a swap that created runs; fails the test when there is none. */
export function swapRunOf(envelope: SwapEnvelope): SwapRun {
  const { result } = envelope;
  if (result === null || 'plan' in result) {
    throw new Error(`expected a swap result with runs, got ${JSON.stringify(result)}`);
  }
  return result;
}

export function dryRunPlanOf(envelope: SwapEnvelope | RunEnvelope): DryRunPlan {
  const { result } = envelope;
  if (result === null || !('plan' in result)) {
    throw new Error(`expected a dry-run plan, got ${JSON.stringify(result)}`);
  }
  return result.plan;
}

export function comparisonOf(envelope: SwapEnvelope): Comparison {
  const { comparison } = swapRunOf(envelope);
  if (comparison === undefined) {
    throw new Error('expected the swap to reach the comparison');
  }
  return comparison;
}

export function cellOf(
  comparison: Comparison,
  ruleId: string,
  lang: string,
  surface: Surface,
): Cell {
  const cell = comparison.cells.find(
    (candidate) =>
      candidate.ruleId === ruleId && candidate.lang === lang && candidate.surface === surface,
  );
  if (cell === undefined) {
    throw new Error(`the comparison has no cell ${ruleId} × ${lang} × ${surface}`);
  }
  return cell;
}

export function cellKeyOf(cell: Pick<Cell, 'ruleId' | 'lang' | 'surface'>): string {
  return `${cell.ruleId}/${cell.lang}/${cell.surface}`;
}

/** Names in a folder of the output directory, without leftovers of killed writes. */
export async function entries(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  return (await readdir(dir)).filter((name) => !name.startsWith('.tmp-')).sort();
}

export interface RunFiles {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly lines: readonly TrialLine[];
  /** Raw text of `trials.jsonl`, for checks on what was written. */
  readonly trialsText: string;
}

export async function readRun(outputDir: string, runId: string): Promise<RunFiles> {
  const dir = path.join(outputDir, 'runs', runId);
  const manifest = checked(
    'manifest.schema.json',
    manifestSchema,
    JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
    `${runId}/manifest.json`,
  );
  const trialsText = await readFile(path.join(dir, 'trials.jsonl'), 'utf8');
  const lines = trialsText
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) =>
      checked(
        'trial.schema.json',
        trialLineSchema,
        JSON.parse(line),
        `${runId}/trials.jsonl line ${String(index + 1)}`,
      ),
    );
  return { dir, manifest, lines, trialsText };
}

export async function readSwapRecord(outputDir: string, swapId: string): Promise<SwapRecord> {
  return checked(
    'swap-record.schema.json',
    swapRecordSchema,
    JSON.parse(await readFile(path.join(outputDir, 'swaps', `${swapId}.json`), 'utf8')),
    `swaps/${swapId}.json`,
  );
}

export interface ComparisonFiles {
  readonly dir: string;
  readonly comparison: Comparison;
  readonly reportMarkdown: string;
}

export async function readComparison(
  outputDir: string,
  comparisonId: string,
): Promise<ComparisonFiles> {
  const dir = path.join(outputDir, 'comparisons', comparisonId);
  const comparison = checked(
    'comparison.schema.json',
    comparisonSchema,
    JSON.parse(await readFile(path.join(dir, 'comparison.json'), 'utf8')),
    `comparisons/${comparisonId}/comparison.json`,
  );
  const reportMarkdown = await readFile(path.join(dir, 'report.md'), 'utf8');
  return { dir, comparison, reportMarkdown };
}

export interface GradeSetFile {
  readonly header: z.infer<typeof gradeSetHeaderSchema>;
  readonly grades: readonly Grade[];
}

/** `grades/<gradeSetId>.jsonl`: the grade set on its first line and its grades after it. */
export async function readGradeSet(runDir: string, gradeSetId: string): Promise<GradeSetFile> {
  const text = await readFile(path.join(runDir, 'grades', `${gradeSetId}.jsonl`), 'utf8');
  const [first, ...rest] = text.split('\n').filter((line) => line !== '');
  if (first === undefined) {
    throw new Error(`grades/${gradeSetId}.jsonl is empty`);
  }
  return {
    header: gradeSetHeaderSchema.parse(JSON.parse(first)),
    grades: rest.map((line) => gradeSchema.parse(JSON.parse(line))),
  };
}

export function sendLines(lines: readonly TrialLine[]): SendLine[] {
  return lines.filter((line): line is SendLine => 'sending' in line);
}

export function attemptLines(lines: readonly TrialLine[]): AttemptLine[] {
  return lines.filter((line): line is AttemptLine => 'status' in line);
}

export function costLines(lines: readonly TrialLine[]): CostLine[] {
  return lines.filter((line): line is CostLine => 'costCorrection' in line);
}

export function trialKey(caseId: string, repeat: number): string {
  return `${caseId}#${String(repeat)}`;
}

/** The last attempt line of each key, which decides the trial (data-model §Trial). */
export function effectiveLines(lines: readonly TrialLine[]): Map<string, AttemptLine> {
  const effective = new Map<string, AttemptLine>();
  for (const line of attemptLines(lines)) {
    effective.set(trialKey(line.caseId, line.repeat), line);
  }
  return effective;
}

/** Every regular file under a folder, recursively, as absolute paths. */
export async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      found.push(path.join(entry.parentPath, entry.name));
    }
  }
  return found.sort();
}

/** A value inside parsed JSON, for checks on what was written before any schema stripped it. */
export function jsonAt(value: unknown, keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (Array.isArray(current) && typeof key === 'number') {
      current = current[key];
    } else if (isRecord(current) && typeof key === 'string') {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
