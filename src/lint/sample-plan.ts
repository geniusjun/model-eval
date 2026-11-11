import type { z } from 'zod';

import { compareCodeUnits } from '../adapter/canonical-json.js';
import type { dryRunPlanSchema } from '../cli/results.js';
import type { LintFinding } from '../config/diagnostics.js';
import type { Case, GateConfig, Rule, StatsConfig, Surface } from '../config/schema.js';
import { applicableToTargets, gateRules, gatesSurface } from '../compare/gate.js';
import { applicableRules } from '../grade/grade.js';
import { FEW_CASES, zValues } from '../stats/interval.js';
import { nMin } from '../stats/verdict.js';

// FR-006: the gated cells a run plans, before any trial is sent (data-model §Validation Rules).

const SURFACES: readonly Surface[] = ['raw', 'final', 'trial'];

export type PlannedCell = z.infer<typeof dryRunPlanSchema>['cells'][number];

/** A case the run will send, with its language key. */
export interface PlannedCase {
  readonly definition: Case;
  readonly lang: string;
}

export interface SamplePlanInput {
  /** The rules of the current rule files. */
  readonly rules: readonly Rule[];
  /** The cases the run will send, after any `--cases` filter. */
  readonly cases: readonly PlannedCase[];
  readonly repeats: number;
  readonly gate: GateConfig;
  readonly stats: StatsConfig;
}

export interface SamplePlan {
  /** Per gated cell, the `--dry-run` plan's `cells[]`. */
  readonly cells: readonly PlannedCell[];
  /** `few-cases` and `margin-unreachable`, cell by cell. */
  readonly warnings: readonly LintFinding[];
}

/** Cases per language each gated rule applies to, languages in code-unit order. */
function casesPerLanguage(rule: Rule, cases: readonly PlannedCase[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const { definition, lang } of cases) {
    if (applicableRules([rule], definition, lang).length > 0) {
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => compareCodeUnits(a, b));
}

/**
 * Gated cells as the gate will see them, without the low-baseline exclusion, which needs a
 * baseline run. Planned trials per variant are cases × repeats; n_min uses z_L without
 * correction, since G is not known before the run.
 */
export function samplePlan(input: SamplePlanInput): SamplePlan {
  const targets = [...new Set(input.cases.map(({ definition }) => definition.target))];
  const { gated } = gateRules(applicableToTargets(input.rules, targets), input.gate);
  const { zLower } = zValues(input.stats.confidence, 0);
  const cells: PlannedCell[] = [];
  const warnings: LintFinding[] = [];
  for (const rule of gated) {
    const margin = rule.margin ?? input.gate.margin;
    const needed = nMin(margin, zLower);
    for (const [lang, cases] of casesPerLanguage(rule, input.cases)) {
      for (const surface of SURFACES.filter((each) => gatesSurface(rule, each))) {
        const plannedTrials = cases * input.repeats;
        cells.push({ ruleId: rule.id, lang, surface, plannedTrials, nMin: needed });
        if (cases < FEW_CASES) {
          warnings.push({ code: 'few-cases', ruleId: rule.id, lang, params: { surface, cases } });
        }
        if (plannedTrials < needed) {
          warnings.push({
            code: 'margin-unreachable',
            ruleId: rule.id,
            lang,
            params: { surface, plannedTrials, nMin: needed, margin },
          });
        }
      }
    }
  }
  return { cells, warnings };
}
