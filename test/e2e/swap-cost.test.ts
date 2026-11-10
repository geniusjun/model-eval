import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { E2E, runJson, SWAP, swapJson, useProjects } from './support/commands.js';
import {
  attemptLines,
  comparisonOf,
  costLines,
  dryRunPlanOf,
  entries,
  jsonAt,
  readRun,
  readSwapRecord,
  swapRunOf,
  trialKey,
  type RunFiles,
} from './support/outputs.js';
import {
  greetCases,
  MODEL_A,
  MODEL_B,
  type ConfigOverrides,
  type Project,
} from './support/project.js';
import { ANSWERED, NO_EMOJI } from './support/rules.js';

// User Story 1, acceptance scenarios 3, 4 and 10, and the cost rules of data-model §Cost.

const project = useProjects();

/** USD per 1M tokens, the same for both models; cacheWrite equals input so repeat 0 costs input. */
const PRICE = { input: 30, cachedInput: 10, cacheWrite: 30, output: 20 };
/** `inputTokens` of the render in swap-cost.yaml. */
const INPUT_TOKENS = 1000;
/** `estimate.outputTokens`; swap-cost.yaml declares no output limit. */
const OUTPUT_TOKENS = 1000;
const CASES = greetCases({ ko: 2, ja: 2 });
const REPEATS = 2;
const TRIALS_PER_VARIANT = CASES.length * REPEATS;

const perMillion = (tokens: number, price: number): number => (tokens * price) / 1_000_000;

// basis `structure` (data-model §Cost, Three Estimates): repeat 0 writes the whole prompt to the
// cache, later repeats hit it, output is estimate.outputTokens and each trial makes one call.
const REPEAT_0_USD =
  perMillion(INPUT_TOKENS, PRICE.cacheWrite) + perMillion(OUTPUT_TOKENS, PRICE.output);
const LATER_REPEAT_USD =
  perMillion(INPUT_TOKENS, PRICE.cachedInput) + perMillion(OUTPUT_TOKENS, PRICE.output);
const EXPECTED_PER_VARIANT = CASES.length * (REPEAT_0_USD + (REPEATS - 1) * LATER_REPEAT_USD);
const EXPECTED_USD = 2 * EXPECTED_PER_VARIANT; // 0.64
// Conservative: no cache hits, one call per trial, output from the expected-estimate assumption.
const CONSERVATIVE_PER_TRIAL =
  perMillion(INPUT_TOKENS, Math.max(PRICE.input, PRICE.cacheWrite)) +
  perMillion(OUTPUT_TOKENS, PRICE.output);
const CONSERVATIVE_USD = 2 * TRIALS_PER_VARIANT * CONSERVATIVE_PER_TRIAL; // 0.8
// Reservation: the case's input estimate and estimate.outputTokens, times one billed call.
const RESERVATION_USD =
  perMillion(INPUT_TOKENS, Math.max(PRICE.input, PRICE.cacheWrite)) +
  perMillion(OUTPUT_TOKENS, PRICE.output);

const COST_CONFIG: ConfigOverrides = {
  pricing: { [MODEL_A]: PRICE, [MODEL_B]: PRICE },
  estimate: { outputTokens: OUTPUT_TOKENS },
  sampling: { repeats: REPEATS },
};

function costProject(config: ConfigOverrides = {}, scenario = 'swap-cost'): Promise<Project> {
  return project({
    scenario,
    rules: [ANSWERED, NO_EMOJI],
    cases: CASES,
    config: { ...COST_CONFIG, ...config },
  });
}

/** A refused start leaves no run, no swap record and no generate request behind. */
async function expectNothingSent(target: Project): Promise<void> {
  expect(await target.generateRequests()).toEqual([]);
  expect(await entries(path.join(target.outputDir, 'runs'))).toEqual([]);
  expect(await entries(path.join(target.outputDir, 'swaps'))).toEqual([]);
}

function totalCostUsd(run: RunFiles): number {
  return [...attemptLines(run.lines), ...costLines(run.lines)].reduce(
    (sum, line) => sum + (line.costUsd ?? 0),
    0,
  );
}

describe('001 FR-011 --dry-run', () => {
  it(
    '001 FR-011 swap --dry-run shows calls, tokens, both estimates, the reservation and the basis, then exits 0 without a run',
    async () => {
      const dry = await costProject();
      const { cli, envelope } = await swapJson(dry, ['--dry-run']);
      expect(cli.code).toBe(0);
      const plan = dryRunPlanOf(envelope);
      const variants = [...plan.variants].sort((a, b) => a.variant.localeCompare(b.variant));
      expect(variants.map(({ reservationUsd: _reservation, ...rest }) => rest)).toEqual(
        ['current', 'next'].map((variant) => ({
          variant,
          trials: TRIALS_PER_VARIANT,
          calls: TRIALS_PER_VARIANT,
          inputTokens: TRIALS_PER_VARIANT * INPUT_TOKENS,
          outputTokens: TRIALS_PER_VARIANT * OUTPUT_TOKENS,
          basis: { ko: 'structure', ja: 'structure' },
        })),
      );
      for (const { reservationUsd } of variants) {
        expect(reservationUsd).toBeCloseTo(RESERVATION_USD, 9);
      }
      expect(plan.expectedUsd).toBeCloseTo(EXPECTED_USD, 9);
      expect(plan.conservativeUsd).toBeCloseTo(CONSERVATIVE_USD, 9);
      expect(plan.maxCostUsd).toBe(1);
      expect(plan.cells).toEqual([]);
      await expectNothingSent(dry);
    },
    E2E.timeout,
  );

  it(
    '001 FR-030 run --dry-run validates against run.schema.json and plans one variant',
    async () => {
      const dry = await costProject();
      const { cli, envelope } = await runJson(dry, 'current', ['--dry-run']);
      expect(cli.code).toBe(0);
      const plan = dryRunPlanOf(envelope);
      expect(plan.variants.map((entry) => entry.variant)).toEqual(['current']);
      expect(plan.expectedUsd).toBeCloseTo(EXPECTED_PER_VARIANT, 9);
      expect(plan.conservativeUsd).toBeCloseTo(TRIALS_PER_VARIANT * CONSERVATIVE_PER_TRIAL, 9);
      await expectNothingSent(dry);
    },
    E2E.timeout,
  );

  it(
    '001 FR-011 --dry-run exits 5 when the expected cost exceeds the cap',
    async () => {
      const dry = await costProject();
      const { cli, envelope } = await swapJson(dry, ['--dry-run', '--max-cost-usd', '0.6']);
      expect(cli.code).toBe(5);
      expect(envelope.exit).toEqual({ code: 5, name: 'over-budget' });
      expect(dryRunPlanOf(envelope).maxCostUsd).toBe(0.6);
      await expectNothingSent(dry);
    },
    E2E.timeout,
  );

  it(
    '001 FR-011 --dry-run exits 4 when input tokens cannot be estimated',
    async () => {
      // No render and no estimate.inputTokens (data-model §Cost, Input token estimate).
      const dry = await costProject({}, 'swap-no-render');
      const { cli, envelope } = await swapJson(dry, ['--dry-run']);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      // The message asks for the missing setting.
      expect(cli.stderr).toContain('estimate.inputTokens');
      await expectNothingSent(dry);
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 3: an expected cost above the cap', () => {
  it(
    '001 FR-011 no model is called, nothing is written and the exit code is 5',
    async () => {
      const refused = await costProject({ budget: { maxCostUsd: 0.6 } });
      const { cli, envelope } = await swapJson(refused);
      expect(cli.code).toBe(5);
      expect(envelope.exit).toEqual({ code: 5, name: 'over-budget' });
      await expectNothingSent(refused);
    },
    E2E.timeout,
  );

  it(
    '001 FR-011 human output shows both estimates',
    async () => {
      const refused = await costProject({ budget: { maxCostUsd: 0.6 } });
      const cli = await refused.run([...SWAP]);
      expect(cli.code).toBe(5);
      const shown = cli.stdout + cli.stderr;
      expect(shown).toMatch(/0\.64(?!\d)/);
      expect(shown).toMatch(/0\.80?(?!\d)/);
      await expectNothingSent(refused);
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 4: an expected cost within the cap and a conservative estimate above it', () => {
  it(
    '001 FR-011 the swap starts with one conservative-over-budget warning and finishes',
    async () => {
      // 0.64 expected ≤ 0.7 < 0.8 conservative. In flight at most 8 reservations of 0.05.
      const warned = await costProject({ budget: { maxCostUsd: 0.7 } });
      const { cli, envelope } = await swapJson(warned);
      expect(cli.code).toBe(0);
      const warnings = envelope.warnings.filter(
        (warning) => warning.code === 'conservative-over-budget',
      );
      expect(warnings).toHaveLength(1);
      const [warning] = warnings;
      const params = warning !== undefined && 'params' in warning ? warning.params : undefined;
      expect(params).toMatchObject({ maxCostUsd: 0.7 });
      expect(jsonAt(params, ['conservativeUsd'])).toBeCloseTo(CONSERVATIVE_USD, 9);
      expect(await warned.generateRequests()).toHaveLength(2 * TRIALS_PER_VARIANT);
      for (const runId of swapRunOf(envelope).runs) {
        expect((await readRun(warned.outputDir, runId)).manifest.status).toBe('complete');
      }
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 10: a candidate that writes far longer outputs than assumed', () => {
  it(
    '001 FR-011 stops with exit 5 after the first batch, keeps every send within the cap and reports the overrun',
    async () => {
      // estimate.outputTokens 100 makes the pre-start estimate 0.072 USD, but every candidate
      // trial costs 100 × 1 + 12,500 × 2 per 1M = 0.0251 USD. The first batch (10 cases × 2
      // repeats) spends about 0.5; the 40 trials left project about 1.5 > 1, while the cap check
      // during the first batch never sees more than about 0.75 spent and reserved.
      const price = { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 };
      const cases = greetCases({ ko: 10, ja: 10 });
      const long = await project({
        scenario: 'swap-long-output',
        rules: [ANSWERED],
        cases,
        config: {
          pricing: { [MODEL_A]: price, [MODEL_B]: price },
          estimate: { outputTokens: 100 },
          sampling: { repeats: 3 },
        },
      });
      const { cli, envelope } = await swapJson(long);
      expect(cli.code).toBe(5);
      expect(envelope.exit).toEqual({ code: 5, name: 'over-budget' });

      const { swapId, runs } = swapRunOf(envelope);
      const [baselineId, candidateId] = runs;
      const baseline = await readRun(long.outputDir, baselineId);
      const candidate = await readRun(long.outputDir, candidateId);
      for (const run of [baseline, candidate]) {
        expect(run.manifest).toMatchObject({ status: 'partial', stopReason: 'budget-projected' });
      }
      const record = await readSwapRecord(long.outputDir, swapId);
      expect(record).toMatchObject({ status: 'partial', stopReason: 'budget-projected' });
      expect(record.spentUsd ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
      expect(totalCostUsd(baseline) + totalCostUsd(candidate)).toBeLessThanOrEqual(1);

      // First batch: 10 cases alternating languages in file order, repeats 0 and 1.
      const firstBatchCases = [1, 2, 3, 4, 5].flatMap((n) => [
        `greet-ko-${String(n)}`,
        `greet-ja-${String(n)}`,
      ]);
      const finished = new Set(
        attemptLines(candidate.lines)
          .filter((line) => line.status === 'ok')
          .map((line) => trialKey(line.caseId, line.repeat)),
      );
      for (const caseId of firstBatchCases) {
        expect(finished).toContain(trialKey(caseId, 0));
        expect(finished).toContain(trialKey(caseId, 1));
      }
      expect(finished.size).toBeLessThan(cases.length * 3);
      expect(
        candidate.manifest.estimate.projected.some(
          (entry) => entry.trigger === 'first-batch' && (entry.totalUsd ?? 0) > 1,
        ),
      ).toBe(true);

      expect(candidate.manifest.totals.overrunUsd).toBeGreaterThan(0);
      const overrun = envelope.warnings.find((warning) => warning.code === 'budget-overrun');
      expect(overrun?.variants).toContain('next');
      const overrunParams =
        overrun !== undefined && 'params' in overrun ? overrun.params : undefined;
      expect(jsonAt(overrunParams, ['overrunUsd', 'next'])).toBeGreaterThan(0);

      // A stopped swap still compares what finished, and the result is withheld.
      const comparison = comparisonOf(envelope);
      expect(comparison.gate.outcome).toBe('undecided');
      expect(comparison.gate.reasons[0]?.code).toBe('partial-run');
    },
    E2E.timeout,
  );
});

describe('001 FR-012 unpriced models with a cap', () => {
  it(
    '001 FR-012 a variant model without a price ends with exit 4 before any model call',
    async () => {
      const unpriced = await costProject({ pricing: { [MODEL_A]: PRICE } });
      const { cli, envelope } = await swapJson(unpriced);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      expect(cli.stderr).toContain(MODEL_B);
      await expectNothingSent(unpriced);
    },
    E2E.timeout,
  );

  it(
    '001 FR-012 a call to an unpriced model during the run ends with exit 4 and stops both runs',
    async () => {
      // swap-unpriced-call.yaml reports a background call to model-side after each candidate
      // result; the config prices only model-a and model-b, and the default cap is 1 USD.
      const sideCall = await project({
        scenario: 'swap-unpriced-call',
        rules: [ANSWERED],
        cases: greetCases({ ko: 3, ja: 3 }),
      });
      const { cli, envelope } = await swapJson(sideCall);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      expect((await sideCall.generateRequests()).length).toBeGreaterThan(0);

      const { swapId, runs } = swapRunOf(envelope);
      expect(swapRunOf(envelope).comparison).toBeUndefined();
      const [baselineId, candidateId] = runs;
      for (const runId of [baselineId, candidateId]) {
        const run = await readRun(sideCall.outputDir, runId);
        expect(run.manifest).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      }
      const candidate = await readRun(sideCall.outputDir, candidateId);
      const sideLines = costLines(candidate.lines).filter((line) =>
        (line.calls ?? []).some((call) => call.model === 'model-side'),
      );
      expect(sideLines.length).toBeGreaterThan(0);
      // Charged at the most expensive configured price per bucket: 50 × 1 + 5 × 2 per 1M.
      for (const line of sideLines) {
        expect(line).toMatchObject({ source: 'calls', costEstimated: true });
        expect(line.costUsd).toBeCloseTo(perMillion(50, 1) + perMillion(5, 2), 12);
      }
      const record = await readSwapRecord(sideCall.outputDir, swapId);
      expect(record).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      expect(record.comparisonId).toBeUndefined();
    },
    E2E.timeout,
  );
});
