import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { comparisonPage, fillTemplate } from '../../src/report/page-data.js';
import { comparisonSchema } from '../../src/report/schema.js';
import { EXAMPLE_PAGE_ENV, readTemplate, ROOT } from './pages.js';

// The example page (SC-001): a swap of a copy of examples/pogo with its Node adapter, which
// calls no model. Its `next` variant breaks the Japanese script rule on purpose, so the gate
// blocks and the command exits 1.

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

async function onlyComparison(outputDir: string): Promise<string> {
  const comparisons = path.join(outputDir, 'comparisons');
  const folders = (await readdir(comparisons, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.tmp-'))
    .map((entry) => entry.name);
  const [folder, ...others] = folders;
  if (folder === undefined || others.length > 0) {
    throw new Error(`expected one comparison in ${comparisons}, found ${String(folders.length)}`);
  }
  return path.join(comparisons, folder, 'comparison.json');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-example-page-'));
  await cp(EXAMPLE, folder, {
    recursive: true,
    filter: (source) => path.basename(source) !== OUTPUT_DIR,
  });
  const swap = await runSwap(folder);
  if (swap.code !== BLOCKED_EXIT) {
    throw new Error(
      `the example swap exited ${String(swap.code)}, expected ${String(BLOCKED_EXIT)}; stderr:\n${tail(swap.stderr)}`,
    );
  }
  const file = await onlyComparison(path.join(folder, OUTPUT_DIR));
  const comparison = comparisonSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const page = path.join(folder, 'example.html');
  await writeFile(page, fillTemplate(await readTemplate(), comparisonPage(comparison, 'en')));
  process.env[EXAMPLE_PAGE_ENV] = page;
  return () => rm(folder, { recursive: true, force: true });
}
