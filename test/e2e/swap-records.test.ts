import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { E2E, SWAP, swapJson, useProjects, type JsonOutcome } from './support/commands.js';
import { ROOT, type CliResult } from './support/cli.js';
import { GLOBAL_SEED, trialSeed } from './support/mock.js';
import {
  attemptLines,
  comparisonOf,
  costLines,
  effectiveLines,
  filesUnder,
  jsonAt,
  readComparison,
  readRun,
  readSwapRecord,
  swapRunOf,
  trialKey,
  type RunFiles,
  type SwapEnvelope,
} from './support/outputs.js';
import { greetCases, MODEL_A, MODEL_B, type Project, type RuleInput } from './support/project.js';
import { ANSWERED, NO_EMOJI, SELF_STATE_REVIEW } from './support/rules.js';

// Records of a swap (FR-007, FR-010, FR-014, FR-015, FR-016, FR-031) against the mock adapter.

const project = useProjects();

const CASES = greetCases({ ko: 3, ja: 3 });
const RULES = [ANSWERED, NO_EMOJI, SELF_STATE_REVIEW];
const PHONE = '010-1234-5678';
/** The redaction rule of contracts/config.md. */
const REDACT = [{ pattern: '\\b01[0-9]-?\\d{3,4}-?\\d{4}\\b', replace: '<phone>' }];
/** Fails every answer, with the phone number as its evidence, so grade sets hold the secret. */
const NO_PHONE: RuleInput = {
  id: 'no-phone',
  title: 'No phone number',
  severity: 'minor',
  scope: 'global',
  check: { type: 'pattern', regex: '\\d{3}-\\d{4}-\\d{4}', mode: 'forbid' },
};
/** The price both models get in the e2e projects, USD per 1M tokens. */
const PRICE = { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 };
const SHA256 = /^sha256:[0-9a-f]{64}$/;

const TOOL_VERSION: unknown = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Canonical JSON of data-model §Canonical JSON for plain values with ASCII keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

const perMillion = (tokens: number, price: number): number => (tokens * price) / 1_000_000;

function lineCostUsd(run: RunFiles): number {
  return [...attemptLines(run.lines), ...costLines(run.lines)].reduce(
    (sum, line) => sum + (line.costUsd ?? 0),
    0,
  );
}

describe('001 records of a finished swap', () => {
  let records: Project;
  let outcome: JsonOutcome<SwapEnvelope>;
  let human: CliResult;
  let runs: { baseline: RunFiles; candidate: RunFiles } | undefined;

  beforeAll(async () => {
    records = await project({
      scenario: 'swap-records',
      rules: [...RULES, NO_PHONE],
      cases: CASES,
      config: { redact: REDACT },
    });
    outcome = await swapJson(records);
    human = await records.run([...SWAP, '--verbose']);
    const { result } = outcome.envelope;
    if (result !== null && !('plan' in result)) {
      runs = {
        baseline: await readRun(records.outputDir, result.runs[0]),
        candidate: await readRun(records.outputDir, result.runs[1]),
      };
    }
  }, E2E.timeout);

  /** Both runs of the JSON swap; fails the test when the swap wrote none. */
  function written(): { baseline: RunFiles; candidate: RunFiles } {
    expect(outcome.cli.code).toBe(0);
    if (runs === undefined) {
      throw new Error('the swap wrote no runs');
    }
    return runs;
  }

  it('001 FR-010 every trial records raw and shipped text, its kind, token buckets, latency, finish reason, snapshot and answer count', () => {
    const { baseline, candidate } = written();
    const expectations = [
      {
        run: baseline,
        answers: 1,
        usage: { input: 40, cachedInput: 360, cacheWrite: 0, output: 18, reasoning: 0 },
        latencyMs: 120,
        modelSnapshot: 'model-a-2026-01-01',
        emoji: '',
      },
      {
        run: candidate,
        answers: 2,
        usage: { input: 50, cachedInput: 350, cacheWrite: 0, output: 30, reasoning: 8 },
        latencyMs: 180,
        modelSnapshot: 'model-b-2026-10-01',
        emoji: ' 😀',
      },
    ];
    for (const expected of expectations) {
      const effective = effectiveLines(expected.run.lines);
      expect(effective.size).toBe(12);
      for (const item of CASES) {
        for (const repeat of [0, 1]) {
          const line = effective.get(trialKey(item.id, repeat));
          const greeting = item.lang === 'ko' ? '응' : 'はい';
          const text = `${greeting} ${item.id} ${String(repeat)} ${PHONE}${item.lang === 'ja' ? expected.emoji : ''}`;
          expect(line).toMatchObject({
            status: 'ok',
            seed: trialSeed(item.id, repeat),
            raw: text,
            finalKind: 'model',
            final: text,
            answers: expected.answers,
            usage: expected.usage,
            latencyMs: expected.latencyMs,
            finishReason: 'stop',
            modelSnapshot: expected.modelSnapshot,
            stages: [{ name: 'postprocess', text }],
          });
          expect(line?.costEstimated).not.toBe(true);
        }
      }
    }
  });

  it('001 FR-011 each attempt is priced from its calls: Σ bucket tokens × bucket price', () => {
    const cost = (usage: { input: number; cachedInput: number; output: number }) =>
      perMillion(usage.input, PRICE.input) +
      perMillion(usage.cachedInput, PRICE.cachedInput) +
      perMillion(usage.output, PRICE.output);
    const { baseline, candidate } = written();
    for (const line of attemptLines(baseline.lines)) {
      expect(line.costUsd).toBeCloseTo(cost({ input: 40, cachedInput: 360, output: 18 }), 12);
    }
    for (const line of attemptLines(candidate.lines)) {
      expect(line.costUsd).toBeCloseTo(cost({ input: 50, cachedInput: 350, output: 30 }), 12);
    }
  });

  it('001 FR-014 each manifest records versions, the variant, case hashes, render fingerprints, the seed, prices and the segment', () => {
    const { baseline, candidate } = written();
    const { swapId } = swapRunOf(outcome.envelope);
    const version =
      typeof TOOL_VERSION === 'object' && TOOL_VERSION !== null && 'version' in TOOL_VERSION
        ? TOOL_VERSION.version
        : undefined;
    for (const [run, variant, model] of [
      [baseline, 'current', MODEL_A],
      [candidate, 'next', MODEL_B],
    ] as const) {
      const { manifest } = run;
      expect(manifest.runId).toMatch(new RegExp(`^\\d{8}-\\d{6}-${variant}-[0-9a-f]{4}$`));
      expect(manifest.swapId).toBe(swapId);
      expect(manifest.tool).toMatchObject({ name: 'model-eval', version, protocolVersion: '1' });
      expect(manifest.adapter).toMatchObject({
        name: 'mock-records',
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
      expect(manifest.adapter.launchHash).toMatch(SHA256);
      expect(manifest.service).toMatchObject({
        version: '1111111111111111111111111111111111111111',
        dirty: false,
      });
      expect(manifest.variant).toMatchObject({ id: variant, model });
      expect(manifest.variant.fingerprint).toMatch(SHA256);
      expect([...manifest.cases].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...CASES]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((item) => ({
            id: item.id,
            target: 'chat',
            lang: item.lang,
            hash: hashOf({ target: item.target, lang: item.lang, input: item.input }),
          })),
      );
      expect(manifest.rulesHash).toMatch(SHA256);
      expect(Object.keys(manifest.prompts ?? {}).sort()).toEqual(
        CASES.map((item) => item.id).sort(),
      );
      for (const line of attemptLines(run.lines)) {
        expect(manifest.prompts?.[line.caseId]).toBe(
          'fingerprint' in line ? line.fingerprint : undefined,
        );
      }
      expect(manifest.sampling).toEqual({ repeats: 2, seed: GLOBAL_SEED, cases: null });
      expect(manifest.limits).toEqual({ retries: 2, timeoutMs: 120_000 });
      expect(manifest.pricing[model]).toEqual(PRICE);
      expect(manifest.budget).toEqual({ maxCostUsd: 1, scope: 'swap' });
      expect(manifest.segments.map((segment) => segment.segment)).toEqual([1]);
      expect(manifest.status).toBe('complete');
    }
    expect(baseline.manifest.adapter.launchHash).toBe(candidate.manifest.adapter.launchHash);
    expect(baseline.manifest.prompts).toEqual(candidate.manifest.prompts);
  });

  it('001 FR-014 the swap record names both runs, the comparison and the spend of both runs', async () => {
    const { baseline, candidate } = written();
    const result = swapRunOf(outcome.envelope);
    const record = await readSwapRecord(records.outputDir, result.swapId);
    expect(record).toMatchObject({
      swapId: result.swapId,
      baselineRunId: result.runs[0],
      candidateRunId: result.runs[1],
      status: 'complete',
      comparisonId: comparisonOf(outcome.envelope).comparisonId,
      budget: { maxCostUsd: 1, scope: 'swap' },
    });
    expect(record.spentUsd).toBeCloseTo(lineCostUsd(baseline) + lineCostUsd(candidate), 12);
  });

  it('001 FR-016 distinct answers and snapshots raise neither identical-repeats nor a snapshot warning', () => {
    written();
    const codes = outcome.envelope.warnings.map((warning) => warning.code);
    expect(codes).not.toContain('identical-repeats');
    expect(codes).not.toContain('same-response-model');
    expect(codes).not.toContain('response-model-changed');
    expect(codes).not.toContain('render-mismatch');
  });

  it('001 FR-031 a secret in model output appears in no written surface except trials.jsonl', async () => {
    expect(human.code).toBe(0);
    const written = await filesUnder(records.outputDir);
    const trialFiles = written.filter((file) => path.basename(file) === 'trials.jsonl');
    expect(trialFiles).toHaveLength(4);
    for (const file of trialFiles) {
      expect(await readFile(file, 'utf8')).toContain(PHONE);
    }
    const leaking: string[] = [];
    for (const file of written.filter((item) => !trialFiles.includes(item))) {
      if ((await readFile(file, 'utf8')).includes(PHONE)) {
        leaking.push(path.relative(records.outputDir, file));
      }
    }
    expect(leaking).toEqual([]);
    // The no-phone rule caught the number in every grade set, so the check above covers them.
    const gradeFiles = written.filter((file) => path.basename(path.dirname(file)) === 'grades');
    expect(gradeFiles).toHaveLength(trialFiles.length);
    for (const file of gradeFiles) {
      const caught = (await readFile(file, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line))
        .filter((grade) => jsonAt(grade, ['ruleId']) === 'no-phone');
      expect(caught.length).toBeGreaterThan(0);
      for (const grade of caught) {
        expect(jsonAt(grade, ['outcome'])).toBe('fail');
        expect(jsonAt(grade, ['evidence'])).toEqual(['<phone>']);
      }
    }
    for (const stream of [outcome.cli.stdout, outcome.cli.stderr, human.stdout, human.stderr]) {
      expect(stream).not.toContain(PHONE);
    }
    // The samples still carry the answers, with the number replaced.
    const texts = comparisonOf(outcome.envelope).samples.texts;
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect('raw' in text ? text.raw : '').toContain('<phone>');
    }
  });
});

describe('001 FR-014 a render failure at the start', () => {
  it(
    '001 FR-014 ends with exit 4 before any generate and names the case',
    async () => {
      const broken = await project({ scenario: 'swap-render-failure', rules: RULES, cases: CASES });
      const { cli, envelope } = await swapJson(broken);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      const human = await broken.run([...SWAP]);
      expect(human.code).toBe(4);
      expect(human.stdout + human.stderr).toContain('greet-ja-2');

      const sessions = await broken.sessions();
      const methods = sessions.flatMap((session) =>
        session.requests.map((request) => request.method),
      );
      expect(methods).toContain('render');
      expect(methods).not.toContain('generate');
    },
    E2E.timeout,
  );
});

describe('001 FR-015 and FR-016 run warnings', () => {
  it(
    '001 FR-015 a request fingerprint that differs from the render raises render-mismatch',
    async () => {
      const mismatch = await project({
        scenario: 'swap-render-mismatch',
        rules: RULES,
        cases: CASES,
      });
      const { cli, envelope } = await swapJson(mismatch);
      expect(cli.code).toBe(0);
      const warning = envelope.warnings.find((item) => item.code === 'render-mismatch');
      expect(warning?.variants).toEqual(['next']);
      const params = warning !== undefined && 'params' in warning ? warning.params : undefined;
      expect(params).toMatchObject({ trials: { next: 12 } });
    },
    E2E.timeout,
  );

  it(
    '001 FR-016 repeats that return the same output raise identical-repeats, and one snapshot behind two models raises same-response-model',
    async () => {
      const same = await project({ scenario: 'swap-same-snapshot', rules: RULES, cases: CASES });
      const { cli, envelope } = await swapJson(same);
      expect(cli.code).toBe(0);
      const repeats = envelope.warnings.find((item) => item.code === 'identical-repeats');
      expect([...(repeats?.variants ?? [])].sort()).toEqual(['current', 'next']);
      expect([...(repeats?.caseIds ?? [])].sort()).toEqual(CASES.map((item) => item.id).sort());
      const snapshot = envelope.warnings.find((item) => item.code === 'same-response-model');
      expect(snapshot !== undefined && 'params' in snapshot ? snapshot.params : undefined).toEqual({
        models: ['shared-model-2026-01-01'],
      });
    },
    E2E.timeout,
  );

  it(
    '001 FR-010 more than one response snapshot within a run raises response-model-changed',
    async () => {
      const changing = await project({
        scenario: 'swap-snapshot-changes',
        rules: RULES,
        cases: CASES,
      });
      const { cli, envelope } = await swapJson(changing);
      expect(cli.code).toBe(0);
      const warning = envelope.warnings.find((item) => item.code === 'response-model-changed');
      expect(warning?.variants).toEqual(['next']);
      const params = warning !== undefined && 'params' in warning ? warning.params : undefined;
      expect(params).toEqual({ models: { next: ['model-b-snapshot-0', 'model-b-snapshot-1'] } });
    },
    E2E.timeout,
  );
});

describe('001 FR-007 calls reported outside a result', () => {
  it(
    '001 FR-007 calls notifications land as cost lines after the attempt line and count in the cost',
    async () => {
      const background = await project({ scenario: 'swap-late-calls', rules: RULES, cases: CASES });
      const { cli, envelope } = await swapJson(background);
      expect(cli.code).toBe(0);
      const [baselineId, candidateId] = swapRunOf(envelope).runs;
      const withCalls = await readRun(background.outputDir, candidateId);
      const without = await readRun(background.outputDir, baselineId);
      expect(costLines(without.lines)).toEqual([]);

      // swap-late-calls.yaml: one notification before each result, 700 in and 20 out, and one
      // after it, 900 in and 40 out, both priced at model-b.
      const sideCost = {
        before: perMillion(700, PRICE.input) + perMillion(20, PRICE.output),
        after: perMillion(900, PRICE.input) + perMillion(40, PRICE.output),
      };
      for (const item of CASES) {
        for (const repeat of [0, 1]) {
          const keyed = withCalls.lines
            .map((line, index) => ({ line, index }))
            .filter(
              ({ line }) => 'caseId' in line && line.caseId === item.id && line.repeat === repeat,
            );
          const attemptsAt = keyed.filter(({ line }) => 'status' in line).map(({ index }) => index);
          const costs = keyed.flatMap(({ line, index }) =>
            'costCorrection' in line ? [{ line, index }] : [],
          );
          expect(attemptsAt).toHaveLength(1);
          expect(costs).toHaveLength(2);
          for (const { line, index } of costs) {
            expect(index).toBeGreaterThan(attemptsAt[0] ?? Number.POSITIVE_INFINITY);
            expect(line).toMatchObject({ source: 'calls', costCorrection: true, attempt: 1 });
          }
          expect(costs.map(({ line }) => line.costUsd ?? 0).sort((a, b) => a - b)).toEqual([
            expect.closeTo(sideCost.before, 12),
            expect.closeTo(sideCost.after, 12),
          ]);
        }
      }
      expect(withCalls.manifest.totals.costUsd).toBeCloseTo(lineCostUsd(withCalls), 12);
    },
    E2E.timeout,
  );
});

describe('001 FR-031 a redaction rule whose replacement it matches again', () => {
  it(
    '001 FR-031 stdout shows the comparison text redacted once, as comparison.json has it',
    async () => {
      // The candidate's time-outs share one message, which the gate names as the dominant error.
      const timeouts = await project({
        scenario: 'swap-timeout',
        rules: [ANSWERED],
        cases: greetCases({ ko: 10, ja: 10 }),
        config: {
          redact: [{ pattern: 'limit', replace: 'limit-x' }],
          gate: { severities: ['blocking'] },
          sampling: { repeats: 3 },
        },
      });
      const once = '"service time limit-x of 30 s"';
      const { cli, envelope } = await swapJson(timeouts);
      expect(cli.code).toBe(1);
      const shown = comparisonOf(envelope);
      const { comparison } = await readComparison(timeouts.outputDir, shown.comparisonId);
      expect(shown).toEqual(comparison);
      expect(swapRunOf(envelope).gate).toEqual(comparison.gate);
      expect(envelope.warnings).toEqual(expect.arrayContaining([...comparison.warnings]));
      expect(JSON.stringify(comparison)).toContain('limit-x');
      expect(cli.stdout).not.toContain('limit-x-x');

      const human = await timeouts.run([...SWAP]);
      expect(human.code).toBe(1);
      expect(human.stdout).toContain(once);
      expect(human.stdout).not.toContain('limit-x-x');
    },
    E2E.timeout,
  );

  it(
    '001 FR-031 failing-sample evidence is redacted once in comparison.json and on stdout',
    async () => {
      const emoji = await project({
        scenario: 'swap-records',
        rules: [NO_EMOJI],
        cases: greetCases({ ja: 10 }),
        config: { redact: [{ pattern: '😀', replace: '😀😀' }], sampling: { repeats: 3 } },
      });
      const { envelope } = await swapJson(emoji);
      const shown = comparisonOf(envelope);
      const { comparison } = await readComparison(emoji.outputDir, shown.comparisonId);
      const evidence = comparison.samples.failing.flatMap((cell) =>
        cell.keys.flatMap((key) => key.evidence ?? []),
      );
      expect(evidence.length).toBeGreaterThan(0);
      expect(new Set(evidence)).toEqual(new Set(['😀😀']));
      expect(shown.samples).toEqual(comparison.samples);
    },
    E2E.timeout,
  );
});
