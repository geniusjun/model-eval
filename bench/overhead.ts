// The tool's own time per trial (plan §Technical Context: at most 5 ms), measured as the built
// CLI's `run` against the mock adapter, which answers at once. The mock's own work is included,
// so the figure is an upper bound. Needs `pnpm build` first.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { stringify } from 'yaml';

import { CLI, MOCK_ADAPTER, runCli } from '../test/e2e/support/cli.js';
import { scenarioFile } from '../test/e2e/support/mock.js';
import { greetCases, MODEL_A, MODEL_B, type ConfigInput } from '../test/e2e/support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA } from '../test/e2e/support/rules.js';

const GOAL_MS = 5;
const CASES_PER_LANGUAGE = 25;
/** Two run sizes; the slope between them leaves out start-up, render and the fixed writes. */
const SMALL_REPEATS = 2;
const LARGE_REPEATS = 10;
/** Runs per size; the median is used. */
const SAMPLES = 3;

const CONFIG: ConfigInput = {
  version: 1,
  adapter: { command: [process.execPath, MOCK_ADAPTER, scenarioFile('basic')] },
  variants: [
    { id: 'current', model: MODEL_A },
    { id: 'next', model: MODEL_B },
  ],
  pricing: {
    [MODEL_A]: { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 },
    [MODEL_B]: { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 },
  },
  // One request at a time, so concurrency cannot hide the time spent per trial.
  run: { concurrency: 1 },
  budget: { maxCostUsd: null },
};

async function createProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'model-eval-overhead-'));
  await mkdir(path.join(root, 'rules'));
  await mkdir(path.join(root, 'cases'));
  const cases = greetCases({ ko: CASES_PER_LANGUAGE, ja: CASES_PER_LANGUAGE });
  await writeFile(path.join(root, 'model-eval.config.yaml'), stringify(CONFIG));
  await writeFile(
    path.join(root, 'rules', 'rules.yaml'),
    stringify({ rules: [ANSWERED, SCRIPT_JA, NO_EMOJI] }),
  );
  await writeFile(path.join(root, 'cases', 'cases.yaml'), stringify({ cases }));
  return root;
}

/** Wall time of one `run --variant current`, in milliseconds. */
async function timeRun(root: string, repeats: number): Promise<number> {
  const started = process.hrtime.bigint();
  const result = await runCli(
    ['run', '--variant', 'current', '--repeats', String(repeats), '--json'],
    root,
  );
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.code !== 0) {
    throw new Error(`run exited with ${String(result.code)}:\n${result.stderr}`);
  }
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? Number.NaN) + (sorted[middle] ?? Number.NaN)) / 2;
}

async function medianRun(root: string, repeats: number): Promise<number> {
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    times.push(await timeRun(root, repeats));
  }
  return median(times);
}

export async function main(): Promise<number> {
  if (!existsSync(CLI) || !existsSync(MOCK_ADAPTER)) {
    process.stderr.write('bench/overhead.ts needs the built CLI; run `pnpm build` first.\n');
    return 1;
  }
  const root = await createProject();
  try {
    const cases = 2 * CASES_PER_LANGUAGE;
    const small = { trials: cases * SMALL_REPEATS, ms: await medianRun(root, SMALL_REPEATS) };
    const large = { trials: cases * LARGE_REPEATS, ms: await medianRun(root, LARGE_REPEATS) };
    const perTrial = (large.ms - small.ms) / (large.trials - small.trials);
    const met = perTrial <= GOAL_MS;
    const lines = [
      `Tool overhead per trial: \`run\` against the mock adapter, ${String(cases)} cases, concurrency 1, median of ${String(SAMPLES)} runs per size.`,
      '',
      '| Trials | Wall time (ms) |',
      '|---|---|',
      `| ${String(small.trials)} | ${small.ms.toFixed(0)} |`,
      `| ${String(large.trials)} | ${large.ms.toFixed(0)} |`,
      '',
      `Per trial (slope): ${perTrial.toFixed(2)} ms; goal ≤ ${String(GOAL_MS)} ms: ${met ? 'met' : 'missed'}.`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return met ? 0 : 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main();
}
