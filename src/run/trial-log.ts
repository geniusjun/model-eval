import { readFile, truncate } from 'node:fs/promises';

import { trialLineSchema, type TrialLine } from './records.js';

// Reading trials.jsonl back (data-model §Trial, Cut last line).

export interface TrialLogContents {
  /** The complete lines in file order. */
  readonly lines: readonly TrialLine[];
  /** Bytes up to and including the last `\n`; a resume truncates the file to this length. */
  readonly completeBytes: number;
  /** Bytes after the last `\n`: a cut line, even when they form valid JSON. */
  readonly cutBytes: number;
}

export type TrialLogRead =
  | { readonly ok: true; readonly log: TrialLogContents }
  /** A complete line that is not a trial line; `line` counts from 1. */
  | { readonly ok: false; readonly line: number; readonly detail: string };

const NEWLINE = 0x0a;

function parseLine(text: string): { ok: true; line: TrialLine } | { ok: false; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const parsed = trialLineSchema.safeParse(value);
  return parsed.success
    ? { ok: true, line: parsed.data }
    : { ok: false, detail: parsed.error.issues.map((issue) => issue.message).join('; ') };
}

/**
 * Reads every complete line. Bytes after the last `\n` are reported, not read, so read-only
 * commands can ignore them and a resume can truncate them before appending.
 */
export function parseTrialLog(bytes: Buffer): TrialLogRead {
  const completeBytes = bytes.lastIndexOf(NEWLINE) + 1;
  const text = bytes.subarray(0, completeBytes).toString('utf8');
  const lines: TrialLine[] = [];
  const rows = text === '' ? [] : text.slice(0, -1).split('\n');
  for (const [index, row] of rows.entries()) {
    const parsed = parseLine(row);
    if (!parsed.ok) {
      return { ok: false, line: index + 1, detail: parsed.detail };
    }
    lines.push(parsed.line);
  }
  return { ok: true, log: { lines, completeBytes, cutBytes: bytes.length - completeBytes } };
}

/** A missing file reads as an empty log: a run killed before its first send wrote none. */
export async function readTrialLog(file: string): Promise<TrialLogRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { ok: true, log: { lines: [], completeBytes: 0, cutBytes: 0 } };
    }
    throw error;
  }
  return parseTrialLog(bytes);
}

/** Removes a cut last line, so the next append starts a line of its own. */
export async function truncateCutLine(file: string, log: TrialLogContents): Promise<void> {
  if (log.cutBytes > 0) {
    await truncate(file, log.completeBytes);
  }
}
