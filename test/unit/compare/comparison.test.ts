import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildComparison,
  STATS_METHOD,
  type ComparedRunRecords,
  type ComparisonInput,
  type CurrentCase,
} from '../../../src/compare/comparison.js';
import type { Sha256 } from '../../../src/config/identifiers.js';
import { caseSchema, configSchema, ruleSchema, type Rule } from '../../../src/config/schema.js';
import { gradeRun } from '../../../src/grade/grade.js';
import { effectiveAttempts } from '../../../src/grade/outcome.js';
import { comparisonSchema, type Comparison } from '../../../src/report/schema.js';
import { manifestSchema, type Manifest } from '../../../src/run/manifest.js';
import type { AttemptLine } from '../../../src/run/records.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };
import { errorLine, okLine } from '../grade/lines.js';
import { near, Z_L } from '../stats/cases.js';

const hash = (digit: string): Sha256 => `sha256:${digit.repeat(64)}`;
const CASE_HASH = hash('c');

function rule(fields: Record<string, unknown>): Rule {
  return ruleSchema.parse({
    title: 'title',
    severity: 'blocking',
    scope: 'global',
    check: { type: 'emoji' },
    ...fields,
  });
}

const RULES = [
  rule({ id: 'completed', check: { type: 'completed' } }),
  rule({ id: 'no-emoji' }),
  rule({ id: 'self-state', check: { type: 'review', samples: 1 } }),
];

const caseIds = (count: number, prefix = 'ko') =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(2, '0')}`);

function currentCase(id: string, caseHash: Sha256 = CASE_HASH): CurrentCase {
  return {
    definition: caseSchema.parse({
      id,
      target: 'chat',
      lang: 'ko',
      provenance: 'synthetic',
      input: {},
    }),
    hash: caseHash,
  };
}

const ADAPTER_ERROR = Symbol('adapter error');

interface RunSpec {
  readonly variant: string;
  readonly cases: readonly string[];
  /** The raw and final answer of each trial, or an adapter error. */
  readonly answer: (caseId: string, repeat: number) => string | typeof ADAPTER_ERROR;
  readonly manifest?: Partial<Manifest>;
  readonly gradeSetId?: string;
}

const RUN_IDS: Readonly<Record<string, string>> = {
  current: '20261105-101500-current-1a2b',
  next: '20261105-101500-next-a1b2',
};

function manifestOf(spec: RunSpec): Manifest {
  const base = manifestSchema.parse(manifestFixture);
  return {
    ...base,
    runId: RUN_IDS[spec.variant] ?? base.runId,
    variant: {
      id: spec.variant,
      model: `model-${spec.variant}`,
      fingerprint: hash(spec.variant === 'current' ? 'a' : 'b'),
    },
    cases: spec.cases.map((id) => ({ id, target: 'chat', lang: 'ko', hash: CASE_HASH })),
    warnings: [],
    segments: base.segments.map((segment) => ({ ...segment, resumeWarnings: [] })),
    status: 'complete',
    stopReason: undefined,
    ...spec.manifest,
  };
}

function linesOf(spec: RunSpec): AttemptLine[] {
  return spec.cases.flatMap((caseId) =>
    Array.from({ length: 5 }, (_, repeat) => {
      const answer = spec.answer(caseId, repeat);
      return answer === ADAPTER_ERROR
        ? errorLine('adapter', { caseId, repeat })
        : okLine({ caseId, repeat, raw: answer, final: answer });
    }),
  );
}

function records(spec: RunSpec, cases: readonly CurrentCase[]): ComparedRunRecords {
  const manifest = manifestOf(spec);
  const lines = linesOf(spec);
  const current = new Map(cases.map((testCase) => [testCase.definition.id, testCase]));
  const grades = gradeRun({
    rules: RULES,
    cases: manifest.cases.map((runCase) => ({
      ...runCase,
      hash: CASE_HASH,
      current: current.get(runCase.id),
    })),
    trials: effectiveAttempts(lines),
  });
  return {
    manifest,
    lines,
    gradeSet: {
      header: {
        gradeSetId:
          spec.gradeSetId ?? (spec.variant === 'current' ? 'gs-0a1b2c3d4e5f' : 'gs-1b2c3d4e5f6a'),
        runId: manifest.runId,
        rulesHash: hash('d'),
        checkerVersion: '0.1.0',
        trialsFingerprint: hash('e'),
        casesHash: hash('f'),
      },
      grades,
    },
  };
}

const CLEAN = (_caseId: string, repeat: number) => `안녕! 오늘 어땠어? (${String(repeat)})`;
const EMOJI = (_caseId: string, repeat: number) => `안녕! 😀 (${String(repeat)})`;
const CONFIG = configSchema.parse({
  version: 1,
  adapter: { command: ['adapter'] },
  variants: [{ id: 'current', model: 'model-current' }],
  pricing: {},
  gate: { severities: ['blocking'] },
});
const CREATED_AT = new Date('2026-11-05T10:30:00.000Z');

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'model-eval-comparison-'));
});

afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

interface Scenario {
  readonly baseline?: Partial<RunSpec>;
  readonly candidate?: Partial<RunSpec>;
  readonly cases?: readonly CurrentCase[];
  readonly config?: Partial<ComparisonInput['config']>;
}

function input(scenario: Scenario = {}): ComparisonInput {
  const ids = caseIds(30);
  const cases = scenario.cases ?? ids.map((id) => currentCase(id));
  return {
    runs: {
      baseline: records(
        { variant: 'current', cases: ids, answer: CLEAN, ...scenario.baseline },
        cases,
      ),
      candidate: records(
        { variant: 'next', cases: ids, answer: CLEAN, ...scenario.candidate },
        cases,
      ),
    },
    rules: RULES,
    cases,
    config: { ...CONFIG, ...scenario.config },
    outputDir,
    now: () => CREATED_AT,
  };
}

async function compare(scenario: Scenario = {}): Promise<Comparison> {
  const comparison = await buildComparison(input(scenario));
  expect(comparisonSchema.parse(comparison)).toEqual(comparison);
  return comparison;
}

const cellKeys = (comparison: Comparison) =>
  comparison.cells.map(({ ruleId, lang, surface, gated }) => ({ ruleId, lang, surface, gated }));

describe('the comparison of two runs', () => {
  it('001 FR-021 equal runs pass: cells in rule, language and surface order, gated cells set G', async () => {
    const comparison = await compare();
    expect(cellKeys(comparison)).toEqual([
      { ruleId: 'completed', lang: 'ko', surface: 'trial', gated: true },
      { ruleId: 'no-emoji', lang: 'ko', surface: 'raw', gated: true },
      { ruleId: 'no-emoji', lang: 'ko', surface: 'final', gated: false },
    ]);
    expect(comparison.cells.map((cell) => cell.verdict)).toEqual([
      'non-inferior',
      'non-inferior',
      'non-inferior',
    ]);
    expect(comparison.gate).toEqual({
      outcome: 'pass',
      reasons: [],
      blocking: [],
      undecided: [],
      excluded: [{ ruleId: 'self-state', cause: 'review' }],
    });
    expect(comparison.warnings).toEqual([
      { code: 'excluded-from-gate', ruleId: 'self-state', params: { cause: 'review' } },
    ]);
    expect(comparison.stats).toEqual({
      confidence: 0.95,
      method: STATS_METHOD,
      gatedCells: 2,
      zLower: near(Z_L, 12),
      zUpper: near(2.241403, 6),
      minCases: 3,
    });
    expect(comparison.createdAt).toBe('2026-11-05T10:30:00.000Z');
    expect(comparison.completion).toEqual([{ lang: 'ko', trials: 150, passes: 150, rate: 1 }]);
    expect(comparison.scope).toEqual({
      targets: ['chat'],
      judgedRules: ['completed', 'no-emoji'],
      notJudgedRules: [],
      reviewRules: ['self-state'],
    });
    expect(comparison.rules.map((each) => [each.id, each.margin])).toEqual([
      ['completed', 0.1],
      ['no-emoji', 0.1],
      ['self-state', 0.1],
    ]);
    expect(comparison.samples.review).toEqual([expect.objectContaining({ ruleId: 'self-state' })]);
    expect(comparison.config).toEqual({
      gate: CONFIG.gate,
      stats: CONFIG.stats,
      report: CONFIG.report,
    });
  });

  it('001 FR-021 a regressed gated cell blocks, with candidate failures and the baseline text of the same trial', async () => {
    const comparison = await compare({ candidate: { answer: EMOJI } });
    expect(comparison.gate.outcome).toBe('block');
    expect(comparison.gate.blocking).toEqual([{ ruleId: 'no-emoji', lang: 'ko', surface: 'raw' }]);
    expect(comparison.summary.worse.map((cell) => [cell.surface, cell.verdict])).toEqual([
      ['raw', 'regressed'],
      ['final', 'regressed'],
    ]);
    const [failing] = comparison.samples.failing;
    expect(failing?.keys).toHaveLength(CONFIG.report.samples);
    expect(failing?.keys[0]).toEqual({
      variant: 'candidate',
      caseId: 'ko-00',
      repeat: 0,
      evidence: ['😀'],
    });
    expect(
      comparison.samples.texts
        .filter((text) => text.caseId === 'ko-00' && text.repeat === 0)
        .map((text) => text.variant),
    ).toEqual(['baseline', 'candidate']);
  });

  it('001 FR-021 a partial candidate is undecided with partial-run, regressed cells still listed', async () => {
    const comparison = await compare({
      candidate: { answer: EMOJI, manifest: { status: 'partial', stopReason: 'budget' } },
    });
    expect(comparison.gate.outcome).toBe('undecided');
    expect(comparison.gate.reasons.map((reason) => reason.code)).toEqual([
      'partial-run',
      'regressed',
    ]);
    expect(comparison.warnings).toContainEqual({
      code: 'partial-run',
      params: { runs: { next: { status: 'partial', stopReason: 'budget' } } },
      variants: ['next'],
    });
    const ungated = await compare({
      baseline: { manifest: { status: 'running' } },
      config: { gate: { severities: [], margin: 0.1 } },
    });
    expect(ungated.gate.outcome).toBe('undecided');
    expect(ungated.warnings).toContainEqual({
      code: 'partial-run',
      params: { runs: { current: { status: 'running', stopReason: null } } },
      variants: ['current'],
    });
  });

  it('001 FR-021 systematic failures fail completed and their messages reach dominant-error', async () => {
    const failed = new Set(caseIds(12));
    const comparison = await compare({
      candidate: {
        answer: (caseId, repeat) => (failed.has(caseId) ? ADAPTER_ERROR : CLEAN(caseId, repeat)),
      },
    });
    const completed = comparison.cells[0];
    expect(completed?.systematic).toEqual({
      baseline: { trials: 0, cases: 0 },
      candidate: { trials: 60, cases: 12 },
    });
    expect(completed?.verdict).toBe('regressed');
    expect(comparison.gate.reasons.slice(0, 2)).toEqual([
      { code: 'dominant-error', params: { message: 'adapter failure', share: 1 } },
      { code: 'regressed', ruleId: 'completed', lang: 'ko', surface: 'trial' },
    ]);
  });

  it('001 FR-031 dominant-error compares redacted messages', async () => {
    const failed = new Set(caseIds(12));
    const comparison = await compare({
      candidate: {
        answer: (caseId, repeat) => (failed.has(caseId) ? ADAPTER_ERROR : CLEAN(caseId, repeat)),
      },
      config: { redact: [{ pattern: 'fail\\w+', replace: '[redacted]' }] },
    });
    expect(comparison.gate.reasons[0]).toEqual({
      code: 'dominant-error',
      params: { message: 'adapter [redacted]', share: 1 },
    });
  });

  it('001 FR-021 abandoned trials inside systematic failures of a gated completed cell', async () => {
    const comparison = await compare({
      candidate: {
        answer: (caseId, repeat) => (caseId === 'ko-00' ? ADAPTER_ERROR : CLEAN(caseId, repeat)),
      },
    });
    expect(comparison.cells[0]?.systematic?.candidate).toEqual({ trials: 5, cases: 1 });
    expect(comparison.gate.reasons.map((reason) => reason.code)).not.toContain(
      'abandoned-in-systematic',
    );
    const abandoned = input({
      candidate: {
        answer: (caseId, repeat) => (caseId === 'ko-00' ? ADAPTER_ERROR : CLEAN(caseId, repeat)),
      },
    });
    const lines = abandoned.runs.candidate.lines.map((line) =>
      'status' in line && line.status === 'error' && line.repeat < 2
        ? { ...line, error: { ...line.error, abandoned: 'timeout' as const } }
        : line,
    );
    const result = await buildComparison({
      ...abandoned,
      runs: { ...abandoned.runs, candidate: { ...abandoned.runs.candidate, lines } },
    });
    expect(result.gate.reasons).toContainEqual({
      code: 'abandoned-in-systematic',
      ruleId: 'completed',
      lang: 'ko',
      surface: 'trial',
      params: { trials: { next: { timeout: 2, restart: 0 } }, timeoutMs: { next: 120_000 } },
    });
  });

  it('001 FR-029 a low-baseline cell is not gated and is left out of G', async () => {
    const comparison = await compare({
      baseline: {
        answer: (caseId, repeat) =>
          caseId < 'ko-15' ? EMOJI(caseId, repeat) : CLEAN(caseId, repeat),
      },
    });
    const raw = comparison.cells.find(
      (cell) => cell.ruleId === 'no-emoji' && cell.surface === 'raw',
    );
    expect(raw?.baseline.rate).toBe(0.5);
    expect(raw?.gated).toBe(false);
    expect(comparison.stats.gatedCells).toBe(1);
    expect(comparison.stats.zUpper).toBe(comparison.stats.zLower);
    expect(comparison.gate.outcome).toBe('pass');
  });

  it('001 FR-027 coverage: common cases, cases of one run only, and cases dropped for a changed hash', async () => {
    const shared = caseIds(4);
    const cases = [
      ...shared.map((id) => currentCase(id)),
      currentCase('changed', hash('9')),
      currentCase('baseline-only'),
      currentCase('candidate-only'),
    ];
    const comparison = await compare({
      cases,
      baseline: { cases: [...shared, 'changed', 'deleted', 'baseline-only'] },
      candidate: { cases: [...shared, 'deleted', 'changed', 'candidate-only'] },
    });
    expect(comparison.coverage).toEqual({
      commonCases: 4,
      baselineOnly: ['baseline-only'],
      candidateOnly: ['candidate-only'],
      changedHash: ['changed', 'deleted'],
    });
    expect(comparison.completion).toEqual([{ lang: 'ko', trials: 20, passes: 20, rate: 1 }]);
  });
});

describe('comparisonId', () => {
  it('001 SC-002 the same inputs give the same comparison, apart from createdAt', async () => {
    const first = await compare();
    const later = await buildComparison({
      ...input(),
      now: () => new Date('2026-11-06T00:00:00.000Z'),
    });
    expect(first.comparisonId).toMatch(/^cmp-[0-9a-f]{12}$/);
    expect({ ...later, createdAt: first.createdAt }).toEqual(first);
  });

  it('001 SC-002 each input of the ID changes it', async () => {
    const base = (await compare()).comparisonId;
    const variants: Scenario[] = [
      { baseline: { gradeSetId: 'gs-000000000001' } },
      { candidate: { gradeSetId: 'gs-000000000002' } },
      { baseline: { manifest: { status: 'running' } } },
      { candidate: { manifest: { status: 'partial', stopReason: 'interrupted' } } },
      { config: { gate: { ...CONFIG.gate, margin: 0.05 } } },
      { config: { stats: { ...CONFIG.stats, confidence: 0.9 } } },
      { config: { report: { ...CONFIG.report, samples: 5 } } },
      { config: { redact: [{ pattern: 'sk-[a-z]+', replace: '[key]' }] } },
    ];
    const ids = await Promise.all(
      variants.map(async (scenario) => (await buildComparison(input(scenario))).comparisonId),
    );
    expect(new Set([base, ...ids]).size).toBe(variants.length + 1);
  });
});

describe('priorComparisons', () => {
  async function saveComparison(
    name: string,
    runIds: readonly [string, string],
    fingerprints: readonly [Sha256, Sha256] = [hash('a'), hash('b')],
  ): Promise<void> {
    const folder = path.join(outputDir, 'comparisons', name);
    await mkdir(folder, { recursive: true });
    const run = (runId: string, fingerprint: Sha256) => ({
      runId,
      variant: { id: 'x', model: 'm', fingerprint },
    });
    await writeFile(
      path.join(folder, 'comparison.json'),
      JSON.stringify({
        baseline: run(runIds[0], fingerprints[0]),
        candidate: run(runIds[1], fingerprints[1]),
      }),
    );
  }

  it('001 FR-025 counts distinct earlier run pairs with the same fingerprints in the same roles', async () => {
    const current = '20261105-101500-current-1a2b';
    const next = '20261105-101500-next-a1b2';
    await saveComparison('cmp-000000000001', [current, next]);
    await saveComparison('cmp-000000000002', [current, '20261106-090000-next-0001']);
    await saveComparison('cmp-000000000003', [current, '20261106-090000-next-0001']);
    await saveComparison('cmp-000000000004', ['20261106-090000-current-0002', next]);
    await saveComparison('cmp-000000000005', [current, next], [hash('b'), hash('a')]);
    await saveComparison('.tmp-123-abc-cmp-000000000006', [current, '20261107-090000-next-0003']);
    await mkdir(path.join(outputDir, 'comparisons', 'cmp-000000000007'));
    await writeFile(path.join(outputDir, 'comparisons', 'cmp-000000000008'), 'not a folder');
    expect((await compare()).priorComparisons).toBe(2);
  });

  it('001 FR-025 zero without a comparisons folder', async () => {
    expect((await compare()).priorComparisons).toBe(0);
  });
});
