import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { comparisonSchema, type Comparison } from '../../src/report/schema.js';
import { ROOT, runCli } from './support/cli.js';
import { E2E, SWAP } from './support/commands.js';
import { entries, readComparison } from './support/outputs.js';

// The samples the result page reads (002 FR-015): each trial text stored once and referenced by
// key, and no more failing examples per cell than configured. Checked on the committed fixtures
// and on the comparison a swap of the example writes.

const FIXTURES = path.join(ROOT, 'test/fixtures/contracts');
const FIXTURE_NAMES = ['block', 'undecided-partial', 'no-gate'] as const;
const EXAMPLE = path.join(ROOT, 'examples/pogo');
const OUTPUT_DIR = '.model-eval';

type Samples = Comparison['samples'];

interface Key {
  readonly variant: string;
  readonly caseId: string;
  readonly repeat: number;
}

function keyId({ variant, caseId, repeat }: Key): string {
  return JSON.stringify([variant, caseId, repeat]);
}

/** Every key of `samples.review` and `samples.failing`. */
function referencedKeys(samples: Samples): Key[] {
  return [
    ...samples.review.flatMap((entry) => entry.keys),
    ...samples.failing.flatMap((entry) => entry.keys),
  ];
}

async function fixtureComparison(name: string): Promise<Comparison> {
  const text = await readFile(path.join(FIXTURES, `comparison-${name}.json`), 'utf8');
  return comparisonSchema.parse(JSON.parse(text));
}

let folder: string;
let example: Comparison;

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'model-eval-samples-'));
  await cp(EXAMPLE, folder, {
    recursive: true,
    filter: (source) => path.basename(source) !== OUTPUT_DIR,
  });
  const cli = await runCli([...SWAP], folder);
  expect(cli.code, cli.stderr).toBe(1);
  const outputDir = path.join(folder, OUTPUT_DIR);
  const [comparisonId] = await entries(path.join(outputDir, 'comparisons'));
  if (comparisonId === undefined) {
    throw new Error('the swap wrote no comparison');
  }
  example = (await readComparison(outputDir, comparisonId)).comparison;
}, E2E.timeout);

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function comparisons(): Promise<[string, Comparison][]> {
  const fixtures = await Promise.all(
    FIXTURE_NAMES.map(async (name): Promise<[string, Comparison]> => [
      name,
      await fixtureComparison(name),
    ]),
  );
  return [...fixtures, ['examples/pogo', example]];
}

describe('002 samples of the result page', () => {
  it('002 FR-015 stores each (variant, caseId, repeat) text once', async () => {
    for (const [name, { samples }] of await comparisons()) {
      const ids = samples.texts.map(keyId);
      expect(ids.length, name).toBeGreaterThan(0);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
  });

  it('002 FR-015 resolves every review and failing key to a stored text', async () => {
    for (const [name, { samples }] of await comparisons()) {
      const stored = new Set(samples.texts.map(keyId));
      const missing = referencedKeys(samples).filter((key) => !stored.has(keyId(key)));
      expect(missing, name).toEqual([]);
    }
  });

  it('002 FR-015 keeps no more candidate failing keys per cell than report.samples', async () => {
    for (const [name, { samples, config }] of await comparisons()) {
      for (const entry of samples.failing) {
        const candidateKeys = entry.keys.filter((key) => key.variant === 'candidate');
        expect(candidateKeys.length, `${name} ${entry.ruleId}`).toBeLessThanOrEqual(
          config.report.samples,
        );
      }
    }
  });

  it('002 FR-015 stores the baseline text of the same case and repeat for every failing example', async () => {
    for (const [name, { samples }] of await comparisons()) {
      const stored = new Set(samples.texts.map(keyId));
      const failing = samples.failing.flatMap((entry) => entry.keys);
      expect(failing.length, name).toBeGreaterThan(0);
      const missing = failing.filter(
        ({ caseId, repeat }) => !stored.has(keyId({ variant: 'baseline', caseId, repeat })),
      );
      expect(missing, name).toEqual([]);
    }
  });

  it('002 FR-015 the example comparison fills a cell up to report.samples, so the cap applies', () => {
    const counts = example.samples.failing.map(
      (entry) => entry.keys.filter((key) => key.variant === 'candidate').length,
    );
    expect(Math.max(...counts)).toBe(example.config.report.samples);
  });

  it('002 FR-015 the example comparison has review samples and failing examples to show', () => {
    expect(example.samples.review.some((entry) => entry.keys.length > 0)).toBe(true);
    expect(example.samples.failing.some((entry) => entry.keys.length > 0)).toBe(true);
  });
});
