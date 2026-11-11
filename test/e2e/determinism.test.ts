import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { manifestSchema } from '../../src/run/manifest.js';
import type { CliResult } from './support/cli.js';
import {
  compareJson,
  E2E,
  runJson,
  swapJson,
  useProjects,
  type JsonOutcome,
} from './support/commands.js';
import {
  comparisonOf,
  readRun,
  resultOf,
  startedRunOf,
  swapRunOf,
  type CompareEnvelope,
  type SwapEnvelope,
} from './support/outputs.js';
import { greetCases, type Project } from './support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA } from './support/rules.js';

// SC-002: comparing the same records twice gives the same result apart from the volatile fields
// of data-model §Identifiers and Hashing.

const project = useProjects();

const GATED = { gate: { severities: ['blocking' as const] } };

/** `createdAt` is the only volatile field a comparison holds besides `priorComparisons`. */
function withoutCreatedAt(text: string): string {
  return text.replaceAll(/"createdAt": ?"[^"]*"/gu, '"createdAt":""');
}

const comparisonIdOf = (outcome: JsonOutcome<CompareEnvelope>): string =>
  resultOf(outcome.envelope).comparison.comparisonId;

describe('001 SC-002 comparing the same records twice', () => {
  let saved: Project;
  let swap: JsonOutcome<SwapEnvelope>;
  let first: JsonOutcome<CompareEnvelope>;
  let firstFile: string;
  let second: JsonOutcome<CompareEnvelope>;
  let secondFile: string;

  beforeAll(async () => {
    saved = await project({
      scenario: 'swap-script-ja',
      rules: [ANSWERED, SCRIPT_JA, NO_EMOJI],
      cases: greetCases({ ko: 3, ja: 3 }),
      config: GATED,
    });
    swap = await swapJson(saved);
    const runIds = swapRunOf(swap.envelope).runs;
    const file = path.join(
      saved.outputDir,
      'comparisons',
      comparisonOf(swap.envelope).comparisonId,
      'comparison.json',
    );
    first = await compareJson(saved, runIds);
    firstFile = await readFile(file, 'utf8');
    second = await compareJson(saved, runIds);
    secondFile = await readFile(file, 'utf8');
  }, E2E.timeout);

  it('001 SC-002 compare --json is byte-identical apart from createdAt', () => {
    expect(first.cli.code).toBe(1);
    expect(second.cli.code).toBe(1);
    expect(withoutCreatedAt(second.cli.stdout)).toBe(withoutCreatedAt(first.cli.stdout));
    expect(withoutCreatedAt(secondFile)).toBe(withoutCreatedAt(firstFile));
  });

  it("001 SC-002 compare of a swap's runs reproduces the swap's comparison", () => {
    const fromSwap = comparisonOf(swap.envelope);
    const result = first.envelope.result;
    expect(result?.comparison).toEqual({ ...fromSwap, createdAt: result?.comparison.createdAt });
  });
});

describe('001 SC-002 a run that became complete on resume', () => {
  let saved: Project;
  let killed: JsonOutcome<CompareEnvelope>;
  let resumed: CliResult;
  let finished: JsonOutcome<CompareEnvelope>;
  let killedFolder: string;
  let requestsBeforeResume: number;
  let requestsAfterResume: number;

  beforeAll(async () => {
    saved = await project({
      scenario: 'swap-clean',
      rules: [ANSWERED],
      cases: greetCases({ ko: 3, ja: 3 }),
    });
    const runIdOf = async (variant: string): Promise<string> =>
      startedRunOf((await runJson(saved, variant)).envelope).runId;
    const baseline = await runIdOf('current');
    const candidate = await runIdOf('next');
    // A kill right after the last trial line leaves the manifest `running` with every line in.
    const run = await readRun(saved.outputDir, candidate);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(run.dir, 'manifest.json'), 'utf8')),
    );
    await writeFile(
      path.join(run.dir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        status: 'running',
        stopReason: undefined,
        segments: manifest.segments.map((segment) => ({ ...segment, endedAt: undefined })),
      }),
    );
    killed = await compareJson(saved, [baseline, candidate]);
    killedFolder = path.join(saved.outputDir, 'comparisons', comparisonIdOf(killed));
    requestsBeforeResume = (await saved.generateRequests()).length;
    resumed = await saved.run(['run', '--resume', candidate]);
    requestsAfterResume = (await saved.generateRequests()).length;
    finished = await compareJson(saved, [baseline, candidate]);
  }, E2E.timeout);

  it('001 SC-002 gets a new comparisonId and leaves the undecided comparison in place', () => {
    expect(killed.cli.code).toBe(2);
    expect(killed.envelope.result?.gate.reasons[0]?.code).toBe('partial-run');
    expect(resumed.code).toBe(0);
    expect(requestsAfterResume).toBe(requestsBeforeResume);
    expect(finished.cli.code).toBe(0);
    expect(comparisonIdOf(finished)).not.toBe(comparisonIdOf(killed));
    expect(existsSync(path.join(killedFolder, 'comparison.json'))).toBe(true);
  });
});
