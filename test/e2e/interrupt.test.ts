import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Scenario } from '../../src/adapter/mock-scenario.js';
import { manifestSchema, type SwapRecord } from '../../src/run/manifest.js';
import { startCli, type CliResult, type StartedCli } from './support/cli.js';
import { E2E, SWAP, useProjects } from './support/commands.js';
import {
  attemptLines,
  comparisonOf,
  effectiveLines,
  parseRunEnvelope,
  parseSwapEnvelope,
  readRun,
  readSwapRecord,
  sendLines,
  swapRunOf,
  trialKey,
  type RunEnvelope,
} from './support/outputs.js';
import { greetCases, type Project, type ProjectSpec } from './support/project.js';
import { ANSWERED } from './support/rules.js';
import { copyScenario } from './support/scenario-copy.js';

// Interrupts and kills (data-model §Stopping, §Run and Swap Status; FR-013, FR-032).

const project = useProjects();

const CASES = greetCases({ ko: 5, en: 5 });
/**
 * Two slots, and the first two trials of each variant answer late: once both requests arrived,
 * nothing else can go out before they answer (fixture header).
 */
const LATE: ProjectSpec = {
  scenario: 'interrupt-late',
  rules: [ANSWERED],
  cases: CASES,
  config: { sampling: { repeats: 1 }, run: { concurrency: 2 } },
};
const FIRST_TWO = [trialKey('greet-en-1', 0), trialKey('greet-ko-1', 0)];
/** greet-ko-2 never answers; the time limit is far beyond any test. */
const HANG: ProjectSpec = {
  scenario: 'interrupt-hang',
  rules: [ANSWERED],
  cases: CASES,
  config: { sampling: { repeats: 1 }, run: { concurrency: 2 } },
  adapterTimeoutMs: 60_000,
};
/** The notice the CLI prints when a first signal starts the stop. */
const STOPPING = /Interrupt again/;
const POLL_MS = 25;
const WAIT_LIMIT_MS = 30_000;

async function waitUntil(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting until ${what}`);
    }
    await sleep(POLL_MS);
  }
}

/** Waits until the adapter received `count` `generate` requests, or one for `caseId`. */
async function waitForRequests(made: Project, until: { count?: number; caseId?: string }) {
  await waitUntil('the adapter received the requests', async () => {
    const requests = await made.generateRequests();
    return (
      requests.length >= (until.count ?? 0) &&
      (until.caseId === undefined || requests.some((request) => request.caseId === until.caseId))
    );
  });
}

async function interruptTwice(
  cli: StartedCli,
  second: NodeJS.Signals = 'SIGINT',
): Promise<CliResult> {
  cli.kill('SIGINT');
  await waitUntil('the CLI said it is stopping', () => STOPPING.test(cli.stderr()));
  cli.kill(second);
  return cli.done;
}

/** Adapter processes started for the project, from the recorder's log names (`<pid>.jsonl`). */
async function adapterPids(made: Project): Promise<number[]> {
  const names = await readdir(path.join(made.root, 'requests'));
  return names.map((name) => Number(path.basename(name, '.jsonl')));
}

/** Whether any process of the group `pgid` still runs. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Effective outcome and answer per trial, what resume must reproduce. */
function outcomesOf(lines: Parameters<typeof effectiveLines>[0]): Record<string, string> {
  return Object.fromEntries(
    [...effectiveLines(lines)].map(([key, line]) => [
      key,
      line.status === 'ok' ? `ok ${line.raw}` : line.status,
    ]),
  );
}

function withoutHang(scenario: Scenario): Scenario {
  return {
    ...scenario,
    variants: Object.fromEntries(
      Object.entries(scenario.variants).map(([id, behaviour]) => [
        id,
        { ...behaviour, outcomes: behaviour.outcomes.filter((outcome) => outcome.row !== 'hang') },
      ]),
    ),
  };
}

type RunResult = Exclude<NonNullable<RunEnvelope['result']>, { plan: unknown }>;

function runResultOf(stdout: string): RunResult {
  const { result } = parseRunEnvelope(stdout);
  if (result === null || 'plan' in result) {
    throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('001 first interrupt', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(
      `001 FR-013 ${signal} stops sending, waits for the attempts in flight and ends interrupted`,
      async () => {
        const made = await project(LATE);
        const cli = startCli(['run', '--variant', 'current', '--json'], made.root);
        await waitForRequests(made, { count: 2 });
        cli.kill(signal);
        const ended = await cli.done;
        expect(ended.code, ended.stderr).toBe(3);
        expect(ended.stderr).toMatch(STOPPING);
        const result = runResultOf(ended.stdout);
        expect(result).toMatchObject({ status: 'partial', stopReason: 'interrupted' });
        const run = await readRun(made.outputDir, result.runId);
        // The two attempts in flight were awaited and recorded as usual; nothing else went out.
        const attempts = attemptLines(run.lines);
        expect(attempts.map((line) => trialKey(line.caseId, line.repeat)).sort()).toEqual(
          FIRST_TWO,
        );
        expect(attempts.every((line) => line.status === 'ok')).toBe(true);
        expect((await made.generateRequests()).length).toBe(2);
        expect(existsSync(path.join(run.dir, 'run.lock'))).toBe(false);
      },
      E2E.timeout,
    );
  }

  it(
    '001 FR-013 an interrupt sent to the whole process group reaches only the tool, and resume ends as an uninterrupted run',
    async () => {
      const made = await project(LATE);
      const cli = startCli(['run', '--variant', 'current', '--json'], made.root, {
        ownGroup: true,
      });
      await waitForRequests(made, { count: 2 });
      cli.killGroup('SIGINT');
      const ended = await cli.done;
      expect(ended.code, ended.stderr).toBe(3);
      const { runId } = runResultOf(ended.stdout);
      const interrupted = await readRun(made.outputDir, runId);
      expect(interrupted.manifest.stopReason).toBe('interrupted');
      expect(outcomesOf(interrupted.lines)).toEqual(
        Object.fromEntries(FIRST_TWO.map((key) => [key, expect.stringMatching(/^ok /)])),
      );

      const resumed = await made.run(['run', '--resume', runId, '--json']);
      expect(resumed.code, resumed.stderr).toBe(0);
      const uninterrupted = await project(LATE);
      const whole = await uninterrupted.run(['run', '--variant', 'current', '--json']);
      expect(whole.code, whole.stderr).toBe(0);
      const after = await readRun(made.outputDir, runId);
      const reference = await readRun(uninterrupted.outputDir, runResultOf(whole.stdout).runId);
      expect(outcomesOf(after.lines)).toEqual(outcomesOf(reference.lines));
      expect(after.manifest.totals.outcomes).toEqual(reference.manifest.totals.outcomes);
    },
    E2E.timeout,
  );
});

describe('001 second interrupt', () => {
  for (const second of ['SIGINT', 'SIGTERM'] as const) {
    it(
      `001 FR-013 a second interrupt (${second}) records the attempts in flight as stopped, ends the adapter and exits at once`,
      async () => {
        const made = await project(HANG);
        const copy = await copyScenario(made, 'interrupt-hang');
        const cli = startCli(['run', '--variant', 'current', '--json'], made.root);
        await waitForRequests(made, { caseId: 'greet-ko-2' });
        const ended = await interruptTwice(cli, second);
        expect(ended.code, ended.stderr).toBe(3);
        const result = runResultOf(ended.stdout);
        expect(result).toMatchObject({ status: 'partial', stopReason: 'interrupted' });
        const run = await readRun(made.outputDir, result.runId);
        const hung = effectiveLines(run.lines).get(trialKey('greet-ko-2', 0));
        expect(hung).toMatchObject({ status: 'stopped', costEstimated: true });
        const send = sendLines(run.lines).find((line) => line.caseId === 'greet-ko-2');
        expect(hung?.costUsd).toBe(send?.reservedUsd);
        expect(attemptLines(run.lines).length).toBe(sendLines(run.lines).length);
        expect(existsSync(path.join(run.dir, 'run.lock'))).toBe(false);
        // The adapter ran in a process group of its own; nothing of it outlives the tool.
        for (const pid of await adapterPids(made)) {
          await waitUntil(`adapter group ${String(pid)} ended`, () => !groupAlive(pid));
        }

        // Resume sends the cut trial again.
        await copy.edit(withoutHang);
        const resumed = await made.run(['run', '--resume', result.runId, '--json']);
        expect(resumed.code, resumed.stderr).toBe(0);
        const after = await readRun(made.outputDir, result.runId);
        expect(effectiveLines(after.lines).get(trialKey('greet-ko-2', 0))).toMatchObject({
          status: 'ok',
          attempt: 2,
          segment: 2,
        });
      },
      E2E.timeout,
    );
  }
});

/** Rewrites a finished swap record as a kill before its end leaves it: `running`, not compared. */
async function unfinishSwap(made: Project, swapId: string): Promise<SwapRecord> {
  const record = await readSwapRecord(made.outputDir, swapId);
  const { comparisonId: _compared, stopReason: _reason, ...running } = record;
  await writeFile(
    path.join(made.outputDir, 'swaps', `${swapId}.json`),
    JSON.stringify({
      ...running,
      status: 'running',
      segments: record.segments.map(({ endedAt: _ended, ...segment }) => segment),
    }),
  );
  return record;
}

/** The only entry of an output folder, after a kill that left one run or swap. */
async function onlyEntry(dir: string): Promise<string> {
  const names = await readdir(dir);
  const [name] = names;
  if (name === undefined || names.length !== 1) {
    throw new Error(`expected one entry in ${dir}, found ${names.join(', ')}`);
  }
  return name;
}

describe('001 a killed run', () => {
  it(
    '001 FR-013 stays running after a kill and resumes once the lock owner is gone',
    async () => {
      const made = await project(HANG);
      const copy = await copyScenario(made, 'interrupt-hang');
      const cli = startCli(['run', '--variant', 'current', '--json'], made.root);
      await waitForRequests(made, { caseId: 'greet-ko-2' });
      cli.kill('SIGKILL');
      await cli.done;
      const id = await onlyEntry(path.join(made.outputDir, 'runs'));
      const killed = await readRun(made.outputDir, id);
      expect(killed.manifest.status).toBe('running');
      expect(existsSync(path.join(killed.dir, 'run.lock'))).toBe(true);
      const unanswered = sendLines(killed.lines).filter(
        (send) =>
          !attemptLines(killed.lines).some(
            (line) => line.caseId === send.caseId && line.attempt === send.attempt,
          ),
      );
      expect(unanswered.map((send) => send.caseId)).toContain('greet-ko-2');

      await copy.edit(withoutHang);
      const resumed = await made.run(['run', '--resume', id, '--json']);
      expect(resumed.code, resumed.stderr).toBe(0);
      const after = await readRun(made.outputDir, id);
      expect(after.manifest.status).toBe('complete');
      for (const send of unanswered) {
        const closing = attemptLines(after.lines).find(
          (line) => line.caseId === send.caseId && line.attempt === send.attempt,
        );
        expect(closing).toMatchObject({
          status: 'stopped',
          segment: 1,
          costUsd: send.reservedUsd,
          costEstimated: true,
        });
        expect(effectiveLines(after.lines).get(trialKey(send.caseId, send.repeat))).toMatchObject({
          status: 'ok',
          attempt: send.attempt + 1,
          segment: 2,
        });
      }
      expect(existsSync(path.join(after.dir, 'run.lock'))).toBe(false);
    },
    E2E.timeout,
  );
});

describe('001 interrupted swap', () => {
  it(
    '001 FR-032 compares what finished after a first interrupt, withheld as undecided',
    async () => {
      const made = await project(LATE);
      const cli = startCli([...SWAP, '--json'], made.root);
      await waitForRequests(made, { count: 4 });
      cli.kill('SIGINT');
      const ended = await cli.done;
      expect(ended.code, ended.stderr).toBe(3);
      const envelope = parseSwapEnvelope(ended.stdout);
      const comparison = comparisonOf(envelope);
      expect(comparison.gate.outcome).toBe('undecided');
      const { swapId } = swapRunOf(envelope);
      const record = await readSwapRecord(made.outputDir, swapId);
      expect(record).toMatchObject({
        status: 'partial',
        stopReason: 'interrupted',
        comparisonId: comparison.comparisonId,
      });
    },
    E2E.timeout,
  );

  it(
    '001 FR-032 does not compare after a second interrupt',
    async () => {
      const made = await project(HANG);
      await copyScenario(made, 'interrupt-hang');
      const cli = startCli([...SWAP, '--json'], made.root);
      await waitForRequests(made, { caseId: 'greet-ko-2' });
      const ended = await interruptTwice(cli);
      expect(ended.code, ended.stderr).toBe(3);
      const envelope = parseSwapEnvelope(ended.stdout);
      const { swapId } = swapRunOf(envelope);
      expect(envelope.result).not.toHaveProperty('comparison');
      const record = await readSwapRecord(made.outputDir, swapId);
      expect(record).toMatchObject({ status: 'partial', stopReason: 'interrupted' });
      expect(record.comparisonId).toBeUndefined();
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 resumes a killed swap by its swapId and compares, and refuses other variants or a complete swap',
    async () => {
      const made = await project(HANG);
      const copy = await copyScenario(made, 'interrupt-hang');
      const cli = startCli([...SWAP, '--json'], made.root);
      await waitForRequests(made, { caseId: 'greet-ko-2' });
      cli.kill('SIGKILL');
      await cli.done;
      const swapId = (await onlyEntry(path.join(made.outputDir, 'swaps'))).replace(/\.json$/, '');
      expect((await readSwapRecord(made.outputDir, swapId)).status).toBe('running');

      await copy.edit(withoutHang);
      // A refused swap resume changes neither run, also when only the other run is refused.
      const record = await readSwapRecord(made.outputDir, swapId);
      const baselineTrials = path.join(
        made.outputDir,
        'runs',
        record.baselineRunId,
        'trials.jsonl',
      );
      const candidateLock = path.join(made.outputDir, 'runs', record.candidateRunId, 'run.lock');
      await writeFile(baselineTrials, `${await readFile(baselineTrials, 'utf8')}{"caseId":`);
      const baselineBefore = await readFile(baselineTrials, 'utf8');
      const live = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
      await writeFile(candidateLock, JSON.stringify(live));
      const locked = await made.run(['swap', '--resume', swapId, '--json']);
      expect(locked.code).toBe(4);
      expect(locked.stderr).toContain(candidateLock);
      expect(await readFile(baselineTrials, 'utf8')).toBe(baselineBefore);
      await rm(candidateLock);
      for (const option of ['--from', '--to'] as const) {
        const other = option === '--from' ? 'next' : 'current';
        const swapped = await made.run(['swap', '--resume', swapId, option, other, '--json']);
        expect(swapped.code).toBe(4);
        expect(swapped.stderr).toContain(option);
      }
      const resumed = await made.run(['swap', '--resume', swapId, '--json']);
      expect(resumed.code, resumed.stderr).toBe(0);
      const again = await made.run(['swap', '--resume', swapId, '--json']);
      expect(again.code).toBe(4);
      expect(again.stderr).toMatch(/complete/);
      const envelope = parseSwapEnvelope(resumed.stdout);
      const comparison = comparisonOf(envelope);
      const resumedRecord = await readSwapRecord(made.outputDir, swapId);
      expect(resumedRecord).toMatchObject({
        status: 'complete',
        comparisonId: comparison.comparisonId,
      });
      expect(resumedRecord.segments.map((segment) => segment.segment)).toEqual([1, 2]);
      for (const runId of [record.baselineRunId, record.candidateRunId]) {
        const run = await readRun(made.outputDir, runId);
        expect(run.manifest.status).toBe('complete');
        expect(run.manifest.segments).toHaveLength(2);
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 compares without sending when both runs finished but the swap was killed before comparing',
    async () => {
      const made = await project(HANG);
      const copy = await copyScenario(made, 'interrupt-hang');
      await copy.edit(withoutHang);
      const first = await made.run([...SWAP, '--json']);
      expect(first.code, first.stderr).toBe(0);
      const { swapId } = swapRunOf(parseSwapEnvelope(first.stdout));
      // The state a kill right after both runs' last lines leaves: nothing ended or compared.
      const record = await unfinishSwap(made, swapId);
      for (const runId of [record.baselineRunId, record.candidateRunId]) {
        const file = path.join(made.outputDir, 'runs', runId, 'manifest.json');
        const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        await writeFile(file, JSON.stringify({ ...manifest, status: 'running' }));
      }
      const sentBefore = (await made.generateRequests()).length;
      const resumed = await made.run(['swap', '--resume', swapId, '--json']);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect((await made.generateRequests()).length).toBe(sentBefore);
      const comparison = comparisonOf(parseSwapEnvelope(resumed.stdout));
      expect(await readSwapRecord(made.outputDir, swapId)).toMatchObject({
        status: 'complete',
        comparisonId: comparison.comparisonId,
      });
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 resumes a swap whose baseline is complete by sending only the candidate, then compares',
    async () => {
      const made = await project(HANG);
      const copy = await copyScenario(made, 'interrupt-hang');
      await copy.edit(withoutHang);
      const first = await made.run([...SWAP, '--json']);
      expect(first.code, first.stderr).toBe(0);
      const { swapId } = swapRunOf(parseSwapEnvelope(first.stdout));
      const record = await readSwapRecord(made.outputDir, swapId);
      // A kill between the two runs' ends: the baseline is complete, the candidate never sent
      // its last two cases.
      const dropped = new Set(['greet-ko-5', 'greet-en-5']);
      const candidateDir = path.join(made.outputDir, 'runs', record.candidateRunId);
      const candidate = await readRun(made.outputDir, record.candidateRunId);
      await writeFile(
        path.join(candidateDir, 'trials.jsonl'),
        candidate.lines
          .filter((line) => !('caseId' in line) || !dropped.has(line.caseId))
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(''),
      );
      await writeFile(
        path.join(candidateDir, 'manifest.json'),
        JSON.stringify({ ...candidate.manifest, status: 'running' }),
      );
      await unfinishSwap(made, swapId);
      const before = (await made.generateRequests()).length;
      const resumed = await made.run(['swap', '--resume', swapId, '--json']);
      expect(resumed.code, resumed.stderr).toBe(0);
      const sent = (await made.generateRequests()).sort((a, b) => a.at - b.at).slice(before);
      expect(sent.map((request) => `${request.variant ?? ''} ${request.caseId}`).sort()).toEqual([
        'next greet-en-5',
        'next greet-ko-5',
      ]);
      const comparison = comparisonOf(parseSwapEnvelope(resumed.stdout));
      expect(await readSwapRecord(made.outputDir, swapId)).toMatchObject({
        status: 'complete',
        comparisonId: comparison.comparisonId,
      });
    },
    E2E.timeout,
  );

  it(
    '001 FR-011 compares the earlier segments when a resumed swap stops at once with budget-projected',
    async () => {
      const made = await project(HANG);
      const copy = await copyScenario(made, 'interrupt-hang');
      const cli = startCli([...SWAP, '--json'], made.root);
      await waitForRequests(made, { caseId: 'greet-ko-2' });
      cli.kill('SIGKILL');
      await cli.done;
      const swapId = (await onlyEntry(path.join(made.outputDir, 'swaps'))).replace(/\.json$/, '');
      await copy.edit(withoutHang);
      const before = (await made.generateRequests()).length;
      const resumed = await made.run([
        'swap',
        '--resume',
        swapId,
        '--max-cost-usd',
        '0.000001',
        '--json',
      ]);
      expect(resumed.code, resumed.stderr).toBe(5);
      expect((await made.generateRequests()).length).toBe(before);
      const comparison = comparisonOf(parseSwapEnvelope(resumed.stdout));
      expect(comparison.gate.outcome).toBe('undecided');
      expect(await readSwapRecord(made.outputDir, swapId)).toMatchObject({
        status: 'partial',
        stopReason: 'budget-projected',
        comparisonId: comparison.comparisonId,
      });
    },
    E2E.timeout,
  );
});
