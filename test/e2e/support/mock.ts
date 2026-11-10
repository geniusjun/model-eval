import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  scenarioSchema,
  type OutcomeRow,
  type Scenario,
} from '../../../src/adapter/mock-scenario.js';
import { ROOT } from './cli.js';

/** `sampling.seed` of the config contract, which the e2e projects keep. */
export const GLOBAL_SEED = 1729;

export function scenarioFile(name: string): string {
  return path.join(ROOT, 'test/fixtures/mock', `${name}.yaml`);
}

export function loadScenario(name: string): Scenario {
  return scenarioSchema.parse(parseYaml(readFileSync(scenarioFile(name), 'utf8')));
}

function firstWord(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** data-model §Identifiers and Hashing: the first 4 bytes of SHA-256("<seed>:<caseId>:<repeat>"). */
export function trialSeed(caseId: string, repeat: number, seed = GLOBAL_SEED): number {
  return firstWord(`${String(seed)}:${caseId}:${String(repeat)}`);
}

/**
 * The mock adapter's documented draw (test/fixtures/mock scenarios): SHA-256 of
 * "<trial seed>:<key>", first 4 bytes over 2^32, so a test can tell which trials a scenario
 * probability hits.
 */
export function mockDraw(trialSeedValue: number, key: string): number {
  return firstWord(`${String(trialSeedValue)}:${key}`) / 2 ** 32;
}

/**
 * The outcome row a variant's scenario gives one send of a trial: the first row whose cumulative
 * share holds, skipping rows limited to fewer `firstSends`.
 */
export function outcomeRowOf(
  scenario: Scenario,
  variant: string,
  caseId: string,
  repeat: number,
  sends = 1,
): OutcomeRow {
  const behaviour = scenario.variants[variant] ?? scenario.variants['*'];
  if (behaviour === undefined) {
    throw new Error(`scenario has no behaviour for ${variant}`);
  }
  const u = mockDraw(trialSeed(caseId, repeat), 'outcome');
  let cumulative = 0;
  for (const outcome of behaviour.outcomes) {
    if (outcome.firstSends !== undefined && sends > outcome.firstSends) {
      continue;
    }
    cumulative += outcome.probability;
    if (u < cumulative) {
      return outcome.row;
    }
  }
  return 'normal';
}
