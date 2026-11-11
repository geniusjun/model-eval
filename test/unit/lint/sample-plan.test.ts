import { describe, expect, it } from 'vitest';

import { dryRunPlanSchema } from '../../../src/cli/results.js';
import { lintFindingSchema } from '../../../src/config/diagnostics.js';
import {
  caseSchema,
  gateConfigSchema,
  ruleSchema,
  statsConfigSchema,
  type Rule,
} from '../../../src/config/schema.js';
import {
  samplePlan,
  type PlannedCase,
  type SamplePlanInput,
} from '../../../src/lint/sample-plan.js';

function rule(fields: Record<string, unknown>): Rule {
  return ruleSchema.parse({
    title: 'title',
    severity: 'blocking',
    scope: 'global',
    check: { type: 'emoji' },
    ...fields,
  });
}

function cases(count: number, lang: string, fields: Record<string, unknown> = {}): PlannedCase[] {
  return Array.from({ length: count }, (_, index) => ({
    definition: caseSchema.parse({
      id: `${lang}-${String(index)}`,
      target: 'chat',
      lang,
      provenance: 'synthetic',
      input: {},
      ...fields,
    }),
    lang,
  }));
}

const GATE = gateConfigSchema.parse({ severities: ['blocking'] });
const STATS = statsConfigSchema.parse({});

function input(fields: Partial<SamplePlanInput> = {}): SamplePlanInput {
  return {
    rules: [rule({ id: 'completed', check: { type: 'completed' } }), rule({ id: 'no-emoji' })],
    cases: [...cases(30, 'ko'), ...cases(30, 'ja')],
    repeats: 5,
    gate: GATE,
    stats: STATS,
    ...fields,
  };
}

describe('sample plan of gated cells', () => {
  it('001 FR-006 plans cases × repeats trials and n_min per gated cell, in rule, language and surface order', () => {
    const plan = samplePlan(input());
    expect(plan.cells).toEqual([
      { ruleId: 'completed', lang: 'ja', surface: 'trial', plannedTrials: 150, nMin: 35 },
      { ruleId: 'completed', lang: 'ko', surface: 'trial', plannedTrials: 150, nMin: 35 },
      { ruleId: 'no-emoji', lang: 'ja', surface: 'raw', plannedTrials: 150, nMin: 35 },
      { ruleId: 'no-emoji', lang: 'ko', surface: 'raw', plannedTrials: 150, nMin: 35 },
    ]);
    expect(plan.warnings).toEqual([]);
    expect(dryRunPlanSchema.shape.cells.parse(plan.cells)).toEqual(plan.cells);
  });

  it('001 FR-006 gated cells follow gateOn, the rule margin and the case rule lists', () => {
    const plan = samplePlan(
      input({
        rules: [
          rule({ id: 'script-ko', gateOn: 'both', margin: 0.05, languages: ['ko'] }),
          rule({ id: 'mood', scope: 'listed', gateOn: 'final' }),
        ],
        cases: [...cases(30, 'ko'), ...cases(12, 'ja', { rules: ['mood'] })],
      }),
    );
    expect(plan.cells).toEqual([
      { ruleId: 'script-ko', lang: 'ko', surface: 'raw', plannedTrials: 150, nMin: 73 },
      { ruleId: 'script-ko', lang: 'ko', surface: 'final', plannedTrials: 150, nMin: 73 },
      { ruleId: 'mood', lang: 'ja', surface: 'final', plannedTrials: 60, nMin: 35 },
    ]);
  });

  it('001 FR-006 n_min uses z_L of stats.confidence without correction', () => {
    const plan = samplePlan(input({ stats: statsConfigSchema.parse({ confidence: 0.9 }) }));
    // ⌈1.6449² × 0.9 / 0.1⌉
    expect(plan.cells.map((cell) => cell.nMin)).toEqual([25, 25, 25, 25]);
  });

  it('001 FR-006 few-cases for a gated cell with fewer than 10 cases', () => {
    const plan = samplePlan(input({ cases: [...cases(30, 'ko'), ...cases(9, 'ja')], repeats: 5 }));
    expect(plan.warnings).toEqual([
      {
        code: 'few-cases',
        ruleId: 'completed',
        lang: 'ja',
        params: { surface: 'trial', cases: 9 },
      },
      { code: 'few-cases', ruleId: 'no-emoji', lang: 'ja', params: { surface: 'raw', cases: 9 } },
    ]);
    expect(samplePlan(input({ cases: cases(10, 'ko'), repeats: 5 })).warnings).toEqual([]);
  });

  it('001 FR-006 margin-unreachable when planned trials fall below n_min, the cell kept in the plan', () => {
    const plan = samplePlan(input({ cases: cases(10, 'ko'), repeats: 3 }));
    expect(plan.cells.map((cell) => cell.plannedTrials)).toEqual([30, 30]);
    expect(plan.warnings).toEqual([
      {
        code: 'margin-unreachable',
        ruleId: 'completed',
        lang: 'ko',
        params: { surface: 'trial', plannedTrials: 30, nMin: 35, margin: 0.1 },
      },
      {
        code: 'margin-unreachable',
        ruleId: 'no-emoji',
        lang: 'ko',
        params: { surface: 'raw', plannedTrials: 30, nMin: 35, margin: 0.1 },
      },
    ]);
    expect(samplePlan(input({ cases: cases(7, 'ko'), repeats: 4 })).warnings).toEqual([
      expect.objectContaining({ code: 'few-cases', ruleId: 'completed' }),
      expect.objectContaining({ code: 'margin-unreachable', ruleId: 'completed' }),
      expect.objectContaining({ code: 'few-cases', ruleId: 'no-emoji' }),
      expect.objectContaining({ code: 'margin-unreachable', ruleId: 'no-emoji' }),
    ]);
    for (const warning of plan.warnings) {
      expect(lintFindingSchema.parse(warning)).toEqual(warning);
    }
  });

  it('001 FR-006 no cell for review, retired, ungated or inapplicable rules, nor with an empty gate', () => {
    const rules = [
      rule({ id: 'self-state', check: { type: 'review' } }),
      rule({ id: 'old', status: 'retired' }),
      rule({ id: 'minor', severity: 'minor' }),
      rule({ id: 'other-target', targets: ['mail'] }),
      rule({ id: 'english', languages: ['en'] }),
    ];
    expect(samplePlan(input({ rules, cases: cases(3, 'ko') }))).toEqual({
      cells: [],
      warnings: [],
    });
    expect(samplePlan(input({ gate: gateConfigSchema.parse({}), cases: cases(3, 'ko') }))).toEqual({
      cells: [],
      warnings: [],
    });
  });
});
