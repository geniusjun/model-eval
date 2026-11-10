import { beforeAll, describe, expect, it } from 'vitest';

import { E2E, runJson, SWAP, swapJson, useProjects, type JsonOutcome } from './support/commands.js';
import type { CliResult } from './support/cli.js';
import { trialSeed } from './support/mock.js';
import {
  attemptLines,
  cellKeyOf,
  cellOf,
  comparisonOf,
  entries,
  jsonAt,
  readComparison,
  readGradeSet,
  readRun,
  sendLines,
  swapRunOf,
  trialKey,
  type SwapEnvelope,
} from './support/outputs.js';
import { greetCases, type Project } from './support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA, SCRIPT_JA_QUOTE, withSeverity } from './support/rules.js';

// User Story 1, acceptance scenarios 1, 2, 6, 7, 12 and 13, against the mock adapter.
// Every project uses 3 cases per language and 2 repeats unless a test says otherwise, so a cell
// has K = 3 common cases and 6 trials per variant.

const project = useProjects();

const GATED = { gate: { severities: ['blocking' as const] } };
const TWO_LANGS = greetCases({ ko: 3, ja: 3 });
const RULES = [ANSWERED, SCRIPT_JA, NO_EMOJI];

/** z_{0.975}: the uncorrected z of confidence 0.95 (data-model §Statistics, Levels). */
const Z_LOWER = 1.959964;
const MARGIN = 0.1;

/** n_min(m) = ⌈z_L²(1 − m)/m⌉ (data-model §Statistics): 35 for m = 0.10. */
const N_MIN = Math.ceil((Z_LOWER ** 2 * (1 - MARGIN)) / MARGIN);

/**
 * The repeats a new run needs for a cell where both variants passed every trial (data-model
 * §Statistics, Trials needed): Δ̂ = 0 > −m so z = z_L, and every d_i is 0 so σ²_B = 0.
 */
function repeatsNeededAtFullCompliance(cases: number, repeats: number): number {
  const pooledTrials = cases * repeats;
  const z2 = Z_LOWER ** 2;
  const shrunk = (pooledTrials + z2 / 2) / (pooledTrials + z2);
  const w = 2 * shrunk * (1 - shrunk);
  const zt = Z_LOWER + 0.84;
  const c = (cases * MARGIN ** 2) / zt ** 2;
  return Math.max(Math.ceil(w / c), Math.ceil(N_MIN / cases), Math.floor(repeats) + 1);
}

function judgedCellKeys(envelope: SwapEnvelope): string[] {
  return comparisonOf(envelope)
    .cells.filter((cell) => cell.verdict !== 'not-applicable')
    .map(cellKeyOf)
    .sort();
}

/** The first of these words that appears in a text, by position. */
function firstMentioned(text: string, words: readonly string[]): string | undefined {
  return words
    .map((word) => ({ word, at: text.indexOf(word) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)[0]?.word;
}

describe('001 US1 scenarios 1 and 2: a candidate that breaks a blocking rule in Japanese', () => {
  let regressed: Project;
  let outcome: JsonOutcome<SwapEnvelope>;

  beforeAll(async () => {
    regressed = await project({
      scenario: 'swap-script-ja',
      rules: RULES,
      cases: TWO_LANGS,
      config: GATED,
    });
    outcome = await swapJson(regressed);
  }, E2E.timeout);

  it('001 FR-021 scenario 1: every rule × language × surface cell has both rates with intervals, a difference with an interval and a verdict', () => {
    expect(outcome.cli.code).toBe(1);
    expect(judgedCellKeys(outcome.envelope)).toEqual(
      [
        'answered/ja/trial',
        'answered/ko/trial',
        'no-emoji/ja/final',
        'no-emoji/ja/raw',
        'no-emoji/ko/final',
        'no-emoji/ko/raw',
        'script-ja/ja/final',
        'script-ja/ja/raw',
      ].sort(),
    );
    for (const cell of comparisonOf(outcome.envelope).cells) {
      if (cell.verdict === 'not-applicable') {
        continue;
      }
      expect(cell.cases).toBe(3);
      for (const rate of [cell.baseline, cell.candidate]) {
        expect(rate.trials).toBe(6);
        expect(rate.rate).not.toBeNull();
        expect(rate.low).not.toBeNull();
        expect(rate.high).not.toBeNull();
        expect(rate.low ?? Number.NaN).toBeLessThanOrEqual(rate.rate ?? Number.NaN);
        expect(rate.rate ?? Number.NaN).toBeLessThanOrEqual(rate.high ?? Number.NaN);
      }
      const diff = cell.diff ?? { estimate: Number.NaN, low: Number.NaN, high: Number.NaN };
      expect(cell.diff).not.toBeNull();
      expect(diff.estimate).toBeCloseTo(
        (cell.candidate.rate ?? Number.NaN) - (cell.baseline.rate ?? Number.NaN),
        9,
      );
      expect(diff.low).toBeLessThanOrEqual(diff.estimate);
      expect(diff.estimate).toBeLessThanOrEqual(diff.high);
    }
  });

  it('001 FR-022 scenario 1: a 100-point drop at 6 trials is regressed and equal full compliance at 6 trials is too few samples', () => {
    expect(outcome.cli.code).toBe(1);
    // 0 of 6 against 6 of 6: U = −1 + √(u_c² + (1 − l_b)²) stays below −0.10 with or without the
    // multiplicity correction. 6 of 6 on both sides: L = −(1 − 6/(6 + z_L²)) ≈ −0.39 < −m and
    // ñ = 6 < n_min = 35, so verdict row 7.
    const comparison = comparisonOf(outcome.envelope);
    const verdicts = Object.fromEntries(
      comparison.cells
        .filter((cell) => cell.verdict !== 'not-applicable')
        .map((cell) => [cellKeyOf(cell), cell.verdict]),
    );
    expect(verdicts).toEqual({
      'answered/ja/trial': 'insufficient',
      'answered/ko/trial': 'insufficient',
      'no-emoji/ja/final': 'insufficient',
      'no-emoji/ja/raw': 'insufficient',
      'no-emoji/ko/final': 'insufficient',
      'no-emoji/ko/raw': 'insufficient',
      'script-ja/ja/final': 'regressed',
      'script-ja/ja/raw': 'regressed',
    });
    const raw = cellOf(comparison, 'script-ja', 'ja', 'raw');
    expect(raw.baseline.rate).toBe(1);
    expect(raw.candidate.rate).toBe(0);
    expect(raw.gated).toBe(true);
    expect(cellOf(comparison, 'script-ja', 'ja', 'final').gated).toBe(false);
  });

  it('001 FR-025 scenario 2: the gate blocks on the regressed cell and exits 1', () => {
    const { envelope } = outcome;
    expect(envelope.exit).toEqual({ code: 1, name: 'failed' });
    const { gate } = swapRunOf(envelope);
    expect(gate?.outcome).toBe('block');
    expect(gate?.blocking).toEqual([{ ruleId: 'script-ja', lang: 'ja', surface: 'raw' }]);
    expect(gate?.reasons[0]).toEqual({
      code: 'regressed',
      ruleId: 'script-ja',
      lang: 'ja',
      surface: 'raw',
    });
    expect(gate).toEqual(comparisonOf(envelope).gate);
  });

  it('001 FR-028 scenario 2: the summary lists the cell as worse and the comparison keeps its prompt sentence', () => {
    expect(outcome.cli.code).toBe(1);
    const comparison = comparisonOf(outcome.envelope);
    expect(comparison.summary.worse).toContainEqual(
      expect.objectContaining({
        ruleId: 'script-ja',
        lang: 'ja',
        surface: 'raw',
        verdict: 'regressed',
      }),
    );
    const rule = comparison.rules.find((candidate) => candidate.id === 'script-ja');
    expect(rule?.anchors).toEqual([{ lang: 'ja', quote: SCRIPT_JA_QUOTE }]);
  });

  it('001 FR-029 scenario 2: failing examples hold the candidate raw and final text with the baseline text of the same trial', () => {
    expect(outcome.cli.code).toBe(1);
    const { samples } = comparisonOf(outcome.envelope);
    const failing = samples.failing.find(
      (entry) => entry.ruleId === 'script-ja' && entry.lang === 'ja' && entry.surface === 'raw',
    );
    // report.samples defaults to 3: one per case, round-robin, sorted by case and repeat.
    expect(
      failing?.keys.map(({ variant, caseId, repeat }) => ({ variant, caseId, repeat })),
    ).toEqual(
      [1, 2, 3].map((n) => ({ variant: 'candidate', caseId: `greet-ja-${String(n)}`, repeat: 0 })),
    );
    for (const key of failing?.keys ?? []) {
      const text = (variant: 'baseline' | 'candidate') =>
        samples.texts.find(
          (entry) =>
            entry.variant === variant && entry.caseId === key.caseId && entry.repeat === key.repeat,
        );
      const answer = `はい、${key.caseId}。${String(key.repeat)}`;
      expect(text('candidate')).toMatchObject({ raw: `${answer} 안녕`, final: `${answer} 안녕` });
      expect(text('baseline')).toMatchObject({ raw: answer, final: answer });
    }
  });

  it('001 FR-029 scenario 2: report.md names the cell first and carries the prompt sentence and a failing raw answer', async () => {
    expect(outcome.cli.code).toBe(1);
    const { comparisonId } = comparisonOf(outcome.envelope);
    const { reportMarkdown } = await readComparison(regressed.outputDir, comparisonId);
    expect(firstMentioned(reportMarkdown, ['script-ja', 'answered', 'no-emoji'])).toBe('script-ja');
    expect(reportMarkdown).toContain(SCRIPT_JA_QUOTE);
    expect(reportMarkdown).toContain('はい、greet-ja-1。0 안녕');
  });

  it(
    '001 FR-028 scenario 2: human output names the blocked cell before any other rule and exits 1',
    async () => {
      const human: CliResult = await regressed.run([...SWAP]);
      expect(human.code).toBe(1);
      expect(firstMentioned(human.stdout, ['script-ja', 'answered', 'no-emoji'])).toBe('script-ja');
    },
    E2E.timeout,
  );

  it('001 FR-006 the sample-plan warnings are raised once per gated cell, not once per run', () => {
    expect(outcome.cli.code).toBe(1);
    const { warnings } = outcome.envelope;
    const gatedCells = [
      { ruleId: 'answered', lang: 'ja', surface: 'trial' },
      { ruleId: 'answered', lang: 'ko', surface: 'trial' },
      { ruleId: 'script-ja', lang: 'ja', surface: 'raw' },
    ];
    const fewCases = warnings
      .filter((warning) => warning.code === 'few-cases')
      .map((warning) => ({
        ruleId: warning.ruleId,
        lang: warning.lang,
        ...('params' in warning ? warning.params : {}),
      }));
    expect(fewCases).toHaveLength(3);
    expect(fewCases).toEqual(
      expect.arrayContaining(gatedCells.map((cell) => ({ ...cell, cases: 3 }))),
    );
    const unreachable = warnings
      .filter((warning) => warning.code === 'margin-unreachable')
      .map((warning) => ({
        ruleId: warning.ruleId,
        lang: warning.lang,
        ...('params' in warning ? warning.params : {}),
      }));
    expect(unreachable).toHaveLength(3);
    expect(unreachable).toEqual(
      expect.arrayContaining(
        gatedCells.map((cell) => ({ ...cell, plannedTrials: 6, nMin: N_MIN, margin: MARGIN })),
      ),
    );
  });
});

describe('001 US1 scenario 6: gated cells whose interval straddles the margin', () => {
  it(
    '001 FR-024 exits 2 and every undecided gated cell says how many repeats and trials a new run needs',
    async () => {
      const clean = await project({
        scenario: 'swap-clean',
        rules: RULES,
        cases: TWO_LANGS,
        config: GATED,
      });
      const { cli, envelope } = await swapJson(clean);
      expect(cli.code).toBe(2);
      expect(envelope.exit).toEqual({ code: 2, name: 'undecided' });

      const repeats = repeatsNeededAtFullCompliance(3, 2);
      const needed = {
        kind: 'repeats',
        repeats,
        cellTrials: 3 * repeats,
        trialsPerVariant: TWO_LANGS.length * repeats,
        nearMargin: repeats > 10 * 2,
      };
      const gatedKeys = ['answered/ja/trial', 'answered/ko/trial', 'script-ja/ja/raw'];
      const comparison = comparisonOf(envelope);
      expect(comparison.gate.outcome).toBe('undecided');
      expect(comparison.gate.blocking).toEqual([]);
      const keyOf = (entry: {
        ruleId?: string | undefined;
        lang?: string | undefined;
        surface?: string | undefined;
      }) => `${entry.ruleId ?? ''}/${entry.lang ?? ''}/${entry.surface ?? ''}`;
      expect(comparison.gate.undecided.map((entry) => [keyOf(entry), entry.needed])).toEqual(
        expect.arrayContaining(gatedKeys.map((key) => [key, needed])),
      );
      expect(comparison.gate.undecided).toHaveLength(3);
      expect(
        comparison.gate.reasons.map((reason) => `${reason.code} ${keyOf(reason)}`).sort(),
      ).toEqual(gatedKeys.map((key) => `cell-undecided ${key}`).sort());

      for (const key of gatedKeys) {
        const cell = comparison.cells.find((candidate) => cellKeyOf(candidate) === key);
        expect(cell?.verdict).toBe('insufficient');
        expect(cell?.needed).toEqual(needed);
        expect(cell?.diff?.low).toBeLessThan(-MARGIN);
        expect(cell?.diff?.high).toBeGreaterThan(-MARGIN);
      }
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 7: a rule of three languages that regresses only in Japanese', () => {
  it(
    '001 FR-021 the Japanese cell is regressed and blocks while the pooled value has no verdict',
    async () => {
      // Six gated cells correct the upper bound to z_{1−0.025/6} ≈ 2.64; 0 of 6 against 6 of 6
      // still gives U ≈ −0.24 < −0.10, so 2 repeats suffice.
      const threeLangs = await project({
        scenario: 'swap-three-langs',
        rules: [ANSWERED, withSeverity(NO_EMOJI, 'blocking')],
        cases: greetCases({ ko: 3, ja: 3, en: 3 }),
        config: GATED,
      });
      const { cli, envelope } = await swapJson(threeLangs);
      expect(cli.code).toBe(1);
      const comparison = comparisonOf(envelope);
      expect(comparison.gate.outcome).toBe('block');
      expect(comparison.gate.blocking).toEqual([
        { ruleId: 'no-emoji', lang: 'ja', surface: 'raw' },
      ]);
      expect(cellOf(comparison, 'no-emoji', 'ja', 'raw').verdict).toBe('regressed');
      expect(cellOf(comparison, 'no-emoji', 'ko', 'raw').verdict).not.toBe('regressed');
      expect(cellOf(comparison, 'no-emoji', 'en', 'raw').verdict).not.toBe('regressed');

      const pooled = comparison.aggregates.find(
        (aggregate) => aggregate.ruleId === 'no-emoji' && aggregate.surface === 'raw',
      );
      expect(pooled).toBeDefined();
      const written = jsonAt(JSON.parse(cli.stdout), ['result', 'comparison', 'aggregates']);
      const writtenList: readonly unknown[] = Array.isArray(written) ? written : [];
      const writtenPooled = writtenList.find(
        (aggregate) =>
          jsonAt(aggregate, ['ruleId']) === 'no-emoji' && jsonAt(aggregate, ['surface']) === 'raw',
      );
      expect(writtenPooled).toBeDefined();
      expect(writtenPooled).not.toHaveProperty('verdict');
      expect(pooled?.baseline).toMatchObject({ trials: 18, passes: 18 });
      expect(pooled?.candidate).toMatchObject({ trials: 18, passes: 12 });
      expect(pooled?.candidate.rate).toBeCloseTo(12 / 18, 9);
      expect(pooled?.diff).toBeCloseTo(12 / 18 - 1, 9);
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 12: no gate and two finished runs', () => {
  let clean: Project;
  let outcome: JsonOutcome<SwapEnvelope>;

  beforeAll(async () => {
    clean = await project({ scenario: 'swap-clean', rules: RULES, cases: TWO_LANGS });
    outcome = await swapJson(clean);
  }, E2E.timeout);

  it('001 FR-025 cells are judged, the gate is no-gate and the exit code is 0', () => {
    const { cli, envelope } = outcome;
    expect(cli.code).toBe(0);
    expect(envelope.exit).toEqual({ code: 0, name: 'ok' });
    const comparison = comparisonOf(envelope);
    expect(judgedCellKeys(envelope)).toHaveLength(8);
    expect(comparison.gate).toMatchObject({
      outcome: 'no-gate',
      reasons: [{ code: 'no-gate' }],
      blocking: [],
      undecided: [],
    });
    expect(swapRunOf(envelope).gate).toEqual(comparison.gate);
    expect(envelope.warnings.filter((warning) => warning.code === 'few-cases')).toEqual([]);
  });

  it('001 FR-032 both variants send every trial once with the per-trial seed of data-model §Identifiers', async () => {
    expect(outcome.cli.code).toBe(0);
    const { runs } = swapRunOf(outcome.envelope);
    for (const runId of runs) {
      const { lines } = await readRun(clean.outputDir, runId);
      const seeds = new Map(
        attemptLines(lines).map((line) => [trialKey(line.caseId, line.repeat), line.seed]),
      );
      expect(seeds.size).toBe(12);
      for (const [key, seed] of seeds) {
        const [caseId = '', repeat = ''] = key.split('#');
        expect(seed).toBe(trialSeed(caseId, Number(repeat)));
      }
    }
    const requests = await clean.generateRequests();
    for (const variant of ['current', 'next']) {
      const sent = requests.filter((request) => request.variant === variant);
      expect(sent.map((request) => trialKey(request.caseId, request.repeat)).sort()).toEqual(
        TWO_LANGS.flatMap((item) => [0, 1].map((repeat) => trialKey(item.id, repeat))).sort(),
      );
      for (const request of sent) {
        expect(request.seed).toBe(trialSeed(request.caseId, request.repeat));
      }
    }
  });

  it('001 FR-032 repeat 1 of a case is sent only after repeat 0 of that case finished', async () => {
    expect(outcome.cli.code).toBe(0);
    for (const runId of swapRunOf(outcome.envelope).runs) {
      const { lines } = await readRun(clean.outputDir, runId);
      for (const item of TWO_LANGS) {
        const finished = lines.findIndex(
          (line) => 'status' in line && line.caseId === item.id && line.repeat === 0,
        );
        const nextSend = lines.findIndex(
          (line) => 'sending' in line && line.caseId === item.id && line.repeat === 1,
        );
        expect(finished).toBeGreaterThanOrEqual(0);
        expect(nextSend).toBeGreaterThan(finished);
      }
      expect(sendLines(lines)).toHaveLength(12);
    }
  });

  it('001 FR-032 the trials of both variants are interleaved', async () => {
    expect(outcome.cli.code).toBe(0);
    const requests = await clean.generateRequests();
    const times = (variant: string) =>
      requests.filter((request) => request.variant === variant).map((request) => request.at);
    const baseline = times('current');
    const candidate = times('next');
    expect(Math.min(...baseline)).toBeLessThanOrEqual(Math.max(...candidate));
    expect(Math.min(...candidate)).toBeLessThanOrEqual(Math.max(...baseline));
  });
});

describe('001 US1 scenario 13: no gate and a baseline that misses half of its Japanese answers', () => {
  it(
    '001 FR-025 the gate is undecided with baseline-incomplete for Japanese and the exit code is 2',
    async () => {
      const empty = await project({
        scenario: 'swap-baseline-empty-ja',
        rules: RULES,
        cases: TWO_LANGS,
      });
      const { cli, envelope } = await swapJson(empty);
      expect(cli.code).toBe(2);
      expect(envelope.exit).toEqual({ code: 2, name: 'undecided' });
      const comparison = comparisonOf(envelope);
      expect(comparison.gate.outcome).toBe('undecided');
      expect(comparison.gate.reasons).toEqual([
        { code: 'baseline-incomplete', lang: 'ja', params: { rate: 0 } },
      ]);
      expect(comparison.completion).toEqual(
        expect.arrayContaining([
          { lang: 'ja', trials: 6, passes: 0, rate: 0 },
          { lang: 'ko', trials: 6, passes: 6, rate: 1 },
        ]),
      );
    },
    E2E.timeout,
  );
});

describe('001 FR-030 run records and grades one variant', () => {
  it(
    '001 FR-018 run --json validates against run.schema.json and writes the run and its grade set',
    async () => {
      const single = await project({
        scenario: 'swap-clean',
        rules: RULES,
        cases: TWO_LANGS,
        config: GATED,
      });
      const { cli, envelope } = await runJson(single, 'current');
      expect(cli.code).toBe(0);
      expect(envelope.exit).toEqual({ code: 0, name: 'ok' });
      const { result } = envelope;
      if (result === null || 'plan' in result) {
        throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
      }
      expect(result.runId).toMatch(/^\d{8}-\d{6}-current-[0-9a-f]{4}$/);
      expect(result.status).toBe('complete');
      expect(await entries(`${single.outputDir}/runs`)).toEqual([result.runId]);

      const run = await readRun(single.outputDir, result.runId);
      expect(run.manifest.status).toBe('complete');
      expect(run.manifest.swapId).toBeUndefined();
      expect(run.manifest.budget.scope).toBe('run');
      expect(attemptLines(run.lines)).toHaveLength(12);

      const { gradeSetId } = result;
      if (gradeSetId === undefined) {
        throw new Error('run --json names no grade set');
      }
      const gradeSet = await readGradeSet(run.dir, gradeSetId);
      expect(gradeSet.header).toMatchObject({ gradeSetId, runId: result.runId });
      // Per trial: `answered` on the trial surface; no-emoji raw and final; script-ja raw and
      // final in Japanese only.
      const expected = TWO_LANGS.flatMap((item) =>
        [0, 1].flatMap((repeat) => [
          `${item.id}#${String(repeat)} answered trial`,
          ...(item.lang === 'ja'
            ? [
                `${item.id}#${String(repeat)} script-ja raw`,
                `${item.id}#${String(repeat)} script-ja final`,
              ]
            : []),
          `${item.id}#${String(repeat)} no-emoji raw`,
          `${item.id}#${String(repeat)} no-emoji final`,
        ]),
      );
      expect(
        gradeSet.grades
          .map(
            (grade) => `${grade.caseId}#${String(grade.repeat)} ${grade.ruleId} ${grade.surface}`,
          )
          .sort(),
      ).toEqual(expected.sort());
      expect(new Set(gradeSet.grades.map((grade) => grade.outcome))).toEqual(new Set(['pass']));
    },
    E2E.timeout,
  );
});
