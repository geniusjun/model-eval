import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Manifest, SwapRecord } from './manifest.js';
import type { TrialLine } from './records.js';
import type { Warning, WarningCode } from './warning.js';

// The run directory (data-model §Run) and the atomic writes of plan D6.

export const RUN_FILES = {
  manifest: 'manifest.json',
  trials: 'trials.jsonl',
  grades: 'grades',
  adapterLog: 'adapter.log',
  lock: 'run.lock',
} as const;

const TEMPORARY_PREFIX = '.tmp-';

/** Leftovers of a killed write; scans of the output directory never read them as results. */
export function isTemporaryName(name: string): boolean {
  return name.startsWith(TEMPORARY_PREFIX);
}

/**
 * A temporary name next to `destination`, with the process ID and a random part, so the rename
 * stays on one file system and two processes writing the same result never mix their writes.
 */
export function temporaryPath(destination: string): string {
  const unique = `${String(process.pid)}-${randomBytes(6).toString('hex')}`;
  return path.join(
    path.dirname(destination),
    `${TEMPORARY_PREFIX}${unique}-${path.basename(destination)}`,
  );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Writes under a temporary name and renames, so no half-written file survives a kill. */
export async function writeFileAtomic(destination: string, contents: string): Promise<void> {
  const temporary = temporaryPath(destination);
  try {
    await writeFile(temporary, contents, { flag: 'wx' });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** A folder cannot be renamed over a non-empty one; Windows refuses any existing one. */
function isFolderTaken(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM';
}

/**
 * Writes a new folder as a temporary folder and renames it. When `destination` exists (also when
 * another process created it first), each file is replaced atomically instead; the same name
 * means the same content.
 */
export async function writeFolderAtomic(
  destination: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = Object.entries(files);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = temporaryPath(destination);
  await mkdir(temporary);
  try {
    for (const [name, contents] of entries) {
      await writeFile(path.join(temporary, name), contents, { flag: 'wx' });
    }
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (!isFolderTaken(error)) {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  for (const [name, contents] of entries) {
    await writeFileAtomic(path.join(destination, name), contents);
  }
}

/** Entry names of a result folder without temporary names, sorted; none when it is missing. */
export async function listResultEntries(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => !isTemporaryName(name)).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** The append-only `trials.jsonl` of one run. */
export interface TrialLog {
  /**
   * Resolves once the line is written to the file, so a kill after it cannot lose the line: await
   * a send line before sending its attempt. Concurrent appends are written whole, in call order.
   */
  append(line: TrialLine): Promise<void>;
  close(): Promise<void>;
}

export async function openTrialLog(file: string): Promise<TrialLog> {
  const handle = await open(file, 'a');
  let queue: Promise<void> = Promise.resolve();
  return {
    append(line) {
      const written = queue.then(() => handle.appendFile(`${JSON.stringify(line)}\n`, 'utf8'));
      queue = written.catch(() => undefined);
      return written;
    },
    async close() {
      await queue;
      await handle.close();
    },
  };
}

function jsonDocument(value: Manifest | SwapRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeManifest(runDir: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(path.join(runDir, RUN_FILES.manifest), jsonDocument(manifest));
}

export function runDirectoryPath(outputDir: string, runId: string): string {
  return path.join(outputDir, 'runs', runId);
}

/** Run IDs drawn before giving up; one collides only with a run of the same second and variant. */
const RUN_ID_TRIES = 8;

/**
 * Creates the directory of a new run under the first ID `nextRunId` gives that no run directory
 * has, so two runs never share a folder.
 */
export async function createRunDirectory(
  outputDir: string,
  nextRunId: () => string,
): Promise<{ readonly runId: string; readonly runDir: string }> {
  await mkdir(path.join(outputDir, 'runs'), { recursive: true });
  for (let tries = 0; tries < RUN_ID_TRIES; tries += 1) {
    const runId = nextRunId();
    const runDir = runDirectoryPath(outputDir, runId);
    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    }
  }
  throw new Error(`no free run ID in ${path.join(outputDir, 'runs')}`);
}

export function swapRecordPath(outputDir: string, swapId: string): string {
  return path.join(outputDir, 'swaps', `${swapId}.json`);
}

export async function writeSwapRecord(outputDir: string, record: SwapRecord): Promise<void> {
  const file = swapRecordPath(outputDir, record.swapId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, jsonDocument(record));
}

/**
 * Manifest warnings are rewritten at segment start, at segment end and whenever a new code
 * appears, so a run left `running` still has them.
 */
export function hasNewWarningCode(
  written: readonly Warning[],
  current: Iterable<WarningCode>,
): boolean {
  const codes = new Set(written.map((warning) => warning.code));
  return [...current].some((code) => !codes.has(code));
}
