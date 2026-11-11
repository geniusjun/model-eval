import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Scenario } from '../../src/adapter/mock-scenario.js';
import { initializeParamsSchema, type InitializeParams } from '../../src/adapter/protocol.js';
import type { Warning } from '../../src/run/warning.js';
import { E2E, SWAP, useProjects } from './support/commands.js';
import { GLOBAL_SEED, trialSeed } from './support/mock.js';
import {
  attemptLines,
  dryRunPlanOf,
  effectiveLines,
  filesUnder,
  parseRunEnvelope,
  parseSwapEnvelope,
  readRun,
  sendLines,
  swapRunOf,
  trialKey,
  type RunEnvelope,
  type RunFiles,
} from './support/outputs.js';
import {
  greetCases,
  MODEL_A,
  MODEL_B,
  type CaseInput,
  type Project,
  type ProjectSpec,
} from './support/project.js';
import { ANSWERED, NO_EMOJI } from './support/rules.js';
import {
  copyScenario,
  readConfig,
  writeConfig,
  type ScenarioCopy,
} from './support/scenario-copy.js';
import type { CliResult } from './support/cli.js';

// Resuming a stopped run (001 User Story 4, acceptance scenarios 2–4; data-model §Resume and
// Locking) against the mock adapter.

const project = useProjects();

const CASES = greetCases({ ko: 4, en: 4 });
/** One repeat and one slot, so the send order and the stop point are fixed (fixture header). */
const SPEC: ProjectSpec = {
  scenario: 'resume',
  rules: [ANSWERED],
  cases: CASES,
  config: { sampling: { repeats: 1 }, run: { concurrency: 1, retries: 1 } },
};
const CASES_FILE = path.join('cases', 'cases.yaml');
const RULES_FILE = path.join('rules', 'rules.yaml');

interface StoppedRun {
  readonly project: Project;
  readonly scenario: ScenarioCopy;
  readonly runId: string;
  readonly first: RunFiles;
}

function withoutConfigFailure(scenario: Scenario): Scenario {
  return {
    ...scenario,
    variants: Object.fromEntries(
      Object.entries(scenario.variants).map(([id, behaviour]) => [
        id,
        {
          ...behaviour,
          outcomes: behaviour.outcomes.filter((outcome) => outcome.row !== 'config'),
        },
      ]),
    ),
  };
}

function runIdOf(envelope: RunEnvelope): string {
  const { result } = envelope;
  if (result === null || 'plan' in result) {
    throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
  }
  return result.runId;
}

/**
 * A run stopped by greet-ko-4's configuration failure, its scenario not fixed yet. `prepare`
 * changes the project before the first segment; `args` are added to its command line.
 */
async function stoppedRun(
  prepare?: (copy: ScenarioCopy, made: Project) => Promise<void>,
  args: readonly string[] = [],
): Promise<StoppedRun> {
  const made = await project(SPEC);
  const scenario = await copyScenario(made, 'resume');
  await prepare?.(scenario, made);
  const cli = await made.run(['run', '--variant', 'current', ...args, '--json']);
  expect(cli.code, cli.stderr).toBe(4);
  const runId = runIdOf(parseRunEnvelope(cli.stdout));
  const first = await readRun(made.outputDir, runId);
  expect(first.manifest).toMatchObject({ status: 'partial', stopReason: 'config-error' });
  return { project: made, scenario, runId, first };
}

interface Resumed {
  readonly cli: CliResult;
  readonly envelope: RunEnvelope;
  /** Trial keys of the `generate` requests the resume sent. */
  readonly sent: readonly string[];
}

async function resume(run: StoppedRun, extra: readonly string[] = []): Promise<Resumed> {
  const before = (await run.project.generateRequests()).length;
  const cli = await run.project.run(['run', '--resume', run.runId, ...extra, '--json']);
  let envelope: RunEnvelope;
  try {
    envelope = parseRunEnvelope(cli.stdout);
  } catch (error) {
    throw new Error(`run --resume exited ${String(cli.code)} without an envelope:\n${cli.stderr}`, {
      cause: error,
    });
  }
  const requests = (await run.project.generateRequests()).sort((a, b) => a.at - b.at);
  return {
    cli,
    envelope,
    sent: requests.slice(before).map((request) => trialKey(request.caseId, request.repeat)),
  };
}

/** The run's records as text, to show that a refused or dry resume changed nothing. */
async function snapshot(run: StoppedRun): Promise<Map<string, string>> {
  const dir = path.join(run.project.outputDir, 'runs', run.runId);
  const files = await filesUnder(dir);
  return new Map(
    await Promise.all(
      files.map(async (file): Promise<[string, string]> => [file, await readFile(file, 'utf8')]),
    ),
  );
}

async function expectRefused(run: StoppedRun, extra: readonly string[] = []): Promise<CliResult> {
  const before = await snapshot(run);
  const resumed = await resume(run, extra);
  expect(resumed.cli.code, resumed.cli.stderr).toBe(4);
  expect(resumed.envelope.result).toBeNull();
  expect(resumed.sent).toEqual([]);
  expect(await snapshot(run)).toEqual(before);
  return resumed.cli;
}

function warningOf<W extends { readonly code: string }>(
  warnings: readonly W[],
  code: Warning['code'],
): W | undefined {
  return warnings.find((warning) => warning.code === code);
}

/** The `initialize` the latest adapter process received. */
async function lastInitialize(made: Project): Promise<InitializeParams> {
  const starts = (await made.sessions())
    .flatMap((session) => session.requests)
    .filter((request) => request.method === 'initialize')
    .sort((a, b) => a.at - b.at);
  const last = starts.at(-1);
  if (last === undefined) {
    throw new Error('no adapter was started');
  }
  return initializeParamsSchema.parse(last.params);
}

function adapterOf(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { adapter } = config;
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    throw new Error('the project config has no adapter');
  }
  return { ...adapter };
}

async function editText(
  made: Project,
  file: string,
  change: (text: string) => string,
): Promise<() => Promise<void>> {
  const full = path.join(made.root, file);
  const original = await readFile(full, 'utf8');
  await writeFile(full, change(original));
  return () => writeFile(full, original);
}

describe('001 resume of a stopped run', () => {
  let run: StoppedRun;

  beforeAll(async () => {
    run = await stoppedRun();
  }, E2E.timeout);

  it(
    '001 FR-013 resends only unsent and unfinished trials and those that ended in a configuration error (acceptance scenario 2)',
    async () => {
      const effective = effectiveLines(run.first.lines);
      const outcome = (caseId: string): string | undefined => {
        const line = effective.get(trialKey(caseId, 0));
        return line?.status === 'error' ? line.error.kind : line?.status;
      };
      expect([1, 2, 3, 4].map((n) => outcome(`greet-ko-${String(n)}`))).toEqual([
        'ok',
        'adapter',
        'timeout',
        'config',
      ]);
      expect([1, 2, 3, 4].map((n) => outcome(`greet-en-${String(n)}`))).toEqual([
        'ok',
        'permanent',
        'transient',
        undefined,
      ]);

      await run.scenario.edit(withoutConfigFailure);
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      expect([...resumed.sent].sort()).toEqual(
        [trialKey('greet-en-3', 0), trialKey('greet-ko-4', 0), trialKey('greet-en-4', 0)].sort(),
      );

      const after = await readRun(run.project.outputDir, run.runId);
      expect(after.manifest.status).toBe('complete');
      expect(after.manifest.stopReason).toBeUndefined();
      expect(after.trialsText.startsWith(run.first.trialsText)).toBe(true);
      const added = after.lines.slice(run.first.lines.length);
      expect(added.every((line) => line.segment === 2)).toBe(true);
      const attempts = new Map(
        attemptLines(added).map((line) => [trialKey(line.caseId, line.repeat), line.attempt]),
      );
      // Attempt numbers continue, and the transient trial gets only its one remaining retry.
      expect(Object.fromEntries(attempts)).toEqual({
        [trialKey('greet-en-3', 0)]: 2,
        [trialKey('greet-ko-4', 0)]: 2,
        [trialKey('greet-en-4', 0)]: 1,
      });
      expect(after.manifest.segments.map((segment) => segment.segment)).toEqual([1, 2]);
      const [firstSegment, secondSegment] = after.manifest.segments;
      expect(secondSegment).toMatchObject({ concurrency: 1, maxCostUsd: 1 });
      expect(secondSegment?.endedAt).toBeDefined();
      expect(secondSegment?.toolPaths).toEqual(
        expect.arrayContaining(firstSegment?.toolPaths ?? []),
      );
      expect(after.manifest.totals.outcomes).toMatchObject({
        ok: 4,
        adapter: 1,
        permanent: 1,
        timeout: 1,
        transient: 1,
        config: 0,
        stopped: 0,
      });
      const spent = attemptLines(after.lines).reduce((sum, line) => sum + (line.costUsd ?? 0), 0);
      expect(after.manifest.totals.costUsd).toBeCloseTo(spent, 12);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses to resume a complete run',
    async () => {
      const cli = await expectRefused(run);
      expect(cli.stderr).toMatch(/complete/);
    },
    E2E.timeout,
  );
});

describe('001 resume refusals', () => {
  let run: StoppedRun;

  beforeAll(async () => {
    run = await stoppedRun();
  }, E2E.timeout);

  it(
    '001 FR-013 refuses options that set the variant, repeats or cases differently',
    async () => {
      expect((await expectRefused(run, ['--variant', 'next'])).stderr).toMatch(/--variant/);
      await expectRefused(run, ['--repeats', '2']);
      await expectRefused(run, ['--cases', 'greet-ko-*']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses when a case of the manifest is missing from the files or changed',
    async () => {
      const restoreMissing = await editText(run.project, CASES_FILE, () =>
        stringify({ cases: CASES.filter((each) => each.id !== 'greet-en-4') }),
      );
      expect((await expectRefused(run)).stderr).toMatch(/greet-en-4/);
      await restoreMissing();
      const changed: CaseInput[] = CASES.map((each) =>
        each.id === 'greet-en-4' ? { ...each, input: { user: 'something else' } } : each,
      );
      const restoreChanged = await editText(run.project, CASES_FILE, () =>
        stringify({ cases: changed }),
      );
      expect((await expectRefused(run)).stderr).toMatch(/greet-en-4/);
      await restoreChanged();
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses when the prompt or the service code changed (acceptance scenario 3)',
    async () => {
      const original = await readFile(path.join(run.project.root, 'scenario.yaml'), 'utf8');
      const restore = (): Promise<void> =>
        writeFile(path.join(run.project.root, 'scenario.yaml'), original);
      await run.scenario.edit((scenario) => ({
        ...scenario,
        prompts: { ...scenario.prompts, ko: '길게 답한다.' },
      }));
      expect((await expectRefused(run)).stderr).toMatch(/greet-ko-4/);
      await restore();
      await run.scenario.edit((scenario) => ({
        ...scenario,
        service: {
          ...scenario.service,
          treeHash: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        },
      }));
      expect((await expectRefused(run)).stderr).toMatch(/git status --short/);
      await restore();
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses another adapter name, version, helper version or launch settings',
    async () => {
      const original = await readFile(path.join(run.project.root, 'scenario.yaml'), 'utf8');
      const restore = (): Promise<void> =>
        writeFile(path.join(run.project.root, 'scenario.yaml'), original);
      const changes: ((scenario: Scenario) => Scenario)[] = [
        (scenario) => ({ ...scenario, adapter: { ...scenario.adapter, name: 'mock-other' } }),
        (scenario) => ({ ...scenario, adapter: { ...scenario.adapter, version: '1.0.1' } }),
        (scenario) => ({
          ...scenario,
          adapter: { ...scenario.adapter, helper: { language: 'python', version: '0.2.0' } },
        }),
      ];
      for (const change of changes) {
        await run.scenario.edit(change);
        await expectRefused(run);
        await restore();
      }
      const config = await readConfig(run.project);
      await writeConfig(run.project, {
        ...config,
        adapter: { ...adapterOf(config), env: { EXTRA: '1' } },
      });
      await expectRefused(run);
      await writeConfig(run.project, config);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 ends on a broken middle line of trials.jsonl with its line number',
    async () => {
      const file = path.join('.model-eval', 'runs', run.runId, 'trials.jsonl');
      const restore = await editText(run.project, file, (text) => {
        const [first = '', ...rest] = text.split('\n');
        return [first, '{"caseId":', ...rest].join('\n');
      });
      const resumed = await resume(run);
      expect(resumed.cli.code).toBe(4);
      expect(resumed.cli.stderr).toMatch(/line 2\b/);
      expect(resumed.sent).toEqual([]);
      await restore();
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses a lock held by a live process or by another host, except on a dry run',
    async () => {
      const lockPath = path.join(run.project.outputDir, 'runs', run.runId, 'run.lock');
      const startedAt = new Date().toISOString();
      const live = JSON.stringify({ pid: process.pid, host: hostname(), startedAt });
      await writeFile(lockPath, live);
      expect((await expectRefused(run)).stderr).toContain(lockPath);
      // A dry run changes nothing, so it neither takes nor checks the lock.
      const dry = await resume(run, ['--dry-run']);
      expect(dry.cli.code, dry.cli.stderr).toBe(0);
      expect(await readFile(lockPath, 'utf8')).toBe(live);
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, host: `${hostname()}-elsewhere`, startedAt }),
      );
      expect((await expectRefused(run)).stderr).toContain(lockPath);
      await rm(lockPath);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 refuses run --resume on a run that belongs to a swap',
    async () => {
      const made = await project(SPEC);
      await copyScenario(made, 'resume');
      const cli = await made.run([...SWAP, '--json']);
      expect(cli.code, cli.stderr).toBe(4);
      const [baselineRunId] = swapRunOf(parseSwapEnvelope(cli.stdout)).runs;
      const refused = await made.run(['run', '--resume', baselineRunId, '--json']);
      expect(refused.code).toBe(4);
      expect(refused.stderr).toMatch(/swap --resume/);
    },
    E2E.timeout,
  );
});

describe('001 resume warnings', () => {
  it(
    '001 FR-013 resumes and warns when the adapter declares no service version (acceptance scenario 4)',
    async () => {
      const run = await stoppedRun((copy) =>
        copy.edit((scenario) => {
          const { service: _service, ...rest } = scenario;
          return rest;
        }),
      );
      await run.scenario.edit(withoutConfigFailure);
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      const expected = {
        code: 'resume-unverified',
        params: { conditions: ['service-version'] },
        variants: ['current'],
      };
      expect(warningOf(resumed.envelope.warnings, 'resume-unverified')).toEqual(expected);
      const { manifest } = await readRun(run.project.outputDir, run.runId);
      expect(warningOf(manifest.warnings, 'resume-unverified')).toEqual(expected);
      expect(manifest.segments[1]?.resumeWarnings).toEqual([expected]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 keeps the recorded variant, seed, repeats, retries and time limit and leaves out cases only in the files',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      const config = await readConfig(run.project);
      await writeConfig(run.project, {
        ...config,
        variants: [
          { id: 'current', model: MODEL_B },
          { id: 'next', model: MODEL_A },
        ],
        sampling: { repeats: 2, seed: 7 },
        run: { concurrency: 1, retries: 0 },
        adapter: { ...adapterOf(config), timeoutMs: 30_000 },
      });
      const [extra] = greetCases({ en: 5 }).slice(-1);
      await writeFile(
        path.join(run.project.root, CASES_FILE),
        stringify({ cases: [...CASES, extra] }),
      );
      const before = (await run.project.generateRequests()).length;
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      expect(warningOf(resumed.envelope.warnings, 'resume-config-ignored')).toEqual({
        code: 'resume-config-ignored',
        params: { fields: ['variant', 'seed', 'repeats', 'retries', 'timeoutMs'] },
        variants: ['current'],
        caseIds: ['greet-en-5'],
      });
      // The resumed adapter gets the recorded variant and time limit, not the config's.
      const initialize = await lastInitialize(run.project);
      expect(initialize.variant).toMatchObject({ id: 'current', model: MODEL_A });
      expect(initialize.timeoutMs).toBe(run.first.manifest.limits.timeoutMs);
      expect(initialize.timeoutMs).not.toBe(30_000);
      const requests = (await run.project.generateRequests())
        .sort((a, b) => a.at - b.at)
        .slice(before);
      expect(requests.map((request) => request.caseId)).not.toContain('greet-en-5');
      for (const request of requests) {
        expect(request.seed).toBe(trialSeed(request.caseId, request.repeat, GLOBAL_SEED));
      }
      // The recorded retry count gives greet-en-3 its remaining retry although the config says 0,
      // and the recorded single repeat sends no repeat 1.
      expect(requests.map((request) => request.caseId)).toContain('greet-en-3');
      expect(requests.every((request) => request.repeat === 0)).toBe(true);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 never blocks a resume on a rule-only change',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      await writeFile(
        path.join(run.project.root, RULES_FILE),
        stringify({ rules: [ANSWERED, NO_EMOJI] }),
      );
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      const { manifest } = await readRun(run.project.outputDir, run.runId);
      expect(manifest.status).toBe('complete');
    },
    E2E.timeout,
  );
});

describe('001 resume warnings across segments', () => {
  it(
    '001 FR-013 warns when a dirty tree has no treeHash and when the adapter no longer renders',
    async () => {
      const run = await stoppedRun(async (copy, made) => {
        await copy.edit((scenario) => ({
          ...scenario,
          service: { version: '3333333333333333333333333333333333333333', dirty: true },
        }));
        const config = await readConfig(made);
        await writeConfig(made, { ...config, estimate: { inputTokens: 300 } });
      });
      await run.scenario.edit((scenario) => ({
        ...withoutConfigFailure(scenario),
        capabilities: { ...scenario.capabilities, render: false },
      }));
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      expect(warningOf(resumed.envelope.warnings, 'resume-unverified')).toEqual({
        code: 'resume-unverified',
        params: { conditions: ['tree-hash', 'render-fingerprint'] },
        variants: ['current'],
      });
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 sends the adapter every path earlier segments sent besides those the globs match now',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      const oldRules = path.join(run.project.root, RULES_FILE);
      const newRules = path.join(run.project.root, 'more-rules', 'rules.yaml');
      await mkdir(path.dirname(newRules));
      await writeFile(newRules, stringify({ rules: [ANSWERED] }));
      const config = await readConfig(run.project);
      await writeConfig(run.project, {
        ...config,
        files: { rules: 'more-rules/*.yaml', cases: 'cases/**/*.yaml' },
      });
      const resumed = await resume(run);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      const real = (file: string): string => realpathSync.native(file);
      const both = [real(oldRules), real(newRules)];
      expect((await lastInitialize(run.project)).toolPaths.map(real)).toEqual(
        expect.arrayContaining(both),
      );
      const { manifest } = await readRun(run.project.outputDir, run.runId);
      expect(manifest.segments[1]?.toolPaths.map(real)).toEqual(expect.arrayContaining(both));
    },
    E2E.timeout,
  );

  it(
    "001 FR-012 keeps an earlier segment's unpriced-model warning when the resumed segment has a cap",
    async () => {
      const sideCall = {
        model: 'model-side',
        outcome: 'ok',
        branch: 'side',
        usage: { input: 50, output: 5 },
      } as const;
      const withSideCalls =
        (calls: readonly (typeof sideCall)[]) =>
        (scenario: Scenario): Scenario => ({
          ...scenario,
          variants: Object.fromEntries(
            Object.entries(scenario.variants).map(([id, behaviour]) => [
              id,
              { ...behaviour, beforeCalls: [...calls] },
            ]),
          ),
        });
      const run = await stoppedRun(
        (copy) => copy.edit(withSideCalls([sideCall])),
        ['--max-cost-usd', 'none'],
      );
      const expected = {
        code: 'unpriced-model',
        params: { models: ['model-side'] },
        variants: ['current'],
      };
      expect(warningOf(run.first.manifest.warnings, 'unpriced-model')).toEqual(expected);
      await run.scenario.edit((scenario) => withSideCalls([])(withoutConfigFailure(scenario)));
      const resumed = await resume(run, ['--max-cost-usd', '1']);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      const { manifest } = await readRun(run.project.outputDir, run.runId);
      expect(warningOf(manifest.warnings, 'unpriced-model')).toEqual(expected);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 counts stop rates over the trials finished in the current segment',
    async () => {
      const made = await project({
        ...SPEC,
        cases: greetCases({ ko: 30 }),
        config: { sampling: { repeats: 1 }, run: { concurrency: 1, retries: 0 } },
      });
      const copy = await copyScenario(made, 'resume');
      const transient = greetCases({ ko: 20 }).map((each) => each.id);
      const withOutcomes =
        (outcomes: Scenario['variants'][string]['outcomes']) =>
        (scenario: Scenario): Scenario => ({
          ...scenario,
          variants: Object.fromEntries(
            Object.entries(scenario.variants).map(([id, behaviour]) => [
              id,
              { ...behaviour, outcomes },
            ]),
          ),
        });
      await copy.edit(
        withOutcomes([{ row: 'transient', probability: 1, caseIds: transient, message: 'busy' }]),
      );
      const cli = await made.run(['run', '--variant', 'current', '--json']);
      expect(cli.code, cli.stderr).toBe(3);
      const runId = runIdOf(parseRunEnvelope(cli.stdout));
      const first = await readRun(made.outputDir, runId);
      expect(first.manifest.stopReason).toBe('transient-errors');
      // The provider recovered: the errors that stopped segment 1 must not stop segment 2.
      await copy.edit(withOutcomes([]));
      const resumed = await resume({ project: made, scenario: copy, runId, first });
      expect(resumed.cli.code, resumed.cli.stderr).toBe(0);
      expect(resumed.sent).toHaveLength(10);
      const { manifest } = await readRun(made.outputDir, runId);
      expect(manifest.status).toBe('complete');
    },
    E2E.timeout,
  );
});

describe('001 resume and the cost cap', () => {
  it(
    '001 FR-011 ends a resume above the cap with budget-projected and exit code 5 without sending',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      const resumed = await resume(run, ['--max-cost-usd', '0.000001']);
      expect(resumed.cli.code, resumed.cli.stderr).toBe(5);
      expect(resumed.sent).toEqual([]);
      const after = await readRun(run.project.outputDir, run.runId);
      expect(after.manifest).toMatchObject({ status: 'partial', stopReason: 'budget-projected' });
      expect(after.manifest.estimate.projected.at(-1)?.trigger).toBe('resume');
      expect(after.manifest.segments).toHaveLength(2);

      const raised = await resume(run, ['--max-cost-usd', '1']);
      expect(raised.cli.code, raised.cli.stderr).toBe(0);
      expect(raised.sent.length).toBe(3);
      const done = await readRun(run.project.outputDir, run.runId);
      expect(done.manifest.status).toBe('complete');
      expect(done.manifest.segments.map((segment) => segment.maxCostUsd)).toEqual([1, 0.000001, 1]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-013 changes nothing with --dry-run and shows the remaining trials and the re-estimate',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      const before = await snapshot(run);
      const dry = await resume(run, ['--dry-run']);
      expect(dry.cli.code, dry.cli.stderr).toBe(0);
      expect(dry.sent).toEqual([]);
      expect(await snapshot(run)).toEqual(before);
      const plan = dryRunPlanOf(dry.envelope);
      expect(plan.variants.map((entry) => [entry.variant, entry.trials])).toEqual([['current', 3]]);
      expect(plan.conservativeUsd).toBeNull();
      const spent = run.first.manifest.totals.costUsd ?? 0;
      expect(plan.expectedUsd ?? 0).toBeGreaterThan(spent);

      const over = await resume(run, ['--dry-run', '--max-cost-usd', '0.000001']);
      expect(over.cli.code).toBe(5);
      expect(await snapshot(run)).toEqual(before);
    },
    E2E.timeout,
  );

  it(
    '001 FR-011 counts unclosed send lines at their reservation in the dry-run re-estimate',
    async () => {
      const run = await stoppedRun();
      await run.scenario.edit(withoutConfigFailure);
      const expectedUsd = async (): Promise<number> => {
        const dry = await resume(run, ['--dry-run']);
        expect(dry.cli.code, dry.cli.stderr).toBe(0);
        const { expectedUsd: total } = dryRunPlanOf(dry.envelope);
        if (total === null) {
          throw new Error('the re-estimate is unknown');
        }
        return total;
      };
      const without = await expectedUsd();
      const [lastSend] = sendLines(run.first.lines).slice(-1);
      if (lastSend === undefined) {
        throw new Error('the stopped run sent nothing');
      }
      // A kill right after greet-en-4's send line: the attempt never ended.
      const unclosed = { ...lastSend, caseId: 'greet-en-4', attempt: 1 };
      const file = path.join(run.project.outputDir, 'runs', run.runId, 'trials.jsonl');
      await writeFile(file, `${run.first.trialsText}${JSON.stringify(unclosed)}\n`);
      expect((await expectedUsd()) - without).toBeCloseTo(unclosed.reservedUsd ?? Number.NaN, 12);
      expect(await readFile(file, 'utf8')).toBe(
        `${run.first.trialsText}${JSON.stringify(unclosed)}\n`,
      );
    },
    E2E.timeout,
  );
});
