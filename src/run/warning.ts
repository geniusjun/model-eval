import { z } from 'zod';

import { modelErrorKindSchema } from '../adapter/protocol.js';
import { bareFinding, excludedCauseSchema, finding, perVariant } from '../config/finding.js';
import { stopReasonSchema } from './status.js';

/** Run and comparison warning codes of data-model §Warnings. */
export const warningCodeSchema = z.enum([
  'transient-rate',
  'discard-rate-increase',
  'regeneration-rate-increase',
  'latency-p95-ratio',
  'cost-ratio',
  'identical-repeats',
  'response-model-changed',
  'same-response-model',
  'render-mismatch',
  'budget-overrun',
  'abandoned-trials',
  'resume-unverified',
  'resume-config-ignored',
  'unpriced-model',
  'cached-input-unpriced',
  'estimate-low-accuracy',
  'conservative-over-budget',
  'excluded-from-gate',
  'partial-run',
  'versions-differ',
  'adapter-warnings',
]);

const rate = z.number().min(0).max(1);
const usd = z.number().min(0);
const count = z.int().min(0);
const ratio = z.number().min(0);
const models = z.array(z.string().min(1));

const rates = z.object({ rates: perVariant(rate), threshold: z.number().min(0) });

/** Shared by the warning and the gate reason of that name (data-model §Gate, row 1). */
export const partialRunParamsSchema = z.object({
  runs: perVariant(
    z.object({ status: z.enum(['partial', 'running']), stopReason: stopReasonSchema.nullable() }),
  ),
});

export const abandonedCountsSchema = z.object({ timeout: count, restart: count });

/** Each code with the params of its data-model §Warnings row. */
export const warningSchema = z
  .discriminatedUnion('code', [
    finding('transient-rate', rates),
    finding('discard-rate-increase', rates),
    finding('regeneration-rate-increase', rates),
    finding(
      'latency-p95-ratio',
      z.object({ p95Ms: perVariant(z.number().min(0)), ratio, threshold: ratio }),
    ),
    finding('cost-ratio', z.object({ costPerTrialUsd: perVariant(usd), ratio, threshold: ratio })),
    bareFinding('identical-repeats'),
    finding('response-model-changed', z.object({ models: perVariant(models) })),
    finding('same-response-model', z.object({ models })),
    finding('render-mismatch', z.object({ trials: perVariant(count) })),
    finding('budget-overrun', z.object({ overrunUsd: perVariant(usd) })),
    finding(
      'abandoned-trials',
      z.object({
        trials: perVariant(abandonedCountsSchema),
        timeoutMs: perVariant(z.int().min(1)),
        lateFailures: perVariant(
          z.partialRecord(
            modelErrorKindSchema,
            z.object({ trials: count, maxRetryAfterMs: z.int().min(0).nullable() }),
          ),
        ),
      }),
    ),
    finding(
      'resume-unverified',
      z.object({
        conditions: z.array(z.enum(['service-version', 'tree-hash', 'render-fingerprint'])),
      }),
    ),
    finding(
      'resume-config-ignored',
      z.object({
        fields: z.array(z.enum(['variant', 'seed', 'repeats', 'retries', 'timeoutMs'])),
      }),
    ),
    finding('unpriced-model', z.object({ models })),
    finding('cached-input-unpriced', z.object({ models })),
    finding('estimate-low-accuracy', z.object({ inputTokens: z.int().min(1) })),
    finding('conservative-over-budget', z.object({ conservativeUsd: usd, maxCostUsd: usd })),
    finding('excluded-from-gate', z.object({ cause: excludedCauseSchema })),
    finding('partial-run', partialRunParamsSchema),
    finding(
      'versions-differ',
      z.object({
        fields: z.array(z.enum(['service', 'adapter-version', 'launch-hash', 'helper-version'])),
      }),
    ),
    finding('adapter-warnings', z.object({ sentence: z.string(), trials: perVariant(count) })),
  ])
  .meta({ id: 'Warning' });

export type WarningCode = z.infer<typeof warningCodeSchema>;
export type Warning = z.infer<typeof warningSchema>;
