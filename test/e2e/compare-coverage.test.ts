import { readFile, writeFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { scenarioSchema, type Scenario } from '../../src/adapter/mock-scenario.js';
import type { Comparison } from '../../src/report/schema.js';
import type { Warning } from '../../src/run/warning.js';
import {
  compareJson,
  E2E,
  gradeJson,
  runJson,
  useProjects,
  type JsonOutcome,
} from './support/commands.js';
import {
  cellOf,
  readGradeSet,
  readRun,
  resultOf,
  startedRunOf,
  type CompareEnvelope,
} from './support/outputs.js';
import { greetCases, type CaseInput, type Project, type ProjectChange } from './support/project.js';
import { ANSWERED, NO_EMOJI } from './support/rules.js';

// FR-027: comparisons use the cases both runs share with unchanged content, report the others,
// check their preconditions on those cases only, and warn when the code behind the runs differs.

const project = useProjects();

async function runOf(saved: Project, variant: string): Promise<string> {
  return startedRunOf((await runJson(saved, variant)).envelope).runId;
}

const comparisonOf = (outcome: JsonOutcome<CompareEnvelope>): Comparison =>
  resultOf(outcome.envelope).comparison;

function greet(lang: string, n: number, user = `hello ${String(n)}`): CaseInput {
  return {
    id: `greet-${lang}-${String(n)}`,
    target: 'chat',
    lang,
    provenance: 'synthetic',
    input: { user },
  };
}

describe('001 FR-027 cases in one run only and cases whose content changed', () => {
  let saved: Project;
  let runIds: readonly [string, string];
  let compared: JsonOutcome<CompareEnvelope>;

  beforeAll(async () => {
    saved = await project({
      scenario: 'compare-coverage',
      rules: [ANSWERED, NO_EMOJI],
      cases: [1, 2, 3, 4].map((n) => greet('ko', n)).concat([1, 2, 3].map((n) => greet('ja', n))),
    });
    const baseline = await runOf(saved, 'current');
    // greet-ko-4 leaves the files, greet-ko-5 joins them, and two Japanese cases change input.
    await saved.write({
      cases: [
        greet('ko', 1),
        greet('ko', 2),
        greet('ko', 3),
        greet('ko', 5),
        greet('ja', 1),
        greet('ja', 2, 'changed'),
        greet('ja', 3, 'changed'),
      ],
    });
    const candidate = await runOf(saved, 'next');
    runIds = [baseline, candidate];
    compared = await compareJson(saved, runIds);
  }, E2E.timeout);

  it('001 FR-027 they leave the comparison and appear in coverage', () => {
    const comparison = comparisonOf(compared);
    expect(comparison.coverage).toEqual({
      commonCases: 4,
      baselineOnly: ['greet-ko-4'],
      candidateOnly: ['greet-ko-5'],
      changedHash: ['greet-ja-2', 'greet-ja-3'],
    });
    expect(cellOf(comparison, 'answered', 'ko', 'trial')).toMatchObject({
      cases: 3,
      baseline: { trials: 6 },
      candidate: { trials: 6 },
    });
    expect(cellOf(comparison, 'answered', 'ja', 'trial')).toMatchObject({
      cases: 1,
      baseline: { trials: 2 },
      candidate: { trials: 2 },
    });
    // The baseline's time-outs fell on changed cases only, so no metric counts them.
    expect(comparison.ops.baseline.rates.timeout.count).toBe(0);
  });

  it('001 FR-027 the baseline grade set skips every rule on changed and deleted cases', async () => {
    const comparison = comparisonOf(compared);
    const run = await readRun(saved.outputDir, runIds[0]);
    const { grades } = await readGradeSet(run.dir, comparison.baseline.gradeSetId);
    for (const caseId of ['greet-ja-2', 'greet-ja-3', 'greet-ko-4']) {
      const ofCase = grades.filter((grade) => grade.caseId === caseId);
      expect(ofCase.length).toBeGreaterThan(0);
      expect(new Set(ofCase.map((grade) => grade.outcome))).toEqual(new Set(['skip']));
    }
  });

  it('001 FR-025 preconditions use common cases only: the baseline completes its one common Japanese case', () => {
    const comparison = comparisonOf(compared);
    // Over all its Japanese cases the baseline completed 1 of 3, below the 0.5 of gate row 3.
    expect(comparison.completion).toContainEqual({ lang: 'ja', trials: 2, passes: 2, rate: 1 });
    expect(comparison.gate.reasons.map((reason) => reason.code)).toEqual(['no-gate']);
    expect(comparison.gate.outcome).toBe('no-gate');
    expect(compared.cli.code).toBe(0);
  });
});

describe('001 FR-027 versions-differ', () => {
  let saved: Project;
  let original: Scenario;

  /** Declares a changed adapter or service for the runs that start after it. */
  async function declare(change: (scenario: Scenario) => Scenario): Promise<void> {
    await writeFile(saved.scenario, stringify(change(original)));
  }

  /** Compares a new run of `variant`, started after the change, with the baseline. */
  async function compareNewRun(
    change: (scenario: Scenario) => Scenario,
    files: ProjectChange = {},
    variant = 'next',
  ): Promise<JsonOutcome<CompareEnvelope>> {
    await declare(change);
    await saved.write({ adapterEnv: {}, ...files });
    const candidate = await runOf(saved, variant);
    return compareJson(saved, [baseline, candidate]);
  }

  const versionsDiffer = (outcome: JsonOutcome<CompareEnvelope>) =>
    comparisonOf(outcome).warnings.find(
      (item): item is Extract<Warning, { code: 'versions-differ' }> =>
        item.code === 'versions-differ',
    );

  /** The `versions-differ` fields of comparing a new candidate run with the baseline. */
  async function differingFields(
    change: (scenario: Scenario) => Scenario,
    files: ProjectChange = {},
  ): Promise<readonly string[] | undefined> {
    return versionsDiffer(await compareNewRun(change, files))?.params.fields;
  }

  let baseline: string;

  beforeAll(async () => {
    saved = await project({
      scenario: 'compare-versions',
      ownScenario: true,
      rules: [ANSWERED],
      cases: greetCases({ ko: 3 }),
    });
    original = scenarioSchema.parse(parse(await readFile(saved.scenario, 'utf8')));
    baseline = await runOf(saved, 'current');
  }, E2E.timeout);

  it(
    '001 FR-027 not for runs of the same code, adapter and launch settings',
    async () => {
      expect(await differingFields((scenario) => scenario)).toBeUndefined();
    },
    E2E.timeout,
  );

  it(
    '001 FR-027 for different service code, adapter version, launchHash or helper version',
    async () => {
      const { adapter, service } = original;
      expect(
        await differingFields((scenario) => ({
          ...scenario,
          service: { ...service, treeHash: `sha256:${'b'.repeat(64)}` },
        })),
      ).toEqual(['service']);
      expect(
        await differingFields((scenario) => ({
          ...scenario,
          adapter: { ...adapter, version: '0.2.0' },
        })),
      ).toEqual(['adapter-version']);
      expect(
        await differingFields((scenario) => ({
          ...scenario,
          adapter: { ...adapter, helper: { language: 'python', version: '0.2.0' } },
        })),
      ).toEqual(['helper-version']);
      expect(
        await differingFields((scenario) => scenario, {
          adapterEnv: { MOCK_LAUNCH: 'other' },
        }),
      ).toEqual(['launch-hash']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-027 two runs of the same variant made at different times',
    async () => {
      const same = await compareNewRun((scenario) => scenario, {}, 'current');
      expect(same.cli.code).toBe(0);
      const sameComparison = comparisonOf(same);
      expect(sameComparison.baseline.variant).toEqual(sameComparison.candidate.variant);
      expect(sameComparison.warnings).toEqual([]);
      expect(sameComparison.priorComparisons).toBe(0);

      const relaunched = await compareNewRun(
        (scenario) => scenario,
        { adapterEnv: { MOCK_LAUNCH: 'other' } },
        'current',
      );
      expect(versionsDiffer(relaunched)).toEqual({
        code: 'versions-differ',
        params: { fields: ['launch-hash'] },
        variants: ['current'],
      });
      // Rerunning only the candidate is a new sample of the same pair of variants.
      expect(comparisonOf(relaunched).priorComparisons).toBe(1);
    },
    E2E.timeout,
  );
});

/** A case without `lang`: it takes the target's only language. */
const PLAIN: CaseInput = {
  id: 'plain',
  target: 'chat',
  provenance: 'synthetic',
  input: { user: 'hi' },
};

describe('001 FR-019 a case without lang whose runs recorded different language keys', () => {
  let saved: Project;
  let runIds: readonly [string, string];
  let graded: readonly [string, string];
  let compared: JsonOutcome<CompareEnvelope>;

  beforeAll(async () => {
    saved = await project({
      scenario: 'compare-versions',
      ownScenario: true,
      rules: [ANSWERED],
      cases: [PLAIN],
    });
    const original = scenarioSchema.parse(parse(await readFile(saved.scenario, 'utf8')));
    const baseline = await runOf(saved, 'current');
    // The target's only language moves from ko to ja, so `plain` is sent as ja from now on.
    await writeFile(
      saved.scenario,
      stringify({
        ...original,
        targets: original.targets.map((target) => ({ ...target, languages: ['ja'] })),
        prompts: { '*': 'Answer briefly.' },
        variants: Object.fromEntries(
          Object.entries(original.variants).map(([id, behaviour]) => [
            id,
            { ...behaviour, answer: { '*': 'ok {caseId}' } },
          ]),
        ),
      }),
    );
    const candidate = await runOf(saved, 'next');
    runIds = [baseline, candidate];
    graded = [
      resultOf((await gradeJson(saved, baseline)).envelope).gradeSetId,
      resultOf((await gradeJson(saved, candidate)).envelope).gradeSetId,
    ];
    compared = await compareJson(saved, runIds);
  }, E2E.timeout);

  it('001 FR-019 grade and compare give each run the grade set of the key it recorded', async () => {
    const comparison = comparisonOf(compared);
    expect([comparison.baseline.gradeSetId, comparison.candidate.gradeSetId]).toEqual(graded);
    const run = await readRun(saved.outputDir, runIds[1]);
    expect(run.manifest.cases).toContainEqual(expect.objectContaining({ id: 'plain', lang: 'ja' }));
    const { grades } = await readGradeSet(run.dir, graded[1]);
    expect(
      grades.filter((grade) => grade.caseId === 'plain').map((grade) => grade.outcome),
    ).toEqual(['pass', 'pass']);
  });

  it('001 FR-027 the comparison leaves the case out as changed', () => {
    expect(comparisonOf(compared).coverage).toEqual({
      commonCases: 0,
      baselineOnly: [],
      candidateOnly: [],
      changedHash: ['plain'],
    });
  });
});
