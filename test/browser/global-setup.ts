import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COMPARISONS_DIR, REPORT_PAGE_FILE } from '../../src/report/layout.js';
import {
  EXAMPLE_FIRST_ENV,
  EXAMPLE_OUTPUT_ENV,
  EXAMPLE_PAGE_ENV,
  EXAMPLE_SECOND_ENV,
  ROOT,
} from './pages.js';

// The example output (SC-001): two swaps of a copy of examples/pogo with its Node adapter, which
// calls no model. Its `next` variant breaks the Japanese script rule on purpose, so the gate
// blocks and each swap exits 1. The pages are the `report.html` and `index.html` the swaps write.
// Between the two, a copy of the first comparison is left in a `.tmp-` folder, as a writer cut
// short leaves one; the second swap's `index.html` must not list it.

const EXAMPLE = path.join(ROOT, 'examples/pogo');
const CLI = path.join(ROOT, 'dist/cli.js');
const OUTPUT_DIR = '.model-eval';
const BLOCKED_EXIT = 1;

/** The last lines of stderr that a failed swap's error carries. */
const STDERR_TAIL_LINES = 20;

interface SwapResult {
  readonly code: number | null;
  readonly stderr: string;
}

function runSwap(cwd: string): Promise<SwapResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, 'swap', '--from', 'current', '--to', 'next', '--json'],
      { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NO_COLOR: '1' } },
    );
    const stderr: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr: stderr.join('') });
    });
  });
}

function tail(text: string): string {
  return text.trimEnd().split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

/** The comparison folders of the output, temporary names left out, in name order. */
async function comparisonFolders(outputDir: string): Promise<string[]> {
  const comparisons = path.join(outputDir, COMPARISONS_DIR);
  return (await readdir(comparisons, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
    .map((entry) => entry.name)
    .sort();
}

async function swapBlocked(cwd: string): Promise<void> {
  const swap = await runSwap(cwd);
  if (swap.code !== BLOCKED_EXIT) {
    throw new Error(
      `the example swap exited ${String(swap.code)}, expected ${String(BLOCKED_EXIT)}; stderr:\n${tail(swap.stderr)}`,
    );
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-example-page-'));
  await cp(EXAMPLE, folder, {
    recursive: true,
    filter: (source) => path.basename(source) !== OUTPUT_DIR,
  });
  const outputDir = path.join(folder, OUTPUT_DIR);
  await swapBlocked(folder);
  const [first, ...others] = await comparisonFolders(outputDir);
  if (first === undefined || others.length > 0) {
    throw new Error(
      `expected one comparison after the first swap, found ${String(others.length + 1)}`,
    );
  }
  const comparisons = path.join(outputDir, COMPARISONS_DIR);
  await cp(path.join(comparisons, first), path.join(comparisons, `.tmp-${first}`), {
    recursive: true,
  });
  await swapBlocked(folder);
  const folders = await comparisonFolders(outputDir);
  const second = folders.find((name) => name !== first);
  if (folders.length !== 2 || second === undefined) {
    throw new Error(
      `expected two comparisons after the second swap, found ${String(folders.length)}`,
    );
  }
  process.env[EXAMPLE_PAGE_ENV] = path.join(comparisons, first, REPORT_PAGE_FILE);
  process.env[EXAMPLE_OUTPUT_ENV] = outputDir;
  process.env[EXAMPLE_FIRST_ENV] = first;
  process.env[EXAMPLE_SECOND_ENV] = second;
  return () => rm(folder, { recursive: true, force: true });
}
