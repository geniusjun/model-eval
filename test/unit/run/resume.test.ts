import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ErrorKind, InitializeResult } from '../../../src/adapter/protocol.js';
import { trialSeed, type TrialKey } from '../../../src/run/ids.js';
import { manifestSchema } from '../../../src/run/manifest.js';
import type { AttemptLine, SendLine, TrialLine } from '../../../src/run/records.js';
import {
  closingLines,
  recount,
  repairRunRecords,
  resumedState,
  segmentSpentUsd,
  trialsToSend,
} from '../../../src/run/resume.js';
import { mergeListWarnings } from '../../../src/run/merge-warnings.js';
import { checkGeneration, type CurrentGeneration } from '../../../src/run/resume-check.js';
import { readRunRecords } from '../../../src/run/run-records.js';
import { TrialBook } from '../../../src/run/trial-book.js';
import { RUN_FILES, writeManifest } from '../../../src/run/writer.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };

const SEED = 1729;
const RETRIES = 1;

function key(caseId: string, repeat = 0): TrialKey {
  return { caseId, repeat };
}

function base(caseId: string, attempt: number, segment: number) {
  return { caseId, repeat: 0, attempt, segment, seed: trialSeed(SEED, caseId, 0) };
}

function send(caseId: string, attempt: number, segment = 1, reservedUsd = 0.01): SendLine {
  return { caseId, repeat: 0, attempt, segment, reservedUsd, sending: true };
}

function ok(caseId: string, attempt = 1, segment = 1, costUsd = 0.002): AttemptLine {
  return {
    ...base(caseId, attempt, segment),
    status: 'ok',
    raw: 'hello',
    answers: 1,
    finalKind: 'model',
    final: 'hello',
    latencyMs: 10,
    finishReason: 'stop',
    costUsd,
  };
}

function failed(
  caseId: string,
  kind: ErrorKind,
  attempt = 1,
  segment = 1,
  costUsd = 0.001,
): AttemptLine {
  return {
    ...base(caseId, attempt, segment),
    status: 'error',
    error: { kind, message: kind },
    costUsd,
  };
}

function stopped(caseId: string, attempt = 1, segment = 1): AttemptLine {
  return {
    ...base(caseId, attempt, segment),
    status: 'stopped',
    costUsd: 0.01,
    costEstimated: true,
  };
}

/** A send line and its attempt line, as a run writes them. */
function sent(line: AttemptLine): TrialLine[] {
  return [send(line.caseId, line.attempt, line.segment), line];
}

describe('resumedState and trialsToSend', () => {
  const lines: TrialLine[] = [
    ...sent(ok('done')),
    ...sent(stopped('cut')),
    ...sent(failed('retry-left', 'transient')),
    ...sent(failed('retry-spent', 'transient')),
    ...sent(failed('retry-spent', 'transient', 2)),
    ...sent(failed('config', 'config')),
    ...sent(failed('adapter', 'adapter')),
    ...sent(failed('permanent', 'permanent')),
    ...sent(failed('timeout', 'timeout')),
  ];
  const keys = [
    'done',
    'cut',
    'retry-left',
    'retry-spent',
    'config',
    'adapter',
    'permanent',
    'timeout',
    'unsent',
  ].map((caseId) => key(caseId));

  it('001 FR-013 resends unsent, stopped, transient with retries left and config trials only', () => {
    const resent = trialsToSend(lines, keys, RETRIES).map((each) => each.caseId);
    expect(resent).toEqual(['cut', 'retry-left', 'config', 'unsent']);
  });

  it('001 FR-013 continues attempt numbers across segments', () => {
    const attemptsOf = (caseId: string): AttemptLine[] =>
      lines.filter((line): line is AttemptLine => 'status' in line && line.caseId === caseId);
    expect(resumedState(attemptsOf('cut'), RETRIES)).toEqual({ kind: 'resend', nextAttempt: 2 });
    expect(resumedState(attemptsOf('config'), RETRIES)).toEqual({ kind: 'resend', nextAttempt: 2 });
    expect(resumedState(attemptsOf('retry-left'), RETRIES)).toMatchObject({
      kind: 'retry',
      nextAttempt: 2,
      waitMs: 0,
    });
    expect(resumedState(attemptsOf('unsent'), RETRIES)).toEqual({ kind: 'unsent' });
    expect(resumedState(attemptsOf('adapter'), RETRIES).kind).toBe('finished');
  });

  it('001 FR-013 counts retries across segments, so a resumed trial gets no new retries', () => {
    const acrossSegments: AttemptLine[] = [
      failed('flaky', 'transient', 1, 1),
      failed('flaky', 'transient', 2, 2),
    ];
    expect(resumedState(acrossSegments, RETRIES).kind).toBe('finished');
    expect(resumedState(acrossSegments.slice(0, 1), RETRIES).kind).toBe('retry');
  });
});

describe('closingLines', () => {
  it('001 FR-013 closes send lines without an attempt line as stopped at their reservation', () => {
    const lines: TrialLine[] = [
      send('answered', 1),
      ok('answered'),
      send('killed', 1, 1, 0.004),
      send('killed-later', 3, 2, 0.006),
    ];
    expect(closingLines(lines, SEED)).toEqual([
      {
        ...base('killed', 1, 1),
        status: 'stopped',
        costUsd: 0.004,
        costEstimated: true,
      },
      {
        ...base('killed-later', 3, 2),
        status: 'stopped',
        costUsd: 0.006,
        costEstimated: true,
      },
    ]);
  });

  it('001 FR-013 keeps an unknown reservation unknown', () => {
    const unpriced: SendLine = { ...send('killed', 1), reservedUsd: null };
    expect(closingLines([unpriced], SEED)[0]?.costUsd).toBeNull();
  });
});

describe('recount', () => {
  it('001 FR-013 recounts spend and totals from the lines, closed sends at their reservation once', () => {
    const lines: TrialLine[] = [
      ...sent(ok('a', 1, 1, 0.002)),
      send('b', 1, 1, 0.004),
      ...sent(failed('c', 'transient', 1, 1, 0.001)),
    ];
    const closed = [...lines, ...closingLines(lines, SEED)];
    const counted = recount(closed, 500);
    expect(counted.spentUsd).toBeCloseTo(0.007, 12);
    expect(counted.totals.costUsd).toBeCloseTo(0.007, 12);
    expect(counted.totals.reservedUsd).toBeCloseTo(0.004, 12);
    expect(counted.totals.outcomes).toMatchObject({ ok: 1, stopped: 1, transient: 1 });
    expect(counted.totals.durationMs).toBe(500);
  });

  it('001 FR-013 gives each segment the spend of the lines it wrote', () => {
    const lines: TrialLine[] = [
      ...sent(ok('a', 1, 1, 0.002)),
      ...sent(stopped('b', 1, 1)),
      ...sent(ok('b', 2, 2, 0.003)),
    ];
    expect(segmentSpentUsd(lines, 1)).toBeCloseTo(0.012, 12);
    expect(segmentSpentUsd(lines, 2)).toBeCloseTo(0.003, 12);
  });
});

describe('TrialBook of a resumed run', () => {
  it('001 FR-013 counts stop rates over the trials finished in the current segment', () => {
    const earlier: AttemptLine[] = Array.from({ length: 25 }, (_unused, index) =>
      failed(`case-${String(index)}`, 'transient', 1, 1),
    );
    const keys = [...earlier.map((line) => key(line.caseId)), key('fresh')];
    const book = new TrialBook(
      { keys, firstBatch: 0 },
      () => '*',
      0,
      () => 0.5,
      earlier,
    );
    expect(book.finished).toBe(25);
    expect(book.finishedIn(2)).toEqual({ finished: 0, transient: 0, adapter: 0 });
    expect(book.next(0)).toEqual(key('fresh'));
    expect(book.nextAttempt(key('fresh'))).toBe(1);
    book.markSent(key('fresh'));
    book.record(failed('fresh', 'transient', 1, 2), 0);
    expect(book.finishedIn(2)).toEqual({ finished: 1, transient: 1, adapter: 0 });
  });

  it('001 FR-013 sends a stopped trial again under its next attempt number', () => {
    const earlier = [stopped('cut', 1, 1)];
    const book = new TrialBook(
      { keys: [key('cut')], firstBatch: 1 },
      () => '*',
      2,
      () => 0.5,
      earlier,
    );
    expect(book.next(0)).toEqual(key('cut'));
    expect(book.nextAttempt(key('cut'))).toBe(2);
    expect(book.started).toBe(1);
  });
});

describe('repairRunRecords', () => {
  let outputDir: string;
  const manifest = manifestSchema.parse(manifestFixture);
  const runDir = (): string => path.join(outputDir, 'runs', manifest.runId);
  const trialsFile = (): string => path.join(runDir(), RUN_FILES.trials);
  const jsonl = (lines: readonly TrialLine[]): string =>
    lines.map((line) => `${JSON.stringify(line)}\n`).join('');

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(tmpdir(), 'model-eval-resume-'));
    await mkdir(runDir(), { recursive: true });
    await writeManifest(runDir(), manifest);
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it('001 FR-013 treats bytes after the last newline as a cut line, even valid JSON, and truncates it', async () => {
    const complete = [send('greet-ko', 1), ok('greet-ko')];
    const cut = JSON.stringify(send('greet-ja', 1));
    await writeFile(trialsFile(), jsonl(complete) + cut);
    const read = await readRunRecords(runDir());
    if (!read.ok) {
      throw new Error(`unexpected problem ${read.problem.kind}`);
    }
    expect(read.run.lines).toEqual(complete);
    expect(read.run.log.cutBytes).toBe(Buffer.byteLength(cut));
    const repaired = await repairRunRecords(read.run);
    expect(repaired).toEqual(complete);
    expect(await readFile(trialsFile(), 'utf8')).toBe(jsonl(complete));
  });

  it('001 FR-013 appends the closing lines after truncating', async () => {
    const lines = [send('greet-ko', 1), ok('greet-ko'), send('greet-ja', 1, 1, 0.004)];
    await writeFile(trialsFile(), `${jsonl(lines)}{"caseId":"gre`);
    const read = await readRunRecords(runDir());
    if (!read.ok) {
      throw new Error(`unexpected problem ${read.problem.kind}`);
    }
    const repaired = await repairRunRecords(read.run);
    const closing = closingLines(lines, manifest.sampling.seed);
    expect(closing).toHaveLength(1);
    expect(repaired).toEqual([...lines, ...closing]);
    expect(await readFile(trialsFile(), 'utf8')).toBe(jsonl([...lines, ...closing]));
  });

  it('001 FR-013 refuses a broken middle line with its line number', async () => {
    await writeFile(
      trialsFile(),
      `${JSON.stringify(send('greet-ko', 1))}\n{"caseId":\n${JSON.stringify(ok('greet-ko'))}\n`,
    );
    const read = await readRunRecords(runDir());
    expect(read).toMatchObject({ ok: false, problem: { kind: 'trials', line: 2 } });
  });
});

describe('checkGeneration', () => {
  const manifest = manifestSchema.parse(manifestFixture);
  const info: InitializeResult = {
    protocolVersion: '1',
    adapter: {
      name: manifest.adapter.name,
      version: manifest.adapter.version,
      ...(manifest.adapter.helper === undefined ? {} : { helper: manifest.adapter.helper }),
    },
    service: manifest.service,
    targets: [{ name: 'chat', inputSchema: {} }],
    capabilities: manifest.adapter.capabilities,
  };
  const current: CurrentGeneration = {
    info,
    launchHash: manifest.adapter.launchHash,
    prompts: manifest.prompts,
  };

  it('001 FR-013 treats a service version missing on either side as unverified, not changed', () => {
    const { service: _service, ...withoutService } = info;
    expect(checkGeneration(manifest, { ...current, info: withoutService })).toEqual({
      unverified: ['service-version'],
    });
    const recordedWithout = { ...manifest, service: {} };
    expect(checkGeneration(recordedWithout, current)).toEqual({
      unverified: ['service-version'],
    });
    expect(checkGeneration(manifest, current)).toEqual({ unverified: [] });
  });
});

describe('mergeListWarnings', () => {
  it('001 FR-013 keeps one resume warning per code over every segment', () => {
    const merged = mergeListWarnings([
      {
        code: 'resume-unverified',
        params: { conditions: ['service-version'] },
        variants: ['next'],
      },
      { code: 'estimate-low-accuracy', params: { inputTokens: 300 }, variants: ['next'] },
      {
        code: 'resume-config-ignored',
        params: { fields: ['seed'] },
        variants: ['next'],
        caseIds: ['greet-ko-5'],
      },
      {
        code: 'resume-unverified',
        params: { conditions: ['render-fingerprint', 'service-version'] },
        variants: ['next'],
      },
      { code: 'resume-config-ignored', params: { fields: ['retries'] }, variants: ['next'] },
      { code: 'unpriced-model', params: { models: ['model-z'] }, variants: ['next'] },
      { code: 'unpriced-model', params: { models: ['model-a'] }, variants: ['next'] },
    ]);
    expect(merged).toEqual([
      {
        code: 'resume-unverified',
        params: { conditions: ['service-version', 'render-fingerprint'] },
        variants: ['next'],
      },
      { code: 'estimate-low-accuracy', params: { inputTokens: 300 }, variants: ['next'] },
      {
        code: 'resume-config-ignored',
        params: { fields: ['seed', 'retries'] },
        variants: ['next'],
        caseIds: ['greet-ko-5'],
      },
      { code: 'unpriced-model', params: { models: ['model-a', 'model-z'] }, variants: ['next'] },
    ]);
  });
});
