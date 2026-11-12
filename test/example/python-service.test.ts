import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiEnv } from '../contract/helper/support/driver.js';
import { MockApi } from '../contract/helper/support/mock-api.js';
import { CLI, ROOT, type CliResult } from '../e2e/support/cli.js';
import { SWAP } from '../e2e/support/commands.js';
import {
  attemptLines,
  effectiveLines,
  parseSwapEnvelope,
  readRun,
  swapRunOf,
  type RunFiles,
} from '../e2e/support/outputs.js';

// SC-001 and SC-004: quickstart.md §Verify: Example Python Service, steps 1 and 3, in
// examples/python-service itself, whose adapter is written with the Python helper. Its model
// calls go to the mock API server, so no model is called.

const EXAMPLE = path.join(ROOT, 'examples/python-service');
const VENV_PYTHON = path.join(EXAMPLE, '.venv/bin/python');
const SETUP =
  'cd examples/python-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt';
const OUTPUT_DIR = path.join(EXAMPLE, '.model-eval');
const MAX_ADAPTER_LINES = 30;
const MODELS = ['model-a', 'model-b'];
/** The OpenAI SDK names its client class in the user agent, sync or async. */
const SDK_USER_AGENT = /^(Async)?OpenAI\/Python /u;
const HELPER_IMPORT = /^\s*(from|import)\s+model_eval_adapter\b/mu;

/** The CI step of the example has 5 minutes; one swap of the example cases fits well inside. */
const BUDGET_MS = 240_000;

let mock: MockApi | undefined;
let serviceBefore: Map<string, string>;
let swap: CliResult;

/** Each file under service/ as git sees it (tracked and untracked, not ignored), with its hash. */
function serviceFiles(): Map<string, string> {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'service'],
    { cwd: EXAMPLE, encoding: 'utf8' },
  );
  const files = new Map<string, string>();
  for (const file of listed.split('\0').filter((name) => name !== '')) {
    const absolute = path.join(EXAMPLE, file);
    const hash = existsSync(absolute)
      ? createHash('sha256').update(readFileSync(absolute)).digest('hex')
      : 'deleted';
    files.set(file, hash);
  }
  return files;
}

/** Runs the built CLI in the example folder with the mock server's base URL and a dummy key. */
function runExample(server: MockApi, args: readonly string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...apiEnv(server.url), NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: EXAMPLE, env, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), BUDGET_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/** The runs of the swap, baseline first; fails the test when the swap wrote none. */
async function swapRuns(): Promise<RunFiles[]> {
  const { runs } = swapRunOf(parseSwapEnvelope(swap.stdout));
  return Promise.all(runs.map((runId) => readRun(OUTPUT_DIR, runId)));
}

beforeAll(async () => {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(`examples/python-service/.venv is missing; create it with: ${SETUP}`);
  }
  // Each run starts as a fresh clone does, without earlier runs of the example.
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  serviceBefore = serviceFiles();
  mock = await MockApi.start();
  swap = await runExample(mock, [...SWAP, '--json']);
}, BUDGET_MS);

afterAll(async () => {
  await mock?.stop();
});

describe('003 example examples/python-service (quickstart.md §Verify: Example Python Service)', () => {
  it('003 SC-001 step 1: adapter.py has at most 30 lines and no service file imports the helper', async () => {
    const adapter = await readFile(path.join(EXAMPLE, 'adapter.py'), 'utf8');
    // `wc -l` counts line ends.
    expect(adapter.split('\n').length - 1).toBeLessThanOrEqual(MAX_ADAPTER_LINES);
    expect(adapter).toMatch(HELPER_IMPORT);
    expect(serviceBefore.size).toBeGreaterThan(0);
    for (const file of serviceBefore.keys()) {
      const text = await readFile(path.join(EXAMPLE, file), 'utf8');
      expect(text, file).not.toMatch(HELPER_IMPORT);
    }
  });

  it(
    '003 SC-004 step 3: swap --from current --to next exits 0 or 1 and every trial is ok with raw, usage, finishReason and calls',
    async () => {
      expect([0, 1], swap.stderr).toContain(swap.code);
      const runs = await swapRuns();
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        const trials = [...effectiveLines(run.lines).values()];
        expect(trials.length).toBeGreaterThan(0);
        for (const trial of trials) {
          const where = `${run.manifest.runId} ${trial.caseId}#${String(trial.repeat)}`;
          expect(trial.status, where).toBe('ok');
          if (trial.status !== 'ok') {
            continue;
          }
          expect(trial.raw, where).not.toBe('');
          expect(trial.usage, where).toBeDefined();
          expect(trial.finishReason, where).toBeDefined();
          expect(trial.calls?.length ?? 0, where).toBeGreaterThan(0);
        }
      }
    },
    BUDGET_MS,
  );

  it('003 SC-001 SC-004 the mock server received requests only from the adapter', async () => {
    if (mock === undefined) {
      throw new Error('the mock API server did not start');
    }
    const received = await mock.log();
    const runs = await swapRuns();
    const recordedCalls = runs
      .flatMap((run) => attemptLines(run.lines))
      .reduce((sum, line) => sum + (line.calls?.length ?? 0), 0);
    expect(received.length).toBeGreaterThan(0);
    expect(received).toHaveLength(recordedCalls);
    for (const request of received) {
      expect(request).toMatchObject({ method: 'POST', path: '/v1/chat/completions' });
      expect(MODELS).toContain(request.model);
      expect(request.headers['user-agent']).toMatch(SDK_USER_AGENT);
    }
  });

  it('003 SC-001 no file under service/ changed during the test', () => {
    expect(serviceFiles()).toEqual(serviceBefore);
  });
});
