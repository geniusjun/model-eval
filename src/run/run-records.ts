import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { manifestSchema, swapRecordSchema, type Manifest, type SwapRecord } from './manifest.js';
import type { TrialLine } from './records.js';
import { readTrialLog, type TrialLogContents } from './trial-log.js';
import { RUN_FILES, swapRecordPath } from './writer.js';

// Saved runs and swap records as they are on disk, for `grade`, `compare` and resume: nothing
// here repairs or writes.

export interface RunRecords {
  readonly runDir: string;
  readonly manifest: Manifest;
  /** Every complete line of `trials.jsonl`, in file order; a cut last line is left out. */
  readonly lines: readonly TrialLine[];
  /** Where the complete lines end, so a resume can truncate a cut last line. */
  readonly log: TrialLogContents;
}

export type RunReadProblem =
  | { readonly kind: 'missing' }
  | { readonly kind: 'manifest'; readonly file: string; readonly detail: string }
  | {
      readonly kind: 'trials';
      readonly file: string;
      /** The broken line, counted from 1. */
      readonly line: number;
      readonly detail: string;
    };

export type RunRecordsResult =
  | { readonly ok: true; readonly run: RunRecords }
  | { readonly ok: false; readonly problem: RunReadProblem };

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseManifest(text: string): Manifest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? parsed.data : 'not a manifest';
}

/**
 * The manifest and the complete trial lines of a run directory. A directory without a manifest
 * is no run; a broken line before the last one is reported with its number.
 */
export async function readRunRecords(runDir: string): Promise<RunRecordsResult> {
  const manifestFile = path.join(runDir, RUN_FILES.manifest);
  const manifestText = await readText(manifestFile);
  if (manifestText === undefined) {
    return { ok: false, problem: { kind: 'missing' } };
  }
  const manifest = parseManifest(manifestText);
  if (typeof manifest === 'string') {
    return { ok: false, problem: { kind: 'manifest', file: manifestFile, detail: manifest } };
  }
  const trialsFile = path.join(runDir, RUN_FILES.trials);
  const trials = await readTrialLog(trialsFile);
  if (!trials.ok) {
    return {
      ok: false,
      problem: { kind: 'trials', file: trialsFile, line: trials.line, detail: trials.detail },
    };
  }
  return { ok: true, run: { runDir, manifest, lines: trials.log.lines, log: trials.log } };
}

export type SwapRecordResult =
  | { readonly ok: true; readonly record: SwapRecord }
  | { readonly ok: false; readonly problem: RunReadProblem };

/** `swaps/<swapId>.json`; a missing file is no swap. */
export async function readSwapRecord(outputDir: string, swapId: string): Promise<SwapRecordResult> {
  const file = swapRecordPath(outputDir, swapId);
  const text = await readText(file);
  if (text === undefined) {
    return { ok: false, problem: { kind: 'missing' } };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: { kind: 'manifest', file, detail: 'not JSON' } };
  }
  const parsed = swapRecordSchema.safeParse(value);
  return parsed.success
    ? { ok: true, record: parsed.data }
    : { ok: false, problem: { kind: 'manifest', file, detail: 'not a swap record' } };
}
