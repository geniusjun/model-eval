import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LogParams } from '../../../src/adapter/protocol.js';
import { loadProject, type Project } from '../../../src/config/load.js';
import { gradeSetPath, readGradeSet } from '../../../src/grade/grade-set.js';
import { trialSeed } from '../../../src/run/ids.js';
import { manifestSchema, type Manifest } from '../../../src/run/manifest.js';
import { trialLineSchema, type TrialLine } from '../../../src/run/records.js';
import { executeRun, type RunRequest, type RunResult } from '../../../src/run/runner.js';
import { executeSwap } from '../../../src/run/swap.js';
import { RUN_FILES } from '../../../src/run/writer.js';

const MOCK = fileURLToPath(new URL('../../../dist/adapter/mock.js', import.meta.url));
const TOOL = { name: 'model-eval', version: '0.0.0-test' };
const PRICE = { input: 1, cachedInput: 0.1, output: 2 };

function scenario(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/mock/${name}.yaml`, import.meta.url));
}

/**
 * A throwaway adapter answering `initialize` and `shutdown`; `onGenerate` answers each `generate`
 * request `m` with `send`, and `setup` runs first. `out` is the output directory.
 */
function scripted(onGenerate: string, setup = ''): readonly string[] {
  const script = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    'let out;',
    setup,
    "rl.on('line', (line) => { const m = JSON.parse(line);",
    "  if (m.method === 'initialize') { out = m.params.toolPaths.at(-1); send({ id: m.id, result: { protocolVersion: '1', adapter: { name: 'scripted', version: '0' }, targets: [{ name: 'chat', languages: ['ko', 'ja'], inputSchema: {} }], capabilities: { maxConcurrency: 2 } } }); }",
    `  if (m.method === 'generate') { ${onGenerate} }`,
    "  if (m.method === 'shutdown') { send({ id: m.id, result: null }); rl.close(); }",
    '});',
  ].join('\n');
  return [process.execPath, '-e', script];
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'model-eval-runner-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface ProjectOptions {
  readonly command?: readonly string[];
  readonly casesPerLang?: number;
  readonly repeats?: number;
  readonly concurrency?: number;
  readonly retries?: number;
  readonly maxCostUsd?: number | null;
  readonly outputTokens?: number;
  readonly inputTokens?: number;
}

function caseIds(lang: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `chat-${lang}-${String(index + 1).padStart(2, '0')}`,
  );
}

/** A config, a rules file and one case file per language; JSON is YAML. */
async function project(name: string, options: ProjectOptions = {}): Promise<Project> {
  const count = options.casesPerLang ?? 2;
  const config = {
    version: 1,
    adapter: {
      command: options.command ?? [process.execPath, MOCK, scenario(name)],
      timeoutMs: 10_000,
    },
    variants: [
      { id: 'current', model: 'model-a' },
      { id: 'next', model: 'model-b' },
    ],
    pricing: { 'model-a': PRICE, 'model-b': PRICE },
    sampling: { repeats: options.repeats ?? 2, seed: 1729 },
    run: { concurrency: options.concurrency ?? 2, retries: options.retries ?? 2 },
    budget: { maxCostUsd: options.maxCostUsd === undefined ? 1 : options.maxCostUsd },
    estimate: {
      outputTokens: options.outputTokens ?? 50,
      ...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
    },
    gate: { severities: ['blocking'] },
  };
  const rules = {
    rules: [
      {
        id: 'completed',
        title: 'Answers',
        severity: 'blocking',
        scope: 'global',
        check: { type: 'completed' },
      },
      {
        id: 'no-emoji',
        title: 'No emoji',
        severity: 'major',
        scope: 'global',
        check: { type: 'emoji' },
      },
    ],
  };
  await mkdir(path.join(root, 'rules'));
  await mkdir(path.join(root, 'cases'));
  await writeFile(path.join(root, 'model-eval.config.yaml'), JSON.stringify(config));
  await writeFile(path.join(root, 'rules', 'base.yaml'), JSON.stringify(rules));
  for (const lang of ['ko', 'ja']) {
    const cases = caseIds(lang, count).map((id) => ({
      id,
      target: 'chat',
      lang,
      provenance: 'synthetic',
      input: { user: `hello from ${id}` },
    }));
    await writeFile(path.join(root, 'cases', `${lang}.yaml`), JSON.stringify({ cases }));
  }
  const loaded = await loadProject('model-eval.config.yaml', root);
  if (!loaded.ok) {
    throw new Error(JSON.stringify(loaded.diagnostics));
  }
  return loaded.project;
}

function request(loaded: Project, overrides: Partial<RunRequest> = {}): RunRequest {
  const config = loaded.config.data;
  const variant = config.variants.find((item) => item.id === 'current');
  if (variant === undefined) {
    throw new Error('no current variant');
  }
  return {
    project: loaded,
    variant,
    repeats: config.sampling.repeats,
    caseFilter: null,
    concurrency: config.run.concurrency,
    maxCostUsd: config.budget.maxCostUsd,
    tool: TOOL,
    ...overrides,
  };
}

type Finished = Extract<RunResult, { ok: true }>;

async function finished(result: Promise<RunResult>): Promise<Finished> {
  const value = await result;
  if (!value.ok) {
    throw new Error(`the run did not start: ${JSON.stringify(value.failure)}`);
  }
  return value;
}

async function readLines(runDir: string): Promise<TrialLine[]> {
  const text = await readFile(path.join(runDir, RUN_FILES.trials), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => trialLineSchema.parse(JSON.parse(line)));
}

async function readManifest(runDir: string): Promise<Manifest> {
  return manifestSchema.parse(
    JSON.parse(await readFile(path.join(runDir, RUN_FILES.manifest), 'utf8')),
  );
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function attemptLines(lines: readonly TrialLine[]) {
  return lines.flatMap((line) => ('status' in line ? [line] : []));
}

function sendLines(lines: readonly TrialLine[]) {
  return lines.flatMap((line) => ('sending' in line ? [line] : []));
}

function costLines(lines: readonly TrialLine[]) {
  return lines.flatMap((line) => ('costCorrection' in line ? [line] : []));
}

function usd(input: number, output: number, cachedInput = 0): number {
  return (
    (input * PRICE.input + cachedInput * PRICE.cachedInput + output * PRICE.output) / 1_000_000
  );
}

/**
 * Replays `trials.jsonl`: before every send, spent plus the reservations in flight plus this
 * reservation stays within the cap.
 */
function expectCapHeld(lines: readonly TrialLine[], cap: number): void {
  let spent = 0;
  const inFlight = new Map<string, number>();
  const id = (line: { caseId: string; repeat: number; attempt: number }): string =>
    `${line.caseId}:${String(line.repeat)}:${String(line.attempt)}`;
  for (const line of lines) {
    if ('sending' in line) {
      const reserved = line.reservedUsd ?? 0;
      const held = [...inFlight.values()].reduce((total, value) => total + value, 0);
      expect(spent + held + reserved).toBeLessThanOrEqual(cap + 1e-12);
      inFlight.set(id(line), reserved);
    } else {
      if ('status' in line) {
        inFlight.delete(id(line));
      }
      spent += line.costUsd ?? 0;
    }
  }
}

describe('runner start', () => {
  it('001 FR-014 ends a run whose render fails as a configuration error before any generate', async () => {
    const logs: LogParams[] = [];
    const loaded = await project('runner-render-error');
    const result = await executeRun(request(loaded, { onLog: (params) => logs.push(params) }));
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: 'render',
        failures: [
          { caseId: 'chat-ja-02', cause: 'render', message: 'mock render failed for chat-ja-02' },
        ],
      },
    });
    expect(logs.filter((log) => log.message.startsWith('inflight'))).toEqual([]);
    expect(await exists(path.join(loaded.paths.outputDir, 'runs'))).toBe(false);
  });

  it('001 FR-012 refuses an unpriced variant model with a cap before starting the adapter', async () => {
    const loaded = await project('runner-chat');
    const variant = { id: 'other', model: 'model-z' };
    expect(await executeRun(request(loaded, { variant }))).toEqual({
      ok: false,
      failure: { kind: 'unpriced-variant', model: 'model-z' },
    });
  });

  it('001 FR-011 calls no model and leaves no directory when the expected cost exceeds the cap', async () => {
    const logs: LogParams[] = [];
    const loaded = await project('runner-chat', { maxCostUsd: 0.000_001 });
    const result = await executeRun(request(loaded, { onLog: (params) => logs.push(params) }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe('over-budget');
    expect(logs.filter((log) => log.message.startsWith('inflight'))).toEqual([]);
    expect(await exists(path.join(loaded.paths.outputDir, 'runs'))).toBe(false);
  });

  it('001 FR-014 records versions, capabilities, render fingerprints, prices, cap and estimate', async () => {
    const loaded = await project('runner-chat');
    const { end } = await finished(executeRun(request(loaded)));
    const manifest = await readManifest(end.runDir);
    expect(manifest.tool).toMatchObject({ ...TOOL, protocolVersion: '1' });
    expect(manifest.adapter).toMatchObject({
      name: 'mock-chat',
      version: '0.2.0',
      protocolVersion: '1',
      capabilities: {
        render: true,
        stages: true,
        postprocess: true,
        cancel: false,
        maxConcurrency: 4,
      },
    });
    expect(manifest.adapter.launchHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.service).toEqual({
      version: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
    });
    expect(manifest.variant).toMatchObject({ id: 'current', model: 'model-a' });
    expect(manifest.cases.map((item) => [item.id, item.lang])).toEqual([
      ['chat-ja-01', 'ja'],
      ['chat-ja-02', 'ja'],
      ['chat-ko-01', 'ko'],
      ['chat-ko-02', 'ko'],
    ]);
    expect(Object.keys(manifest.prompts ?? {}).sort()).toEqual(
      manifest.cases.map((item) => item.id),
    );
    expect(manifest.sampling).toEqual({ repeats: 2, seed: 1729, cases: null });
    expect(manifest.limits).toEqual({ retries: 2, timeoutMs: 10_000 });
    expect(manifest.pricing).toEqual({ 'model-a': PRICE, 'model-b': PRICE });
    expect(manifest.budget).toEqual({ maxCostUsd: 1, scope: 'run' });
    expect(manifest.estimate.basis).toEqual({ ja: 'structure', ko: 'structure' });
    expect(manifest.estimate.expected).toBeGreaterThan(0);
    expect(manifest.estimate.conservative).toBeGreaterThan(0);
    const [segment] = manifest.segments;
    expect(segment?.toolPaths).toEqual([
      loaded.paths.configFile,
      path.join(root, 'rules', 'base.yaml'),
      path.join(root, 'cases', 'ja.yaml'),
      path.join(root, 'cases', 'ko.yaml'),
      loaded.paths.outputDir,
    ]);
    expect(segment).toMatchObject({ segment: 1, maxCostUsd: 1, concurrency: 2 });
  });

  it('001 FR-014 draws a new run ID when a run of the same second and variant took the folder', async () => {
    const loaded = await project('runner-chat');
    const at = new Date('2026-11-10T12:00:00Z');
    const suffixes = ['aaaa', 'aaaa', 'bbbb'];
    const runIdSuffix = (): string => suffixes.shift() ?? 'cccc';
    const first = await finished(executeRun(request(loaded, { now: () => at, runIdSuffix })));
    const before = await readFile(path.join(first.end.runDir, RUN_FILES.trials), 'utf8');
    const second = await finished(executeRun(request(loaded, { now: () => at, runIdSuffix })));
    expect(first.end.runId).toBe('20261110-120000-current-aaaa');
    expect(second.end.runId).toBe('20261110-120000-current-bbbb');
    expect(await readFile(path.join(first.end.runDir, RUN_FILES.trials), 'utf8')).toBe(before);
    expect((await readManifest(second.end.runDir)).runId).toBe(second.end.runId);
  });

  it('001 FR-011 bases the next estimate on the previous complete run of the same variant', async () => {
    const loaded = await project('runner-chat');
    await finished(executeRun(request(loaded)));
    const { end } = await finished(executeRun(request(loaded)));
    expect(end.manifest.estimate.basis).toEqual({ ja: 'history', ko: 'history' });
  });
});

describe('runner send loop', () => {
  it('001 FR-010 writes the send line to disk before the attempt reaches the adapter', async () => {
    const sentBefore = [
      "const fs = require('node:fs'); const p = require('node:path');",
      'const sent = (caseId, repeat) => {',
      "  const runs = p.join(out, 'runs');",
      '  return fs.readdirSync(runs).some((run) => {',
      "    const text = fs.readFileSync(p.join(runs, run, 'trials.jsonl'), 'utf8');",
      "    return text.split('\\n').filter(Boolean).map((l) => JSON.parse(l))",
      '      .some((l) => l.sending === true && l.caseId === caseId && l.repeat === repeat);',
      '  });',
      '};',
    ].join('\n');
    const script = scripted(
      "const raw = sent(m.params.caseId, m.params.repeat) ? 'seen' : 'missing'; send({ id: m.id, result: { raw, finalKind: 'model', final: raw, latencyMs: 1, finishReason: 'stop', usage: { input: 1, output: 1 } } });",
      sentBefore,
    );
    const loaded = await project('runner-chat', {
      command: script,
      inputTokens: 300,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    const raws = attemptLines(lines).map((line) => (line.status === 'ok' ? line.raw : line.status));
    expect(raws).toHaveLength(8);
    expect(new Set(raws)).toEqual(new Set(['seen']));
    expect(end.manifest.warnings).toContainEqual({
      code: 'estimate-low-accuracy',
      params: { inputTokens: 300 },
      variants: ['current'],
    });
  });

  it('001 FR-016 sends every trial once in send order with its per-trial seed', async () => {
    const loaded = await project('runner-chat');
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    const sends = sendLines(lines);
    expect(sends).toHaveLength(8);
    expect(sends.every((line) => line.attempt === 1 && line.segment === 1)).toBe(true);
    const attempts = attemptLines(lines);
    expect(attempts.every((line) => line.status === 'ok')).toBe(true);
    for (const line of attempts) {
      expect(line.seed).toBe(trialSeed(1729, line.caseId, line.repeat));
    }
    const keys = (items: readonly { caseId: string; repeat: number }[]): string[] =>
      items.map((line) => `${line.caseId}:${String(line.repeat)}`).sort();
    expect(keys(attempts)).toEqual(keys(sends));
    for (const send of sends) {
      const sendAt = lines.indexOf(send);
      const attemptAt = lines.findIndex(
        (line) => 'status' in line && line.caseId === send.caseId && line.repeat === send.repeat,
      );
      expect(attemptAt).toBeGreaterThan(sendAt);
    }
  });

  it('001 FR-009 retries a transient failure and keeps both attempts of the trial', async () => {
    const loaded = await project('runner-retry');
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    expect(sendLines(lines)).toHaveLength(16);
    const attempts = attemptLines(lines);
    for (const line of attempts) {
      expect([line.attempt, line.status]).toEqual(line.attempt === 1 ? [1, 'error'] : [2, 'ok']);
    }
    expect(end.status).toBe('complete');
    expect(end.manifest.totals.outcomes).toMatchObject({ ok: 8, transient: 0 });
  });

  it('001 FR-009 stops retrying after run.retries and stops the run above run.maxTransientRate', async () => {
    const loaded = await project('runner-transient', { casesPerLang: 8, retries: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    const attempts = attemptLines(await readLines(end.runDir));
    const perKey = new Map<string, number>();
    for (const line of attempts) {
      const key = `${line.caseId}:${String(line.repeat)}`;
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perKey.values())).toBe(2);
    expect(end.status).toBe('partial');
    expect(end.stopReason).toBe('transient-errors');
    expect(end.manifest.stopReason).toBe('transient-errors');
    expect(end.manifest.totals.outcomes.transient).toBeGreaterThanOrEqual(20);
    expect(end.manifest.totals.outcomes.transient).toBeLessThan(32);
  });

  it('001 FR-016 raises render-mismatch, identical-repeats, response-model-changed and transient-rate', async () => {
    const loaded = await project('runner-warnings', { casesPerLang: 5, retries: 0 });
    const { end } = await finished(executeRun(request(loaded)));
    const codes = end.manifest.warnings.map((warning) => warning.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'render-mismatch',
        'identical-repeats',
        'response-model-changed',
        'transient-rate',
      ]),
    );
    expect(end.manifest.warnings).toContainEqual({
      code: 'response-model-changed',
      params: { models: { current: ['model-a-r0', 'model-a-r1'] } },
      variants: ['current'],
    });
    expect((await readManifest(end.runDir)).warnings).toEqual(end.manifest.warnings);
  });

  it('001 FR-007 writes calls notifications as cost lines after the attempt line, and calls of no trial without a key', async () => {
    const loaded = await project('runner-late-calls', { casesPerLang: 1, repeats: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    const costs = costLines(lines);
    expect(costs).toHaveLength(5);
    for (const attempt of attemptLines(lines)) {
      const own = costs.filter(
        (line) =>
          'caseId' in line && line.caseId === attempt.caseId && line.repeat === attempt.repeat,
      );
      expect(own.map((line) => line.usage)).toEqual([
        { input: 20, output: 2 },
        { input: 900, output: 40 },
      ]);
      for (const line of own) {
        expect(lines.indexOf(line)).toBeGreaterThan(lines.indexOf(attempt));
        expect(line).toMatchObject({
          attempt: 1,
          segment: 1,
          source: 'calls',
          costCorrection: true,
        });
      }
    }
    const unkeyed = costs.filter((line) => !('caseId' in line));
    expect(unkeyed).toEqual([
      {
        segment: 1,
        source: 'calls',
        costUsd: usd(50, 5),
        usage: { input: 50, output: 5 },
        calls: [
          { model: 'model-a', outcome: 'ok', branch: 'side', usage: { input: 50, output: 5 } },
        ],
        costCorrection: true,
      },
    ]);
    expect(end.manifest.totals.costUsd).toBeCloseTo(
      2 * (usd(100, 10) + usd(20, 2) + usd(900, 40)) + usd(50, 5),
      12,
    );
    expect(end.manifest.totals.overrunUsd).toBeGreaterThan(0);
    expect(end.manifest.warnings.map((warning) => warning.code)).toContain('budget-overrun');
  });
  it('001 FR-011 charges an attempt without usage the reservation of its send line', async () => {
    // Both trials go out at once; the first answers at once with a large input, which raises
    // every later reservation, and the second answers later without usage.
    const loaded = await project('runner-chat', {
      command: scripted(
        "if (m.params.caseId === 'chat-ko-01') { send({ id: m.id, result: { raw: 'a', finalKind: 'model', final: 'a', latencyMs: 1, finishReason: 'stop', usage: { input: 50000, output: 1 } } }); } else { setTimeout(() => send({ id: m.id, result: { raw: 'b', finalKind: 'model', final: 'b', latencyMs: 1, finishReason: 'stop' } }), 300); }",
      ),
      casesPerLang: 1,
      repeats: 1,
      concurrency: 2,
      inputTokens: 300,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    const send = sendLines(lines).find((line) => line.caseId === 'chat-ja-01');
    const attempt = attemptLines(lines).find((line) => line.caseId === 'chat-ja-01');
    expect(send?.reservedUsd).toBeCloseTo(usd(300, 50), 12);
    expect(attempt).toMatchObject({ costUsd: send?.reservedUsd, costEstimated: true });
  });

  it('001 FR-007 writes a calls notification that arrives after the attempt line as a cost line', async () => {
    const loaded = await project('runner-delayed-calls', { casesPerLang: 1, repeats: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    const attempts = attemptLines(lines);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      const own = costLines(lines).filter(
        (line) =>
          'caseId' in line && line.caseId === attempt.caseId && line.repeat === attempt.repeat,
      );
      expect(own.map((line) => [line.source, line.usage])).toEqual([
        ['calls', { input: 900, output: 40 }],
      ]);
      expect(lines.indexOf(own[0] ?? attempt)).toBeGreaterThan(lines.indexOf(attempt));
    }
    expect(end.manifest.totals.costUsd).toBeCloseTo(2 * (usd(100, 10) + usd(900, 40)), 12);
  });
});

describe('runner interleaving', () => {
  it('001 FR-032 drives two runs of one variant to the end, telling them apart by position', async () => {
    const loaded = await project('runner-chat');
    const { variant, ...settings } = request(loaded);
    const result = await executeSwap({
      ...settings,
      baseline: variant,
      candidate: variant,
      lang: 'en',
    });
    if (!result.ok) {
      throw new Error(`the swap did not start: ${JSON.stringify(result.failure)}`);
    }
    const { baseline, candidate } = result.end.runs;
    expect(baseline.runId).not.toBe(candidate.runId);
    for (const run of [baseline, candidate]) {
      expect(run.status).toBe('complete');
      expect(attemptLines(await readLines(run.runDir))).toHaveLength(8);
    }
  });
});

describe('runner stopping and end', () => {
  it('001 FR-009 records a trial with a config call as a config error whatever the adapter reported', async () => {
    const calls =
      "[{ model: 'model-a', outcome: 'failed', errorKind: 'config', branch: 'side' }, { model: 'model-a', outcome: 'ok', branch: 'answer', usage: { input: 1, output: 1 } }]";
    const loaded = await project('runner-chat', {
      command: scripted(
        `send({ id: m.id, result: { raw: 'hi', finalKind: 'model', final: 'hi', latencyMs: 1, finishReason: 'stop', calls: ${calls} } });`,
      ),
      concurrency: 1,
      inputTokens: 300,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const attempts = attemptLines(await readLines(end.runDir));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'error',
      error: { kind: 'config', message: 'reported model' },
      calls: [{ errorKind: 'config' }, { outcome: 'ok' }],
    });
    expect(end.manifest.totals.outcomes).toMatchObject({ ok: 0, config: 1 });
    expect([end.status, end.stopReason]).toEqual(['partial', 'config-error']);
  });

  it('001 FR-011 stops at once when the cap refuses a send while a retry waits', async () => {
    // The first trial fails transiently, costs more than its reservation and asks for a 60 s
    // wait; the cap then refuses the second trial, so nothing is in flight and the run must stop
    // without sitting out the wait.
    const loaded = await project('runner-chat', {
      command: scripted(
        "send({ id: m.id, result: { error: { kind: 'transient', message: 'busy', retryAfterMs: 60000 }, usage: { input: 1000, output: 50 } } });",
      ),
      casesPerLang: 1,
      repeats: 1,
      concurrency: 1,
      inputTokens: 300,
      maxCostUsd: 0.001,
    });
    const startedAt = Date.now();
    const { end } = await finished(executeRun(request(loaded)));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect([end.status, end.stopReason]).toEqual(['partial', 'budget']);
    expect(attemptLines(await readLines(end.runDir))).toHaveLength(1);
  }, 90_000);

  it('001 FR-011 holds the cap check before tool retries too', async () => {
    const cap = 0.02;
    const loaded = await project('runner-retry-costly', {
      casesPerLang: 3,
      concurrency: 1,
      outputTokens: 10,
      maxCostUsd: cap,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    expectCapHeld(lines, cap);
    expect([end.status, end.stopReason]).toEqual(['partial', 'budget']);
    expect(end.manifest.totals.costUsd).toBeLessThanOrEqual(cap);
    const last = attemptLines(lines).at(-1);
    expect(last).toMatchObject({ attempt: 1, status: 'error', error: { kind: 'transient' } });
  });
  it('001 FR-009 stops with config-error at a configuration failure', async () => {
    const loaded = await project('runner-config', { concurrency: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    const attempts = attemptLines(await readLines(end.runDir));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'error', error: { kind: 'config' } });
    expect([end.status, end.stopReason]).toEqual(['partial', 'config-error']);
  });

  it('001 FR-009 stops with config-error when a calls notification reports a configuration failure, keeping the trial outcome', async () => {
    const loaded = await project('runner-late-config', { concurrency: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    const attempts = attemptLines(await readLines(end.runDir));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]?.status).toBe('ok');
    expect([end.status, end.stopReason]).toEqual(['partial', 'config-error']);
  });

  it('001 FR-012 stops with config-error at a call to an unpriced model while a cap is set', async () => {
    const loaded = await project('runner-unpriced-call', { concurrency: 1 });
    const { end } = await finished(executeRun(request(loaded)));
    expect([end.status, end.stopReason]).toEqual(['partial', 'config-error']);
    const [cost] = costLines(await readLines(end.runDir));
    expect(cost).toMatchObject({ costEstimated: true });
  });

  it('001 FR-011 stops with budget before an attempt the cap check refuses, never exceeding the cap', async () => {
    const cap = 0.03;
    const loaded = await project('runner-costly', {
      casesPerLang: 5,
      repeats: 3,
      concurrency: 3,
      outputTokens: 10,
      maxCostUsd: cap,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    expectCapHeld(lines, cap);
    expect([end.status, end.stopReason]).toEqual(['partial', 'budget']);
    expect(sendLines(lines).length).toBe(attemptLines(lines).length);
    expect(end.manifest.totals.costUsd).toBeLessThanOrEqual(cap);
  });

  it('001 FR-011 stops with budget-projected when the re-estimate after the first batch exceeds the cap', async () => {
    const cap = 0.1;
    const loaded = await project('runner-costly', {
      casesPerLang: 5,
      repeats: 3,
      concurrency: 1,
      outputTokens: 10,
      maxCostUsd: cap,
    });
    const { end } = await finished(executeRun(request(loaded)));
    const lines = await readLines(end.runDir);
    expectCapHeld(lines, cap);
    expect([end.status, end.stopReason]).toEqual(['partial', 'budget-projected']);
    expect(attemptLines(lines)).toHaveLength(20);
    // Repeat 0 of every case finishes inside the first batch; its re-estimate still uses the
    // pre-start values per trial, so only the first batch's measured means exceed the cap.
    const projected = end.manifest.estimate.projected;
    expect(projected.map((entry) => [entry.trigger, entry.repeat])).toEqual([
      ['repeat-round', 0],
      ['first-batch', undefined],
    ]);
    expect(projected[0]?.totalUsd).toBeLessThanOrEqual(cap);
    expect(projected[1]?.totalUsd).toBeCloseTo(30 * usd(400, 2000), 12);
  });

  it('001 FR-018 ends a finished run complete with its totals, a grade set and the lock released', async () => {
    const loaded = await project('runner-chat');
    const { end } = await finished(executeRun(request(loaded)));
    expect(end.status).toBe('complete');
    expect(end.stopReason).toBeUndefined();
    const manifest = await readManifest(end.runDir);
    expect(manifest.status).toBe('complete');
    expect(manifest.stopReason).toBeUndefined();
    expect(manifest.totals).toMatchObject({
      outcomes: {
        ok: 8,
        config: 0,
        adapter: 0,
        transient: 0,
        permanent: 0,
        timeout: 0,
        stopped: 0,
      },
      tokens: { input: 320, cachedInput: 2880, cacheWrite: 0, output: 144, reasoning: 0 },
      reservedUsd: 0,
      overrunUsd: 0,
    });
    expect(manifest.totals.costUsd).toBeCloseTo(8 * usd(40, 18, 360), 12);
    expect(manifest.segments[0]?.endedAt).toBeDefined();
    expect(manifest.segments[0]?.spentUsd).toBe(manifest.totals.costUsd);
    expect(Object.keys(manifest.costProfile ?? {}).sort()).toEqual(['ja', 'ko']);

    const gradeSet = await readGradeSet(end.runDir, end.gradeSetId);
    expect(gradeSet?.header.runId).toBe(end.runId);
    expect(gradeSet?.grades).toHaveLength(8 * 3);
    expect(await exists(gradeSetPath(end.runDir, end.gradeSetId))).toBe(true);
    expect(await readdir(end.runDir)).not.toContain(RUN_FILES.lock);
  });
});
