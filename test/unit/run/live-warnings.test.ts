import { describe, expect, it } from 'vitest';

import { finishedTrials } from '../../../src/compare/finished.js';
import { trialWarnings } from '../../../src/compare/warnings.js';
import type { Sha256 } from '../../../src/config/identifiers.js';
import { reportConfigSchema } from '../../../src/config/schema.js';
import { budgetOverrunWarning, overrunUsd } from '../../../src/run/cap.js';
import { LiveWarningCodes } from '../../../src/run/live-warnings.js';
import { manifestSchema } from '../../../src/run/manifest.js';
import { trialLineSchema, type TrialLine } from '../../../src/run/records.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };
import { errorLine, okLine } from '../grade/lines.js';

const REPORT = reportConfigSchema.parse({ warn: { transientRate: 0.2 } });
const RENDERED: Sha256 = `sha256:${'a'.repeat(64)}`;
const OTHER: Sha256 = `sha256:${'b'.repeat(64)}`;
const RETRIES = 1;
const CASES = ['c1', 'c2', 'c3'];
const MANIFEST = {
  ...manifestSchema.parse(manifestFixture),
  prompts: { c1: RENDERED, c2: RENDERED },
  limits: { retries: RETRIES, timeoutMs: 1000 },
};

/** A deterministic draw in [0, 1), so each seed replays the same lines. */
function draws(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  const value = values[Math.floor(next() * values.length)];
  if (value === undefined) {
    throw new RangeError('pick from an empty list');
  }
  return value;
}

/** Lines of one run: sends, attempts of every outcome, keyed and unkeyed cost lines. */
function lines(seed: number, count: number): TrialLine[] {
  const next = draws(seed);
  return Array.from({ length: count }, (): TrialLine => {
    const key = {
      caseId: pick(next, [...CASES, 'gone']),
      repeat: pick(next, [0, 1]),
      attempt: pick(next, [1, 2]),
      segment: 1,
    };
    const costUsd = pick(next, [0, 0.001, 0.004, null]);
    switch (pick(next, ['send', 'ok', 'ok', 'transient', 'permanent', 'cost', 'unkeyed'])) {
      case 'send':
        return trialLineSchema.parse({
          ...key,
          reservedUsd: pick(next, [0.002, null]),
          sending: true,
        });
      case 'ok':
        return okLine({
          ...key,
          costUsd,
          raw: pick(next, ['a', 'b']),
          ...pick(next, [{}, { modelSnapshot: 's1' }, { modelSnapshot: 's2' }]),
          ...pick(next, [{}, { fingerprint: RENDERED }, { fingerprint: OTHER }]),
        });
      case 'transient':
      case 'permanent':
        return errorLine(pick(next, ['transient', 'permanent'] as const), { ...key, costUsd });
      case 'cost':
        return trialLineSchema.parse({
          ...key,
          source: 'calls',
          costUsd,
          calls: [],
          costCorrection: true,
        });
      default:
        return trialLineSchema.parse({
          segment: 1,
          source: 'calls',
          costUsd: pick(next, [0, 0.001]),
          calls: [],
          costCorrection: true,
        });
    }
  });
}

/** The codes of the warnings counted over every line, as the manifest writes them. */
function countedCodes(prefix: readonly TrialLine[]): string[] {
  const finished = finishedTrials(prefix, RETRIES, new Set(CASES));
  const overrun = budgetOverrunWarning('next', overrunUsd(prefix));
  return [
    ...trialWarnings({ manifest: MANIFEST, finished }, REPORT),
    ...(overrun === undefined ? [] : [overrun]),
  ]
    .map((warning) => warning.code)
    .sort();
}

describe('live warning codes', () => {
  it('001 FR-014 after every line, holds the codes the warnings counted over all lines have', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) {
      const live = new LiveWarningCodes({
        retries: RETRIES,
        caseIds: new Set(CASES),
        prompts: MANIFEST.prompts,
        transientRate: REPORT.warn.transientRate,
      });
      const all = lines(seed, 40);
      all.forEach((line, index) => {
        live.add(line);
        const expected = countedCodes(all.slice(0, index + 1));
        expect([...live.codes()].sort()).toEqual(expected);
        for (const code of expected) {
          seen.add(code);
        }
      });
    }
    // Every code holds at some point, so the comparison above covers each condition.
    expect([...seen].sort()).toEqual([
      'budget-overrun',
      'identical-repeats',
      'render-mismatch',
      'response-model-changed',
      'transient-rate',
    ]);
  });
});
