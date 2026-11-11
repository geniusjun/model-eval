import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  startAdapter,
  type AdapterClient,
  type AdapterFault,
  type GenerateOptions,
  type GenerateOutcome,
  type StartOptions,
} from '../../../src/adapter/client.js';
import { adapterChanges } from '../../../src/adapter/identity.js';
import type { GenerateParams, InitializeResult } from '../../../src/adapter/protocol.js';
import { loadProject, type Project } from '../../../src/config/load.js';
import { recordAttempt } from '../../../src/run/attempt.js';
import type { ChargeContext } from '../../../src/run/cost.js';
import type { RunEnd } from '../../../src/run/active-run.js';
import { trialLineSchema, type AttemptLine, type TrialLine } from '../../../src/run/records.js';
import { executeRun, type RunRequest } from '../../../src/run/runner.js';
import { RUN_FILES } from '../../../src/run/writer.js';

// adapter-protocol §Time Limits and Recovery against the mock adapter's fault modes (FR-007,
// FR-008).

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../dist/adapter/mock.js', import.meta.url));
const STDOUT_RESERVED = 'stdout is reserved for the protocol';
/** The tool's time limit in these tests, `initialize` included. */
const TIME_LIMIT_MS = 1000;
const PRICE = { input: 1, output: 2 };
const CONTEXT: ChargeContext = {
  pricing: { 'model-b': PRICE },
  variantModel: 'model-b',
  tokens: { input: 400, output: 100 },
  billedCalls: 1,
};
const RESERVATION_USD = (400 * PRICE.input + 100 * PRICE.output) / 1_000_000;
/** Each test waits out a few time limits. */
const SLOW = { timeout: 10 * TIME_LIMIT_MS } as const;

function scenario(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/mock/${name}.yaml`, import.meta.url));
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'model-eval-faults-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

interface Watched {
  readonly client: AdapterClient;
  readonly faults: AdapterFault[];
  /** `mock: started` lines, one per process the client started. */
  readonly starts: () => number;
  readonly stderr: string[];
}

function options(name: string, overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    launch: {
      command: [process.execPath, MOCK, scenario(name)],
      cwd: ROOT,
      env: { MOCK_STATE_DIR: stateDir },
    },
    initialize: {
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: TIME_LIMIT_MS,
      toolPaths: [ROOT],
    },
    concurrency: 4,
    ...overrides,
  };
}

/** A started client that restarts after losses, with its faults and stderr collected. */
async function supervised(
  name: string,
  overrides: Partial<StartOptions> = {},
  onFault: (fault: AdapterFault) => void = () => undefined,
  toolPaths: () => Promise<readonly string[]> = () => Promise.resolve([ROOT, stateDir]),
): Promise<Watched> {
  const stderr: string[] = [];
  const result = await startAdapter({
    ...options(name, overrides),
    onStderr: (line) => stderr.push(line),
  });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const faults: AdapterFault[] = [];
  result.client.supervise({
    toolPaths,
    onFault: (fault) => {
      faults.push(fault);
      onFault(fault);
    },
  });
  return {
    client: result.client,
    faults,
    stderr,
    starts: () => stderr.filter((line) => line.startsWith('mock: started')).length,
  };
}

function trial(caseId: string, seed = 7): GenerateParams {
  return { target: 'chat', input: { user: 'hi' }, caseId, repeat: 0, seed };
}

const kindOf = (outcome: GenerateOutcome): string => outcome.kind;

/** A promise and the function that settles it, for waiting on a callback. */
function signal<T = void>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

// The tool's time limits run on fake timers, so these tests never race the clock; the mock and
// the pipes run in real time.
describe('abandoned requests', SLOW, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Sends one request and passes one time limit once it is out. */
  async function abandoned(
    client: AdapterClient,
    caseId: string,
    options: GenerateOptions = {},
  ): Promise<GenerateOutcome> {
    const sent = signal<number>();
    const outcome = client.generate(trial(caseId), {
      ...options,
      onRequest: (id) => {
        options.onRequest?.(id);
        sent.settle(id);
      },
    });
    await sent.promise;
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);
    return outcome;
  }

  it('001 FR-008 abandons a request at adapter.timeoutMs and holds its slot until the late response', async () => {
    const { client } = await supervised('fault-late');
    expect(client.concurrency).toBe(1);
    const events: string[] = [];
    const late = signal<GenerateOutcome>();
    const outcome = await abandoned(client, 'late-1', {
      onLate: (response) => {
        events.push('late response');
        late.settle(response);
      },
    });
    expect(outcome).toEqual({
      kind: 'timed-out',
      message: `no response to generate within ${String(TIME_LIMIT_MS)} ms`,
    });
    const next = client.generate(trial('fast-1'), {
      onRequest: () => events.push('next request'),
    });
    expect(await late.promise).toMatchObject({
      kind: 'result',
      value: { raw: 'answer to late-1', calls: [{ model: 'model-b', outcome: 'ok' }] },
    });
    expect(kindOf(await next)).toBe('result');
    // The only slot stayed with the abandoned request, so the next one waited for its answer.
    expect(events).toEqual(['late response', 'next request']);
    await client.shutdown();
  });

  it('001 FR-008 sends cancel for an abandoned request when the adapter declares it, and passes on the response it stopped with', async () => {
    const { client, stderr } = await supervised('fault-cancel');
    const late = signal<GenerateOutcome>();
    let id: number | undefined;
    const outcome = await abandoned(client, 'hang-1', {
      onRequest: (sent) => {
        id = sent;
      },
      onLate: late.settle,
    });
    expect(kindOf(outcome)).toBe('timed-out');
    expect(await late.promise).toMatchObject({
      kind: 'result',
      value: {
        calls: [
          { outcome: 'failed', errorKind: 'transient', retryAfterMs: 2000 },
          { outcome: 'ok', usage: { input: 100, output: 20 } },
        ],
      },
    });
    expect(stderr).toContain(`mock: cancel ${String(id)}`);
    await client.shutdown();
  });

  it('001 FR-008 sends no cancel when the adapter does not declare it', async () => {
    const { client, stderr } = await supervised('fault-late');
    expect(kindOf(await abandoned(client, 'late-1'))).toBe('timed-out');
    expect(kindOf(await client.generate(trial('fast-1')))).toBe('result');
    expect(stderr.some((line) => line.startsWith('mock: cancel'))).toBe(false);
    await client.shutdown();
  });

  it('001 FR-008 restarts the adapter when every slot holds an abandoned request for another time limit', async () => {
    const restarting = signal();
    const { client, faults, starts } = await supervised('fault-hang', {}, (fault) => {
      if (fault.kind === 'restarting') {
        restarting.settle();
      }
    });
    expect(client.concurrency).toBe(2);
    const first = signal();
    const second = signal();
    const outcomes = Promise.all([
      client.generate(trial('hang-1'), {
        onRequest: () => {
          first.settle();
        },
      }),
      client.generate(trial('hang-2'), {
        onRequest: () => {
          second.settle();
        },
      }),
    ]);
    await Promise.all([first.promise, second.promise]);
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);
    expect((await outcomes).map(kindOf)).toEqual(['timed-out', 'timed-out']);
    expect(faults).toEqual([]);
    await vi.advanceTimersByTimeAsync(TIME_LIMIT_MS);
    await restarting.promise;
    expect(faults[0]).toMatchObject({ kind: 'restarting', cause: 'stuck' });

    expect(kindOf(await client.generate(trial('ok-1')))).toBe('result');
    expect(starts()).toBe(2);
    expect(faults[1]).toEqual({ kind: 'restarted', toolPaths: [ROOT, stateDir] });
    await client.shutdown();
  });

  it('001 FR-008 keeps a slot whose abandoned request is still running from restarting the adapter', async () => {
    const { client, faults, starts } = await supervised('fault-hang');
    expect(kindOf(await abandoned(client, 'hang-1'))).toBe('timed-out');
    await vi.advanceTimersByTimeAsync(3 * TIME_LIMIT_MS);
    expect(kindOf(await client.generate(trial('ok-1')))).toBe('result');
    expect(faults).toEqual([]);
    expect(starts()).toBe(1);
    await client.shutdown();
  });
});

describe('lost adapter processes', SLOW, () => {
  it('001 FR-008 restarts after the process dies; requests in flight are lost', async () => {
    const { client, faults, starts } = await supervised('fault-crash');
    const held = signal();
    const inFlight = client.generate(trial('held-1'), {
      onRequest: () => {
        held.settle();
      },
    });
    await held.promise;
    const crashed = await client.generate(trial('crash-1'));
    const exited = {
      kind: 'lost',
      message: expect.stringContaining('the adapter exited') as unknown,
    };
    expect(crashed).toMatchObject(exited);
    expect(await inFlight).toMatchObject(exited);
    expect(faults[0]).toMatchObject({ kind: 'restarting', cause: 'exit' });

    expect(kindOf(await client.generate(trial('ok-2')))).toBe('result');
    expect(starts()).toBe(2);
    await client.shutdown();
  });

  it('001 FR-008 restarts after non-JSON stdout and reports its first 200 characters', async () => {
    const { client, faults, starts } = await supervised('fault-noise');
    const outcome = await client.generate(trial('noisy-1'));
    expect(outcome.kind).toBe('lost');
    if (outcome.kind !== 'lost') {
      return;
    }
    const printed = 'debug: building the prompt for noisy-1 0123456789';
    expect(outcome.message).toContain(STDOUT_RESERVED);
    expect(outcome.message).toContain(printed);
    expect(outcome.message).not.toContain('END');
    const shown = outcome.message.slice(outcome.message.indexOf('debug:'));
    expect(shown).toHaveLength(200);
    expect(faults[0]).toMatchObject({ kind: 'restarting', cause: 'violation' });

    expect(kindOf(await client.generate(trial('ok-1')))).toBe('result');
    expect(starts()).toBe(2);
    await client.shutdown();
  });

  it('001 FR-008 starts no process after the third loss in a row', async () => {
    const { client, faults, starts } = await supervised('fault-crash');
    for (let round = 0; round < 3; round += 1) {
      expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    }
    expect(faults.map((fault) => fault.kind)).toEqual([
      'restarting',
      'restarted',
      'restarting',
      'restarted',
      'crashed',
    ]);
    expect(faults.at(-1)).toMatchObject({ kind: 'crashed', cause: 'exit' });
    // Nothing reaches an adapter any more, so the request is refused, not lost in flight.
    expect(await client.generate(trial('ok-1'))).toMatchObject({ kind: 'refused' });
    expect(starts()).toBe(3);
    await client.shutdown();
  });

  it('001 FR-008 counts losses in a row only until a process answers', async () => {
    const { client, faults } = await supervised('fault-crash');
    for (let round = 0; round < 3; round += 1) {
      expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
      expect(kindOf(await client.generate(trial('ok-1')))).toBe('result');
    }
    expect(faults.some((fault) => fault.kind === 'crashed')).toBe(false);
    await client.shutdown();
  });

  it('001 FR-013 ends a process the adapter left in its group after the adapter itself exited', async () => {
    // The adapter starts a helper that keeps running and holds its output pipes, then runs the
    // mock, which exits after `shutdown`.
    const pidFile = path.join(stateDir, 'helper.pid');
    const wrapper = path.join(stateDir, 'leaves-helper.mjs');
    await writeFile(
      wrapper,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "import { pathToFileURL } from 'node:url';",
        'const [pidFile, mock, scenarioFile] = process.argv.slice(2);',
        "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {",
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        '});',
        'writeFileSync(pidFile, String(helper.pid));',
        // The adapter does not wait for its helper, so it exits after `shutdown`.
        'helper.unref();',
        'process.argv = [process.argv[0], mock, scenarioFile];',
        'await import(pathToFileURL(mock).href);',
      ].join('\n'),
    );
    const base = options('fault-version');
    const started = await startAdapter({
      ...base,
      launch: {
        ...base.launch,
        command: [process.execPath, wrapper, pidFile, MOCK, scenario('fault-version')],
      },
      shutdownGraceMs: 200,
    });
    if (!started.ok) {
      throw new Error(started.error.message);
    }
    const helper = Number(await readFile(pidFile, 'utf8'));
    const ended = await started.client.shutdown();
    expect(ended.answered).toBe(true);
    expect(ended.forced).toBe(true);
    expect(() => process.kill(helper, 0)).toThrow();
  });

  it('001 FR-008 refuses a restarted adapter that declares another version', async () => {
    const { client, faults } = await supervised('fault-version');
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    expect(await client.generate(trial('ok-1'))).toEqual({
      kind: 'refused',
      message: 'the restarted adapter declares a different adapter-version',
    });
    expect(faults.map((fault) => fault.kind)).toEqual(['restarting', 'restart-changed']);
    expect(faults[1]).toEqual({ kind: 'restart-changed', changes: ['adapter-version'] });
    const exit = await client.shutdown();
    expect(exit.answered).toBe(true);
  });

  it('001 FR-013 keeps a restarted adapter that declares no service version, since that cannot be verified', async () => {
    const { client, faults } = await supervised('fault-version-unknown');
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    expect(kindOf(await client.generate(trial('ok-1')))).toBe('result');
    expect(faults.map((fault) => fault.kind)).toEqual(['restarting', 'restarted']);
    await client.shutdown();
  });

  it('001 FR-008 compares service code by treeHash when present, else by version and dirty flag', () => {
    const base: InitializeResult = {
      protocolVersion: '1',
      adapter: { name: 'a', version: '1', helper: { language: 'python', version: '0.1.0' } },
      service: { version: 'c1', dirty: false, treeHash: `sha256:${'a'.repeat(64)}` },
      targets: [{ name: 'chat', inputSchema: {} }],
      capabilities: { render: false, stages: false, postprocess: true, cancel: false },
    };
    const newCommitSameTree = { ...base, service: { ...base.service, version: 'c2' } };
    expect(adapterChanges(base, newCommitSameTree)).toEqual([]);
    const otherTree = {
      ...base,
      service: { ...base.service, treeHash: `sha256:${'b'.repeat(64)}` },
    };
    expect(adapterChanges(base, otherTree)).toEqual(['service']);
    const noTree = { ...base, service: { version: 'c1', dirty: false } };
    expect(adapterChanges(noTree, { ...noTree, service: { version: 'c1', dirty: true } })).toEqual([
      'service',
    ]);
    expect(adapterChanges(noTree, noTree)).toEqual([]);
    // treeHash on one side only cannot be compared, so version and dirty flag decide.
    expect(adapterChanges(base, noTree)).toEqual([]);
    expect(adapterChanges(noTree, base)).toEqual([]);
    expect(adapterChanges(base, { ...noTree, service: { version: 'c2', dirty: false } })).toEqual([
      'service',
    ]);
    // A version missing on either side cannot be verified, which is not a change (§Resume 6).
    const unknown = { ...base, service: {} };
    expect(adapterChanges(noTree, unknown)).toEqual([]);
    expect(adapterChanges(unknown, noTree)).toEqual([]);
    const { service: _service, ...undeclared } = base;
    expect(adapterChanges(noTree, undeclared)).toEqual([]);
    const helper = {
      ...base,
      adapter: { ...base.adapter, helper: { language: 'python', version: '0.2.0' } },
    };
    expect(adapterChanges(base, helper)).toEqual(['helper-version']);
    const version = { ...base, adapter: { ...base.adapter, version: '2' } };
    expect(adapterChanges(base, version)).toEqual(['adapter-version']);
  });

  it('001 FR-008 counts a restarted process that dies at once as a loss, so restarts end after three', async () => {
    const { client, faults, starts } = await supervised('fault-restart-dies');
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    const outcomes: string[] = [];
    for (let round = 0; round < 4 && outcomes.at(-1) !== 'refused'; round += 1) {
      outcomes.push(kindOf(await client.generate(trial('ok-1'))));
    }
    expect(outcomes.at(-1)).toBe('refused');
    expect(faults.at(-1)).toMatchObject({ kind: 'crashed', cause: 'exit' });
    expect(faults.filter((fault) => fault.kind !== 'restarted')).toHaveLength(3);
    expect(starts()).toBe(3);
    await client.shutdown();
  });

  it('001 FR-008 reports a restarted adapter that does not start, and refuses every later request', async () => {
    const { client, faults } = await supervised('fault-restart-fails');
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    expect(kindOf(await client.generate(trial('ok-1')))).toBe('refused');
    expect(faults.map((fault) => fault.kind)).toEqual(['restarting', 'restart-failed']);
    expect(faults[1]).toMatchObject({ kind: 'restart-failed', error: { kind: 'exited' } });
    expect(kindOf(await client.generate(trial('ok-2')))).toBe('refused');
    await client.shutdown();
  });

  it('001 FR-008 turns a restart whose toolPaths cannot be listed into restart-failed and frees every slot', async () => {
    const { client, faults } = await supervised('fault-crash', {}, undefined, () =>
      Promise.reject(new Error('EACCES: rules/secret.yaml')),
    );
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    const outcomes = await Promise.all(
      ['ok-1', 'ok-2', 'ok-3', 'ok-4', 'ok-5'].map((caseId) => client.generate(trial(caseId))),
    );
    expect(outcomes.map(kindOf)).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']);
    expect(faults[1]).toEqual({
      kind: 'restart-failed',
      error: {
        kind: 'tool-paths-failed',
        message: 'the toolPaths of the restart could not be listed: EACCES: rules/secret.yaml',
      },
    });
    await client.shutdown();
  });

  it('001 FR-008 shuts the adapter down without restarting it when no generate follows a loss', async () => {
    const { client, faults, starts } = await supervised('fault-crash');
    expect(kindOf(await client.generate(trial('crash-1')))).toBe('lost');
    const exit = await client.shutdown();
    expect(exit.answered).toBe(false);
    expect(starts()).toBe(1);
    expect(faults.map((fault) => fault.kind)).toEqual(['restarting']);
  });
});

describe('attempt lines of faults', () => {
  const base = { caseId: 'c', repeat: 0, attempt: 1, segment: 1, seed: 7 };

  it('001 FR-008 records a request abandoned at the time limit as an adapter error charged its reservation', () => {
    const { line } = recordAttempt(
      base,
      { kind: 'timed-out', message: 'no response to generate within 1000 ms' },
      CONTEXT,
    );
    expect(line).toEqual({
      ...base,
      status: 'error',
      error: {
        kind: 'adapter',
        message: 'no response to generate within 1000 ms',
        abandoned: 'timeout',
      },
      costUsd: RESERVATION_USD,
      costEstimated: true,
    });
  });

  it('001 FR-008 records a request lost to a restart as abandoned with restart and its message', () => {
    const message = `${STDOUT_RESERVED}; the adapter wrote: debug: hello`;
    const { line } = recordAttempt(base, { kind: 'lost', message }, CONTEXT);
    expect(line).toMatchObject({
      status: 'error',
      error: { kind: 'adapter', message, abandoned: 'restart' },
      costUsd: RESERVATION_USD,
      costEstimated: true,
    });
  });

  it('001 FR-008 records a request that never reached an adapter as stopped, charged nothing', () => {
    const { line, charge } = recordAttempt(
      base,
      { kind: 'refused', message: 'the restarted adapter declares a different adapter-version' },
      CONTEXT,
    );
    // An empty `calls` says no model was called, so the attempt counts no billed call.
    expect(line).toEqual({ ...base, status: 'stopped', costUsd: 0, calls: [] });
    expect(charge.costUsd).toBe(0);
  });

  it('001 FR-008 records a result without required fields, a JSON-RPC error and answers 0 with model as adapter errors', async () => {
    const { client } = await supervised('fault-replies');
    const missing = await client.generate(trial('missing-1'));
    expect(missing).toMatchObject({ kind: 'invalid' });
    expect(recordAttempt(base, missing, CONTEXT).line).toMatchObject({
      status: 'error',
      error: { kind: 'adapter', message: expect.stringContaining('raw') as unknown },
    });

    const rpc = await client.generate(trial('rpc-1'));
    expect(rpc).toMatchObject({ kind: 'rpc-error', message: "KeyError: 'profile'" });
    const priced = { ...CONTEXT, pricing: { 'model-b': PRICE } };
    expect(recordAttempt(base, rpc, priced).line).toEqual({
      ...base,
      status: 'error',
      error: { kind: 'adapter', message: "KeyError: 'profile'", capturedRaw: 'answer to rpc-1' },
      costUsd: (100 * PRICE.input + 20 * PRICE.output) / 1_000_000,
      calls: [
        { model: 'model-b', outcome: 'ok', branch: 'answer', usage: { input: 100, output: 20 } },
      ],
    });
    await client.shutdown();

    const zero = await startAdapter({
      ...options('basic'),
      launch: {
        command: scriptedZeroAnswers(),
        cwd: ROOT,
        env: {},
      },
    });
    if (!zero.ok) {
      throw new Error(zero.error.message);
    }
    const outcome = await zero.client.generate(trial('zero-1'));
    expect(outcome.kind).toBe('invalid');
    expect(recordAttempt(base, outcome, CONTEXT).line).toMatchObject({
      status: 'error',
      error: { kind: 'adapter', message: expect.stringContaining('answers') as unknown },
    });
    await zero.client.shutdown();
  });
});

/** An adapter that reports a model answer shipped although the service received no answer. */
function scriptedZeroAnswers(): string[] {
  const script = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    "rl.on('line', (line) => { const m = JSON.parse(line);",
    "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '1', adapter: { name: 'zero', version: '0' }, targets: [{ name: 'chat', inputSchema: {} }] } });",
    "  if (m.method === 'generate') send({ id: m.id, result: { raw: '', answers: 0, finalKind: 'model', final: 'hi', latencyMs: 1, finishReason: 'stop' } });",
    "  if (m.method === 'shutdown') { send({ id: m.id, result: null }); rl.close(); }",
    '});',
  ].join('\n');
  return [process.execPath, '-e', script];
}

interface RunProjectOptions {
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** `budget.maxCostUsd`; no cap unless set. */
  readonly maxCostUsd?: number;
  readonly concurrency?: number;
}

/** A project of four cases, `chat-ko-01` first in send order, run once with variant `next`. */
async function runProject(options: RunProjectOptions): Promise<Project> {
  const root = path.join(stateDir, 'project');
  await mkdir(path.join(root, 'rules'), { recursive: true });
  await mkdir(path.join(root, 'cases'));
  const config = {
    version: 1,
    adapter: { command: options.command, env: options.env ?? {}, timeoutMs: TIME_LIMIT_MS },
    files: { rules: 'rules/*.yaml', cases: 'cases/*.yaml' },
    variants: [{ id: 'next', model: 'model-b' }],
    pricing: { 'model-b': PRICE },
    sampling: { repeats: 1, seed: 1729 },
    run: { concurrency: options.concurrency ?? 2 },
    budget: { maxCostUsd: options.maxCostUsd ?? null },
    estimate: { inputTokens: 400, outputTokens: 50 },
  };
  const rule = (id: string) => ({
    id,
    title: 'Answers',
    severity: 'blocking',
    scope: 'global',
    check: { type: 'completed' },
  });
  const cases = ['ko', 'ja'].flatMap((lang) =>
    [1, 2].map((index) => ({
      id: `chat-${lang}-0${String(index)}`,
      target: 'chat',
      lang,
      provenance: 'synthetic',
      input: { user: 'hi' },
    })),
  );
  await writeFile(path.join(root, 'model-eval.config.yaml'), JSON.stringify(config));
  await writeFile(
    path.join(root, 'rules', 'rules.yaml'),
    JSON.stringify({ rules: [rule('answered')] }),
  );
  await writeFile(
    path.join(root, 'rules', 'gone.yaml'),
    JSON.stringify({ rules: [rule('answered-2')] }),
  );
  await writeFile(path.join(root, 'cases', 'cases.yaml'), JSON.stringify({ cases }));
  const loaded = await loadProject('model-eval.config.yaml', root);
  if (!loaded.ok) {
    throw new Error(JSON.stringify(loaded.diagnostics));
  }
  return loaded.project;
}

async function runToEnd(project: Project, overrides: Partial<RunRequest> = {}): Promise<RunEnd> {
  const variant = project.config.data.variants[0];
  if (variant === undefined) {
    throw new Error('no variant');
  }
  const result = await executeRun({
    project,
    variant,
    repeats: 1,
    caseFilter: null,
    concurrency: project.config.data.run.concurrency,
    maxCostUsd: project.config.data.budget.maxCostUsd,
    tool: { name: 'model-eval', version: '0.0.0-test' },
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.failure));
  }
  return result.end;
}

function attemptsOf(end: RunEnd, caseId: string): AttemptLine[] {
  return end.lines.flatMap((line) => ('status' in line && line.caseId === caseId ? [line] : []));
}

/**
 * A throwaway adapter for `chat` in ko and ja that answers every case with no model call, except
 * that `chat-ko-01` waits for `cancel` and then answers with the JSON of `LATE_REPLY`, or never
 * when it is unset. `CONFIG_CASE` names a case answered with a `config` failure.
 */
function scriptedLate(cancel: boolean): string[] {
  const script = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    'const held = new Set();',
    "const answer = { raw: 'ok', finalKind: 'model', final: 'ok', latencyMs: 1, finishReason: 'stop', calls: [] };",
    "rl.on('line', (line) => { const m = JSON.parse(line);",
    `  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '1', adapter: { name: 'late', version: '0' }, targets: [{ name: 'chat', languages: ['ko', 'ja'], inputSchema: {} }], capabilities: { cancel: ${String(cancel)}, maxConcurrency: 2 } } });`,
    "  if (m.method === 'generate' && m.params.caseId === 'chat-ko-01') held.add(m.id);",
    "  else if (m.method === 'generate' && m.params.caseId === process.env.CONFIG_CASE) send({ id: m.id, result: { error: { kind: 'config', message: '401 invalid api key' }, calls: [] } });",
    "  else if (m.method === 'generate') send({ id: m.id, result: answer });",
    "  if (m.method === 'cancel' && held.delete(m.params.id) && process.env.LATE_REPLY) send({ id: m.params.id, result: JSON.parse(process.env.LATE_REPLY) });",
    "  if (m.method === 'shutdown') { send({ id: m.id, result: null }); rl.close(); }",
    '});',
  ].join('\n');
  return [process.execPath, '-e', script];
}

describe('stops in a run', SLOW, () => {
  const modelAnswer = {
    raw: 'late',
    finalKind: 'model',
    final: 'late',
    latencyMs: 1,
    finishReason: 'stop',
  };

  it('001 FR-008 a late failure result of kind config stops the run as config-error, even without calls', async () => {
    const late = { error: { kind: 'config', message: '401 invalid api key' }, latencyMs: 1 };
    const project = await runProject({
      command: scriptedLate(true),
      env: { LATE_REPLY: JSON.stringify(late) },
    });
    const end = await runToEnd(project);
    expect(end).toMatchObject({ status: 'partial', stopReason: 'config-error' });
    expect(attemptsOf(end, 'chat-ko-01')).toMatchObject([
      { status: 'error', error: { kind: 'adapter', abandoned: 'timeout' } },
    ]);
  });

  it('001 FR-008 a late response with a config call or a call to an unpriced model under a cap stops the run as config-error', async () => {
    const replies = [
      { ...modelAnswer, calls: [{ model: 'model-b', outcome: 'failed', errorKind: 'config' }] },
      {
        ...modelAnswer,
        calls: [{ model: 'model-x', outcome: 'ok', usage: { input: 10, output: 1 } }],
      },
    ];
    for (const [index, reply] of replies.entries()) {
      await rm(path.join(stateDir, 'project'), { recursive: true, force: true });
      const project = await runProject({
        command: scriptedLate(true),
        env: { LATE_REPLY: JSON.stringify(reply) },
        maxCostUsd: 1,
      });
      const end = await runToEnd(project);
      expect(end, String(index)).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      // The late response never changes the trial: it stays abandoned at the time limit.
      expect(attemptsOf(end, 'chat-ko-01')).toMatchObject([
        { status: 'error', error: { kind: 'adapter', abandoned: 'timeout' } },
      ]);
    }
  });

  it('001 FR-008 abandons a request at the time limit while the run is stopping, instead of marking it stopped', async () => {
    const project = await runProject({
      command: scriptedLate(false),
      env: { CONFIG_CASE: 'chat-ja-01' },
    });
    const end = await runToEnd(project);
    expect(end).toMatchObject({ status: 'partial', stopReason: 'config-error' });
    expect(attemptsOf(end, 'chat-ja-01')).toMatchObject([
      { status: 'error', error: { kind: 'config' } },
    ]);
    expect(attemptsOf(end, 'chat-ko-01')).toMatchObject([
      { status: 'error', error: { kind: 'adapter', abandoned: 'timeout' }, costEstimated: true },
    ]);
  });

  it('001 FR-008 sends a restarted adapter the paths sent before and those the globs match again, and records them', async () => {
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
      'let rules;',
      "rl.on('line', (line) => { const m = JSON.parse(line);",
      "  if (m.method === 'initialize') { rules = path.join(path.dirname(m.params.toolPaths[0]), 'rules'); process.stderr.write('toolPaths ' + JSON.stringify(m.params.toolPaths) + '\\n'); send({ id: m.id, result: { protocolVersion: '1', adapter: { name: 'paths', version: '0' }, targets: [{ name: 'chat', languages: ['ko', 'ja'], inputSchema: {} }], capabilities: { maxConcurrency: 1 } } }); }",
      "  if (m.method === 'generate' && !fs.existsSync(path.join(rules, 'extra.yaml'))) { fs.writeFileSync(path.join(rules, 'extra.yaml'), 'rules: []\\n'); fs.rmSync(path.join(rules, 'gone.yaml')); process.exit(1); }",
      "  else if (m.method === 'generate') send({ id: m.id, result: { raw: 'ok', finalKind: 'model', final: 'ok', latencyMs: 1, finishReason: 'stop', calls: [] } });",
      "  if (m.method === 'shutdown') { send({ id: m.id, result: null }); rl.close(); }",
      '});',
    ].join('\n');
    const project = await runProject({ command: [process.execPath, '-e', script], concurrency: 1 });
    const sent: string[][] = [];
    const end = await runToEnd(project, {
      onStderr: (line) => {
        if (line.startsWith('toolPaths ')) {
          sent.push(z.array(z.string()).parse(JSON.parse(line.slice('toolPaths '.length))));
        }
      },
    });
    const rules = path.join(project.paths.configDir, 'rules');
    const [first, restarted] = sent;
    expect(sent).toHaveLength(2);
    expect(first).toEqual([
      project.paths.configFile,
      path.join(rules, 'gone.yaml'),
      path.join(rules, 'rules.yaml'),
      path.join(project.paths.configDir, 'cases', 'cases.yaml'),
      project.paths.outputDir,
    ]);
    expect(restarted).toEqual([...(first ?? []), path.join(rules, 'extra.yaml')]);
    expect(end.manifest.segments[0]?.toolPaths).toEqual(restarted);
    expect(attemptsOf(end, 'chat-ko-01')).toMatchObject([
      { status: 'error', error: { kind: 'adapter', abandoned: 'restart' } },
    ]);
  });
});

describe('late responses in a run', SLOW, () => {
  it('001 FR-007 a late response corrects cost only: a late cost line, no grade, and the abandoned-trials warning', async () => {
    const end = await runToEnd(
      await runProject({ command: [process.execPath, MOCK, scenario('fault-run-late')] }),
    );
    const text = await readFile(path.join(end.runDir, RUN_FILES.trials), 'utf8');
    const lines: TrialLine[] = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => trialLineSchema.parse(JSON.parse(line)));
    const ofCase = lines.filter((line) => 'caseId' in line && line.caseId === 'chat-ko-01');
    const [send, attempt, late] = ofCase;
    expect(ofCase).toHaveLength(3);
    const reservedUsd = send !== undefined && 'sending' in send ? send.reservedUsd : null;
    expect(reservedUsd).toBeGreaterThan(0);
    expect(attempt).toMatchObject({
      status: 'error',
      error: { kind: 'adapter', abandoned: 'timeout' },
      costUsd: reservedUsd,
      costEstimated: true,
    });
    const lateUsd = (30000 * PRICE.input + 5000 * PRICE.output) / 1_000_000;
    expect(late).toMatchObject({
      caseId: 'chat-ko-01',
      repeat: 0,
      attempt: 1,
      source: 'late',
      usage: { input: 30000, output: 5000 },
      costCorrection: true,
    });
    expect(late !== undefined && 'source' in late ? late.costUsd : null).toBeCloseTo(
      lateUsd - (reservedUsd ?? 0),
      12,
    );
    expect(end.manifest.totals.outcomes.adapter).toBe(1);
    expect(end.status).toBe('complete');
    const grades = end.gradeSet.grades.filter((grade) => grade.caseId === 'chat-ko-01');
    expect(grades.map((grade) => grade.outcome)).toEqual(['skip', 'skip']);
    expect(end.manifest.warnings).toContainEqual({
      code: 'abandoned-trials',
      variants: ['next'],
      params: {
        trials: { next: { timeout: 1, restart: 0 } },
        timeoutMs: { next: TIME_LIMIT_MS },
        lateFailures: { next: { transient: { trials: 1, maxRetryAfterMs: 2000 } } },
      },
    });
  });
});
