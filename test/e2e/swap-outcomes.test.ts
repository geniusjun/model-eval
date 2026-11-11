import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { E2E, swapJson, useProjects } from './support/commands.js';
import { loadScenario, outcomeRowOf } from './support/mock.js';
import {
  attemptLines,
  cellOf,
  comparisonOf,
  effectiveLines,
  entries,
  readRun,
  readSwapRecord,
  swapRunOf,
  trialKey,
} from './support/outputs.js';
import { greetCases, type CaseInput, type Project } from './support/project.js';
import { ANSWERED, NO_EMOJI } from './support/rules.js';

// User Story 1, acceptance scenarios 5, 8, 9, 11 and 14, and transient failures (FR-009).
// Outcomes drawn by probability are recomputed here from the per-trial seed and the mock's draw,
// so the expected counts follow the scenario file instead of being copied from a run.

const project = useProjects();

const CASES = greetCases({ ko: 3, ja: 3 });
const REPEATS = [0, 1];
const LANGS = ['ko', 'ja'];
/** `run.retries` default (contracts/config.md). */
const RETRIES = 2;

function outcomeProject(scenario: string, cases: readonly CaseInput[] = CASES): Promise<Project> {
  return project({ scenario, rules: [ANSWERED, NO_EMOJI], cases });
}

interface ExpectedTrial {
  readonly caseId: string;
  readonly lang: string;
  readonly repeat: number;
  /** The row of the last attempt the tool sends, after retries of transient rows. */
  readonly row: string;
  readonly attempts: number;
}

/** What each candidate trial ends as, with retries of transient rows up to `run.retries`. */
function candidateTrials(scenario: string): ExpectedTrial[] {
  const loaded = loadScenario(scenario);
  return CASES.flatMap((item) =>
    REPEATS.map((repeat) => {
      let attempts = 1;
      let row = outcomeRowOf(loaded, 'next', item.id, repeat, attempts);
      while (row === 'transient' && attempts < RETRIES + 1) {
        attempts += 1;
        row = outcomeRowOf(loaded, 'next', item.id, repeat, attempts);
      }
      return { caseId: item.id, lang: item.lang ?? '', repeat, row, attempts };
    }),
  );
}

const count = (trials: readonly ExpectedTrial[], row: string): number =>
  trials.filter((trial) => trial.row === row).length;

/** K and per-variant trials of a rule cell where only `judged` candidate trials count. */
function cellCounts(trials: readonly ExpectedTrial[], judged: (trial: ExpectedTrial) => boolean) {
  const byCase = new Map<string, number>();
  for (const trial of trials) {
    byCase.set(trial.caseId, (byCase.get(trial.caseId) ?? 0) + (judged(trial) ? 1 : 0));
  }
  const kept = [...byCase.values()].filter((judgedTrials) => judgedTrials > 0);
  return {
    cases: kept.length,
    droppedCases: byCase.size - kept.length,
    candidateTrials: kept.reduce((sum, judgedTrials) => sum + judgedTrials, 0),
    baselineTrials: kept.length * REPEATS.length,
  };
}

describe('001 US1 scenario 5: post-processing removes the violating characters', () => {
  it(
    '001 FR-018 the raw rate, the final rate and the masked rate are reported separately',
    async () => {
      const { cli, envelope } = await swapJson(await outcomeProject('swap-masked'));
      expect(cli.code).toBe(0);
      const comparison = comparisonOf(envelope);
      const raw = cellOf(comparison, 'no-emoji', 'ja', 'raw');
      const final = cellOf(comparison, 'no-emoji', 'ja', 'final');
      expect(raw.baseline.rate).toBe(1);
      expect(raw.candidate.rate).toBe(0);
      expect(final.baseline.rate).toBe(1);
      expect(final.candidate.rate).toBe(1);
      expect(raw.masked).toEqual({ baseline: 0, candidate: 1 });
      expect(final.masked).toBeUndefined();
      expect(cellOf(comparison, 'no-emoji', 'ko', 'raw').masked).toEqual({
        baseline: 0,
        candidate: 0,
      });
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 14: the service filters the first answer and regenerates it', () => {
  it(
    '001 FR-018 raw rules judge the first answer, final and completion rules the shipped one, with masked and regeneration rates',
    async () => {
      const regenerated = await outcomeProject('swap-regenerated');
      const { cli, envelope } = await swapJson(regenerated);
      expect(cli.code).toBe(0);
      const comparison = comparisonOf(envelope);
      expect(cellOf(comparison, 'no-emoji', 'ja', 'raw').candidate.rate).toBe(0);
      expect(cellOf(comparison, 'no-emoji', 'ja', 'final').candidate.rate).toBe(1);
      expect(cellOf(comparison, 'no-emoji', 'ja', 'raw').masked?.candidate).toBe(1);
      for (const lang of LANGS) {
        expect(cellOf(comparison, 'answered', lang, 'trial').candidate.rate).toBe(1);
      }
      expect(comparison.ops.candidate.rates.regeneration).toMatchObject({
        count: 12,
        total: 12,
        rate: 1,
      });
      expect(comparison.ops.baseline.rates.regeneration).toMatchObject({ count: 0, total: 12 });
      expect(envelope.warnings).toContainEqual(
        expect.objectContaining({
          code: 'regeneration-rate-increase',
          params: { rates: { current: 0, next: 1 }, threshold: 0.03 },
        }),
      );
      const [, candidateId] = swapRunOf(envelope).runs;
      const candidate = await readRun(regenerated.outputDir, candidateId);
      for (const line of attemptLines(candidate.lines)) {
        expect(line).toMatchObject({ status: 'ok', answers: 2 });
      }
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 8: the service discards some candidate answers and replaces others', () => {
  it(
    '001 FR-018 those trials fail completion, raw rules judge them, final rules leave them out, and discard and fallback rates are reported',
    async () => {
      const trials = candidateTrials('swap-discard-fallback');
      const discarded = count(trials, 'discarded');
      const fallbacks = count(trials, 'fallback');
      expect(discarded).toBeGreaterThan(0);
      expect(fallbacks).toBeGreaterThan(0);

      const { cli, envelope } = await swapJson(await outcomeProject('swap-discard-fallback'));
      expect(cli.code).toBe(0);
      const comparison = comparisonOf(envelope);
      for (const lang of LANGS) {
        const inLang = trials.filter((trial) => trial.lang === lang);
        expect(cellOf(comparison, 'answered', lang, 'trial').candidate).toMatchObject({
          trials: 6,
          passes: count(inLang, 'normal'),
        });
        expect(cellOf(comparison, 'no-emoji', lang, 'raw').candidate.trials).toBe(6);
        const final = cellCounts(inLang, (trial) => trial.row === 'normal');
        const finalCell = cellOf(comparison, 'no-emoji', lang, 'final');
        expect(finalCell.cases).toBe(final.cases);
        expect(finalCell.droppedCases).toBe(final.droppedCases);
        expect(finalCell.candidate.trials).toBe(final.candidateTrials);
        expect(finalCell.baseline.trials).toBe(final.baselineTrials);
      }
      const { rates, discardReasons } = comparison.ops.candidate;
      expect(rates.discard).toMatchObject({ count: discarded, total: 12 });
      expect(rates.fallback).toMatchObject({ count: fallbacks, total: 12 });
      expect(comparison.ops.baseline.rates.discard).toMatchObject({ count: 0, total: 12 });
      expect(discardReasons).toEqual([
        { discardReason: 'MockDiscard: answer thrown away', count: discarded },
      ]);
      expect(envelope.warnings).toContainEqual(
        expect.objectContaining({
          code: 'discard-rate-increase',
          params: { rates: { current: 0, next: discarded / 12 }, threshold: 0.01 },
        }),
      );
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 9: both variants fail authentication', () => {
  it(
    '001 FR-009 the swap ends as a configuration error with exit 4, not as a pass',
    async () => {
      const denied = await outcomeProject('swap-auth-failure');
      const { cli, envelope } = await swapJson(denied);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });

      const result = swapRunOf(envelope);
      expect(result.comparison).toBeUndefined();
      expect(result.gate).toBeUndefined();
      for (const runId of result.runs) {
        const run = await readRun(denied.outputDir, runId);
        expect(run.manifest).toMatchObject({ status: 'partial', stopReason: 'config-error' });
        for (const line of effectiveLines(run.lines).values()) {
          expect(line).toMatchObject({ status: 'error', error: { kind: 'config' } });
        }
      }
      const record = await readSwapRecord(denied.outputDir, result.swapId);
      expect(record).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      expect(record.comparisonId).toBeUndefined();
      expect(await entries(path.join(denied.outputDir, 'comparisons'))).toEqual([]);
    },
    E2E.timeout,
  );
});

describe('001 US1 scenario 11: the candidate misses the service time limit', () => {
  it(
    '001 FR-009 those trials are not retried and count as completion failures',
    async () => {
      const trials = candidateTrials('swap-timeout');
      const timeouts = count(trials, 'timeout');
      expect(timeouts).toBeGreaterThan(0);

      const slow = await outcomeProject('swap-timeout');
      const { cli, envelope } = await swapJson(slow);
      expect(cli.code).toBe(0);
      const sent = (await slow.generateRequests()).filter((request) => request.variant === 'next');
      expect(sent).toHaveLength(12);

      const [, candidateId] = swapRunOf(envelope).runs;
      const candidate = await readRun(slow.outputDir, candidateId);
      for (const trial of trials.filter((item) => item.row === 'timeout')) {
        const lines = attemptLines(candidate.lines).filter(
          (line) => line.caseId === trial.caseId && line.repeat === trial.repeat,
        );
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ status: 'error', error: { kind: 'timeout' } });
      }

      const comparison = comparisonOf(envelope);
      for (const lang of LANGS) {
        const inLang = trials.filter((trial) => trial.lang === lang);
        expect(cellOf(comparison, 'answered', lang, 'trial').candidate).toMatchObject({
          trials: 6,
          passes: 6 - count(inLang, 'timeout'),
        });
        const raw = cellCounts(inLang, (trial) => trial.row === 'normal');
        expect(cellOf(comparison, 'no-emoji', lang, 'raw').candidate.trials).toBe(
          raw.candidateTrials,
        );
      }
      expect(comparison.ops.candidate.rates.timeout).toMatchObject({ count: timeouts, total: 12 });
    },
    E2E.timeout,
  );
});

describe('001 FR-009 transient failures', () => {
  it(
    '001 FR-009 are retried, left out of denominators, raise transient-rate, and become systematic when they fill every repeat of a case',
    async () => {
      const trials = candidateTrials('swap-transient');
      const transient = trials.filter((trial) => trial.row === 'transient');
      // data-model §Systematic Failures: at least two finished trials of a case, all transient,
      // while the baseline judged that case.
      const systematicCases = CASES.map((item) => item.id).filter((caseId) =>
        trials
          .filter((trial) => trial.caseId === caseId)
          .every((trial) => trial.row === 'transient'),
      );
      const isSystematic = (trial: ExpectedTrial) => systematicCases.includes(trial.caseId);
      const lone = transient.filter((trial) => !isSystematic(trial));
      const recovered = trials.filter((trial) => trial.row === 'normal' && trial.attempts > 1);
      expect(systematicCases.length).toBeGreaterThan(0);
      expect(lone.length).toBeGreaterThan(0);
      expect(recovered.length).toBeGreaterThan(0);

      const flaky = await outcomeProject('swap-transient');
      const { cli, envelope } = await swapJson(flaky);
      expect(cli.code).toBe(0);

      const sent = (await flaky.generateRequests()).filter((request) => request.variant === 'next');
      expect(sent).toHaveLength(trials.reduce((sum, trial) => sum + trial.attempts, 0));
      const [, candidateId] = swapRunOf(envelope).runs;
      const candidate = await readRun(flaky.outputDir, candidateId);
      for (const trial of trials) {
        const lines = attemptLines(candidate.lines).filter(
          (line) => line.caseId === trial.caseId && line.repeat === trial.repeat,
        );
        expect(lines.map((line) => line.attempt)).toEqual(
          Array.from({ length: trial.attempts }, (_unused, index) => index + 1),
        );
      }

      const comparison = comparisonOf(envelope);
      for (const lang of LANGS) {
        const inLang = trials.filter((trial) => trial.lang === lang);
        const systematicTrials = inLang.filter(isSystematic);
        expect(cellOf(comparison, 'answered', lang, 'trial').candidate).toMatchObject({
          trials: count(inLang, 'normal') + systematicTrials.length,
          passes: count(inLang, 'normal'),
        });
        expect(cellOf(comparison, 'answered', lang, 'trial').systematic).toEqual({
          baseline: { trials: 0, cases: 0 },
          candidate: {
            trials: systematicTrials.length,
            cases: new Set(systematicTrials.map((trial) => trial.caseId)).size,
          },
        });
        const raw = cellCounts(inLang, (trial) => trial.row === 'normal');
        const rawCell = cellOf(comparison, 'no-emoji', lang, 'raw');
        expect(rawCell.candidate.trials).toBe(raw.candidateTrials);
        expect(rawCell.droppedCases).toBe(raw.droppedCases);
      }
      const { rates, systematic } = comparison.ops.candidate;
      expect(rates.transient).toMatchObject({ count: transient.length, total: 12 });
      expect(rates.rejection.total).toBe(12 - lone.length);
      expect(systematic).toEqual({
        trials: trials.filter(isSystematic).length,
        cases: systematicCases.length,
      });
      const warning = envelope.warnings.find((item) => item.code === 'transient-rate');
      expect(warning?.variants).toContain('next');
      expect(
        warning !== undefined && 'params' in warning ? warning.params : undefined,
      ).toMatchObject({ rates: { next: transient.length / 12 }, threshold: 0.05 });
    },
    E2E.timeout,
  );

  it(
    '001 FR-009 stop both runs with exit 3 once they pass run.maxTransientRate after 20 finished trials',
    async () => {
      const cases = greetCases({ ko: 10, ja: 10 });
      const failing = await outcomeProject('swap-transient-all', cases);
      const { cli, envelope } = await swapJson(failing);
      expect(cli.code).toBe(3);
      expect(envelope.exit).toEqual({ code: 3, name: 'run-failed' });

      const { swapId, runs } = swapRunOf(envelope);
      for (const runId of runs) {
        const run = await readRun(failing.outputDir, runId);
        expect(run.manifest).toMatchObject({ status: 'partial', stopReason: 'transient-errors' });
      }
      const candidate = await readRun(failing.outputDir, runs[1]);
      const attemptsPerKey = new Map<string, number>();
      for (const line of attemptLines(candidate.lines)) {
        const key = trialKey(line.caseId, line.repeat);
        attemptsPerKey.set(key, (attemptsPerKey.get(key) ?? 0) + 1);
      }
      const finished = [...attemptsPerKey.values()].filter((attempts) => attempts === RETRIES + 1);
      expect(finished.length).toBeGreaterThanOrEqual(20);
      expect(attemptsPerKey.size).toBeLessThan(cases.length * REPEATS.length);
      expect(await readSwapRecord(failing.outputDir, swapId)).toMatchObject({
        status: 'partial',
        stopReason: 'transient-errors',
      });
      expect(comparisonOf(envelope).gate.outcome).toBe('undecided');
    },
    E2E.timeout,
  );
});
