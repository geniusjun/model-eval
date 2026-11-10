import { z } from 'zod';

import {
  errorKindSchema,
  finalKindSchema,
  finishReasonSchema,
  helperSchema,
  serviceSchema,
} from '../adapter/protocol.js';
import {
  comparisonIdSchema,
  gradeSetIdSchema,
  idSchema,
  sha256Schema,
} from '../config/identifiers.js';
import {
  anchorSchema,
  gateConfigSchema,
  langSchema,
  originSchema,
  reportConfigSchema,
  severitySchema,
  statsConfigSchema,
  surfaceSchema,
} from '../config/schema.js';
import { runIdSchema, runStatusSchema, variantRecordSchema } from '../run/manifest.js';
import { excludedCauseSchema, perVariant } from '../config/finding.js';
import { abandonedCountsSchema, partialRunParamsSchema, warningSchema } from '../run/warning.js';

// The Comparison and Gate of data-model §Cell, §Comparison and §Gate, and the page payloads
// of 002 page-data. The feature 002 viewer bundles this module, so it must stay free of
// Node built-ins.

export const SCHEMA_VERSION = '1';

const count = z.int().min(0);
const share = z.number().min(0).max(1);
const usd = z.number().min(0);
const timestamp = z.iso.datetime({ offset: true });

export const verdictSchema = z.enum([
  'improved',
  'non-inferior',
  'regressed',
  'inconclusive',
  'insufficient',
  'not-applicable',
]);

export const cellNoteSchema = z.enum([
  'drop-within-margin',
  'drop-margin-undecided',
  'drop-too-few-samples',
  'clear-drop-too-few-cases',
]);

const tokenMean = z.number().min(0);

/** Mean tokens per trial: averages of whole token counts, so not whole themselves. */
const tokenMeansSchema = z
  .object({
    input: tokenMean.optional(),
    cachedInput: tokenMean.optional(),
    cacheWrite: tokenMean.optional(),
    output: tokenMean.optional(),
    reasoning: tokenMean.optional(),
  })
  .meta({ id: 'TokenMeans' });

export const cellKeyFields = {
  ruleId: idSchema,
  lang: z.string().min(1),
  surface: surfaceSchema,
};

/** Counted over the cell's common cases; statistics are `null` when there is none. */
export const rateSchema = z
  .object({
    cases: count,
    trials: count,
    passes: count,
    rate: share.nullable(),
    pooledRate: share.nullable(),
    low: share.nullable(),
    high: share.nullable(),
    nEff: z.number().min(0).nullable(),
  })
  .meta({ id: 'Rate' });

/** What a new run needs (data-model §Statistics, Trials needed); the message files hold the text. */
export const neededSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('repeats'),
      repeats: z.int().min(1),
      cellTrials: count,
      trialsPerVariant: count,
      nearMargin: z.boolean(),
    }),
    z.object({ kind: z.literal('cases'), cases: z.int().min(1) }),
    z.object({ kind: z.literal('on-margin') }),
  ])
  .meta({ id: 'Needed' });

/** Baseline and candidate values. */
const perRole = <T extends z.ZodType>(value: T) => z.object({ baseline: value, candidate: value });

export const cellSchema = z
  .object({
    ...cellKeyFields,
    gated: z.boolean(),
    cases: count,
    droppedCases: count,
    systematic: perRole(z.object({ trials: count, cases: count })).optional(),
    excluded: perRole(z.object({ transient: count, adapter: count })).optional(),
    baseline: rateSchema,
    candidate: rateSchema,
    diff: z.object({ estimate: z.number(), low: z.number(), high: z.number() }).nullable(),
    deff: z.number().min(1).nullable(),
    failRatio: z.number().min(0).nullable(),
    masked: perRole(share.nullable()).optional(),
    margin: z.number().gt(0).lt(1),
    verdict: verdictSchema,
    needed: neededSchema.optional(),
    note: cellNoteSchema.optional(),
  })
  .meta({ id: 'Cell' });

const pooledSchema = z.object({ trials: count, passes: count, rate: share.nullable() });

export const aggregateSchema = z.object({
  ruleId: idSchema,
  surface: surfaceSchema,
  baseline: pooledSchema,
  candidate: pooledSchema,
  diff: z.number().nullable(),
});

export const ruleSummarySchema = z.object({
  id: idSchema,
  title: z.string(),
  severity: severitySchema,
  languages: z.array(z.string().min(1)),
  gateOn: z.enum(['raw', 'final', 'both']),
  margin: z.number().gt(0).lt(1),
  anchors: z.array(anchorSchema),
  origin: z.array(originSchema),
});

export const comparedRunSchema = z
  .object({
    runId: runIdSchema,
    gradeSetId: gradeSetIdSchema,
    variant: variantRecordSchema,
    status: runStatusSchema,
    tool: z.object({ name: z.string().min(1), version: z.string().min(1) }),
    adapter: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      launchHash: sha256Schema,
      helper: helperSchema.optional(),
    }),
    service: serviceSchema,
    postprocess: z.boolean(),
  })
  .meta({ id: 'ComparedRun' });

// Operational metrics (data-model §Comparison, `ops`)

export const metricRateSchema = z.object({
  count,
  total: count,
  rate: share.nullable(),
  low: share.nullable(),
  high: share.nullable(),
});

export const opsRateNames = [
  'rejection',
  'timeout',
  'transient',
  'adapter',
  'discard',
  'fallback',
  'empty',
  'regeneration',
] as const;

export const variantOpsSchema = z
  .object({
    rates: z.object({
      rejection: metricRateSchema,
      timeout: metricRateSchema,
      transient: metricRateSchema,
      adapter: metricRateSchema,
      discard: metricRateSchema,
      fallback: metricRateSchema,
      empty: metricRateSchema,
      regeneration: metricRateSchema,
    }),
    systematic: z.object({ trials: count, cases: count }),
    discardReasons: z.array(z.object({ discardReason: z.string(), count })),
    topMessages: z.array(z.object({ kind: errorKindSchema, message: z.string(), count })),
    sideCallFailures: z.array(z.object({ kind: errorKindSchema, count })),
    abandoned: z.object({ timeout: count, restart: count }),
    finishReasons: z.object({ stop: count, length: count, content_filter: count, other: count }),
    latencyMs: z.object({
      p50: z.number().min(0).nullable(),
      p95: z.number().min(0).nullable(),
      values: z.array(z.number().min(0)),
    }),
    tokensPerTrial: tokenMeansSchema,
    costPerTrialUsd: usd.nullable(),
    responseModels: z.array(z.object({ model: z.string().min(1), trials: count })),
  })
  .meta({ id: 'VariantOps' });

export const opsChangeSchema = z.object({
  metric: z.enum([...opsRateNames, 'latencyP95', 'costPerTrial']),
  baseline: z.number().nullable(),
  candidate: z.number().nullable(),
  ratio: z.number().nullable().optional(),
  warning: z
    .enum([
      'discard-rate-increase',
      'regeneration-rate-increase',
      'latency-p95-ratio',
      'cost-ratio',
    ])
    .optional(),
});

export const scopeSchema = z.object({
  targets: z.array(z.string().min(1)),
  judgedRules: z.array(idSchema),
  notJudgedRules: z.array(idSchema),
  reviewRules: z.array(idSchema),
});

export const summaryCellSchema = z.object({
  ...cellKeyFields,
  verdict: verdictSchema,
  note: cellNoteSchema.optional(),
  needed: neededSchema.optional(),
});

export const summarySchema = z.object({
  worse: z.array(summaryCellSchema),
  improved: z.array(summaryCellSchema),
  unknown: z.array(summaryCellSchema),
  ops: z.array(opsChangeSchema),
  scope: scopeSchema,
});

// Samples: each (variant, caseId, repeat) text is stored once and referenced by key.

const variantRoleSchema = z.enum(['baseline', 'candidate']);

export const sampleKeyFields = {
  variant: variantRoleSchema,
  caseId: idSchema,
  repeat: count,
};

export const sampleTextSchema = z.union([
  z.object({
    ...sampleKeyFields,
    raw: z.string(),
    finalKind: finalKindSchema,
    final: z.string().optional(),
    finishReason: finishReasonSchema,
  }),
  z.object({
    ...sampleKeyFields,
    error: z.object({ kind: errorKindSchema, message: z.string() }),
  }),
]);

export const samplesSchema = z.object({
  texts: z.array(sampleTextSchema),
  review: z.array(z.object({ ruleId: idSchema, keys: z.array(z.object(sampleKeyFields)) })),
  failing: z.array(
    z.object({
      ...cellKeyFields,
      keys: z.array(z.object({ ...sampleKeyFields, evidence: z.array(z.string()).optional() })),
    }),
  ),
});

export const coverageSchema = z.object({
  commonCases: count,
  baselineOnly: z.array(idSchema),
  candidateOnly: z.array(idSchema),
  changedHash: z.array(idSchema),
});

// Gate

export const gateReasonCodeSchema = z.enum([
  'partial-run',
  'no-judged-trials',
  'baseline-incomplete',
  'no-gate',
  'no-gated-cells',
  'regressed',
  'cell-undecided',
  'rule-not-judged',
  'dominant-error',
  'abandoned-in-systematic',
]);

const reasonFields = {
  ruleId: idSchema.optional(),
  lang: z.string().min(1).optional(),
  surface: surfaceSchema.optional(),
};

function reason<C extends GateReasonCode, P extends z.ZodType>(code: C, params: P) {
  return z.object({ code: z.literal(code), params, ...reasonFields });
}

function bareReason<C extends GateReasonCode>(code: C) {
  return z.object({ code: z.literal(code), ...reasonFields });
}

/** Each reason code with the params of its data-model §Gate row. */
export const gateReasonSchema = z
  .discriminatedUnion('code', [
    reason('partial-run', partialRunParamsSchema),
    reason('no-judged-trials', z.object({ variants: z.array(idSchema) })),
    reason('baseline-incomplete', z.object({ rate: share })),
    bareReason('no-gate'),
    bareReason('no-gated-cells'),
    bareReason('regressed'),
    bareReason('cell-undecided'),
    bareReason('rule-not-judged'),
    reason('dominant-error', z.object({ message: z.string(), share })),
    reason(
      'abandoned-in-systematic',
      z.object({
        trials: perVariant(abandonedCountsSchema),
        timeoutMs: perVariant(z.int().min(1)),
      }),
    ),
  ])
  .meta({ id: 'GateReason' });

export const gateSchema = z
  .object({
    outcome: z.enum(['pass', 'block', 'undecided', 'no-gate']),
    reasons: z.array(gateReasonSchema),
    blocking: z.array(z.object(cellKeyFields)),
    undecided: z.array(
      z.object({
        ruleId: idSchema,
        lang: z.string().min(1).optional(),
        surface: surfaceSchema.optional(),
        needed: neededSchema.optional(),
      }),
    ),
    excluded: z.array(z.object({ ruleId: idSchema, cause: excludedCauseSchema })),
  })
  .meta({ id: 'Gate' });

export const comparisonSchema = z
  .object({
    comparisonId: comparisonIdSchema,
    createdAt: timestamp,
    baseline: comparedRunSchema,
    candidate: comparedRunSchema,
    cells: z.array(cellSchema),
    aggregates: z.array(aggregateSchema),
    rules: z.array(ruleSummarySchema),
    summary: summarySchema,
    ops: perRole(variantOpsSchema),
    samples: samplesSchema,
    warnings: z.array(warningSchema),
    coverage: coverageSchema,
    scope: scopeSchema,
    gate: gateSchema,
    completion: z.array(
      z.object({ lang: z.string().min(1), trials: count, passes: count, rate: share.nullable() }),
    ),
    priorComparisons: count,
    stats: z.object({
      confidence: z.number().gt(0).lt(1),
      method: z.string().min(1),
      gatedCells: count,
      zLower: z.number(),
      zUpper: z.number(),
      minCases: z.int().min(3),
    }),
    config: z.object({
      gate: gateConfigSchema,
      stats: statsConfigSchema,
      report: reportConfigSchema,
    }),
  })
  .meta({ id: 'Comparison' });

// Page payloads (002 page-data §Payloads)

const pageEnvelope = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  lang: langSchema,
};

export const comparisonPageSchema = z.object({
  ...pageEnvelope,
  kind: z.literal('comparison'),
  comparison: comparisonSchema,
});

export const listPageSchema = z.object({
  ...pageEnvelope,
  kind: z.literal('list'),
  comparisons: z.array(
    z.object({
      comparisonId: comparisonIdSchema,
      href: z.string().min(1),
      baseline: idSchema,
      candidate: idSchema,
      createdAt: timestamp,
      gate: gateSchema.shape.outcome,
    }),
  ),
});

export const pageDataSchema = z
  .discriminatedUnion('kind', [comparisonPageSchema, listPageSchema])
  .meta({ id: 'PageData' });

export type Verdict = z.infer<typeof verdictSchema>;
export type CellNote = z.infer<typeof cellNoteSchema>;
export type Rate = z.infer<typeof rateSchema>;
export type Needed = z.infer<typeof neededSchema>;
export type Cell = z.infer<typeof cellSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export type RuleSummary = z.infer<typeof ruleSummarySchema>;
export type ComparedRun = z.infer<typeof comparedRunSchema>;
export type MetricRate = z.infer<typeof metricRateSchema>;
export type VariantOps = z.infer<typeof variantOpsSchema>;
export type OpsChange = z.infer<typeof opsChangeSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type SampleText = z.infer<typeof sampleTextSchema>;
export type Samples = z.infer<typeof samplesSchema>;
export type Coverage = z.infer<typeof coverageSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export type GateReasonCode = z.infer<typeof gateReasonCodeSchema>;
export type GateReason = z.infer<typeof gateReasonSchema>;
export type Gate = z.infer<typeof gateSchema>;
export type ComparisonPage = z.infer<typeof comparisonPageSchema>;
export type ListPage = z.infer<typeof listPageSchema>;
export type PageData = z.infer<typeof pageDataSchema>;
