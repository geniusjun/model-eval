import { z } from 'zod';

import { jsonObjectSchema } from '../adapter/json-value.js';
import {
  capabilitiesSchema,
  helperSchema,
  serviceSchema,
  usageSchema,
} from '../adapter/protocol.js';
import { comparisonIdSchema, idSchema, sha256Schema } from '../config/identifiers.js';
import { priceSchema } from '../config/schema.js';
import { runStatusSchema, stopReasonSchema } from './status.js';
import { warningSchema } from './warning.js';

export { runStatusSchema, stopReasonSchema };

// manifest.json and swaps/<swapId>.json (data-model §Run, §Manifest).

const usd = z.number().min(0);
const nullableUsd = usd.nullable();
const timestamp = z.iso.datetime({ offset: true });

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[a-z0-9][a-z0-9._-]{0,63}-[0-9a-f]{4}$/;
export const SWAP_ID_PATTERN = /^\d{8}-\d{6}-swap-[0-9a-f]{4}$/;

export const runIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN, 'must be YYYYMMDD-HHMMSS-<variantId>-<4 hex>');
export const swapIdSchema = z
  .string()
  .regex(SWAP_ID_PATTERN, 'must be YYYYMMDD-HHMMSS-swap-<4 hex>');

export const toolInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().min(1),
  })
  .meta({ id: 'ToolInfo' });

export const adapterInfoSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    protocolVersion: z.string().min(1),
    launchHash: sha256Schema,
    helper: helperSchema.optional(),
    capabilities: capabilitiesSchema,
  })
  .meta({ id: 'AdapterInfo' });

export const variantRecordSchema = z
  .object({
    id: idSchema,
    model: z.string().min(1),
    params: jsonObjectSchema.optional(),
    fingerprint: sha256Schema,
  })
  .meta({ id: 'VariantRecord' });

export const budgetRecordSchema = z.object({
  maxCostUsd: nullableUsd,
  scope: z.enum(['run', 'swap']),
});

/** Estimate basis per language key (`*` for cases without a language), data-model §Cost. */
export const basisSchema = z.record(z.string().min(1), z.enum(['history', 'structure']));

export const estimateSchema = z.object({
  expected: nullableUsd,
  conservative: nullableUsd,
  basis: basisSchema,
  projected: z.array(
    z.object({
      trigger: z.enum(['first-batch', 'repeat-round', 'resume']),
      repeat: z.int().min(0).optional(),
      totalUsd: nullableUsd,
    }),
  ),
});

export const costProfileSchema = z.object({
  repeat0MeanUsd: nullableUsd,
  repeatNMeanUsd: nullableUsd,
  inputTokensMean: z.number().min(0),
  outputTokensMean: z.number().min(0),
  outputTokensP95: z.number().min(0),
  cacheHitRatio: z.number().min(0).max(1).nullable(),
  callsPerTrialP95: z.number().min(1),
  callsPerAttemptMax: z.int().min(1),
});

const outcomeCount = z.int().min(0);

export const totalsSchema = z.object({
  outcomes: z.object({
    ok: outcomeCount,
    config: outcomeCount,
    adapter: outcomeCount,
    transient: outcomeCount,
    permanent: outcomeCount,
    timeout: outcomeCount,
    stopped: outcomeCount,
  }),
  tokens: usageSchema,
  costUsd: nullableUsd,
  reservedUsd: usd,
  overrunUsd: usd,
  durationMs: z.number().min(0),
});

export const segmentSchema = z.object({
  segment: z.int().min(1),
  startedAt: timestamp,
  endedAt: timestamp.optional(),
  tool: z.object({ version: z.string().min(1) }),
  adapter: z.object({ version: z.string().min(1), helper: helperSchema.optional() }),
  pricing: z.record(z.string().min(1), priceSchema),
  maxCostUsd: nullableUsd,
  concurrency: z.int().min(1),
  toolPaths: z.array(z.string().min(1)),
  spentUsd: nullableUsd,
  resumeWarnings: z.array(warningSchema).default([]),
});

export const manifestSchema = z
  .object({
    runId: runIdSchema,
    swapId: swapIdSchema.optional(),
    tool: toolInfoSchema.extend({ startedAt: timestamp }),
    adapter: adapterInfoSchema,
    service: serviceSchema,
    variant: variantRecordSchema,
    cases: z.array(z.object({ id: idSchema, lang: z.string().min(1), hash: sha256Schema })),
    rulesHash: sha256Schema,
    prompts: z.record(idSchema, sha256Schema).optional(),
    sampling: z.object({
      repeats: z.int().min(1),
      seed: z.int().min(0),
      cases: z.string().min(1).nullable(),
    }),
    limits: z.object({ retries: z.int().min(0), timeoutMs: z.int().min(1) }),
    pricing: z.record(z.string().min(1), priceSchema),
    budget: budgetRecordSchema,
    estimate: estimateSchema,
    costProfile: z.record(z.string().min(1), costProfileSchema).optional(),
    totals: totalsSchema,
    segments: z.array(segmentSchema).min(1),
    warnings: z.array(warningSchema),
    status: runStatusSchema,
    stopReason: stopReasonSchema.optional(),
  })
  .meta({ id: 'Manifest' });

export const swapRecordSchema = z
  .object({
    swapId: swapIdSchema,
    baselineRunId: runIdSchema,
    candidateRunId: runIdSchema,
    budget: budgetRecordSchema,
    spentUsd: nullableUsd,
    segments: z.array(
      z.object({
        segment: z.int().min(1),
        startedAt: timestamp,
        endedAt: timestamp.optional(),
        spentUsd: nullableUsd,
      }),
    ),
    status: runStatusSchema,
    stopReason: stopReasonSchema.optional(),
    comparisonId: comparisonIdSchema.optional(),
  })
  .meta({ id: 'SwapRecord' });

export type { RunStatus, StopReason } from './status.js';
export type ToolInfo = z.infer<typeof toolInfoSchema>;
export type AdapterInfo = z.infer<typeof adapterInfoSchema>;
export type VariantRecord = z.infer<typeof variantRecordSchema>;
export type Estimate = z.infer<typeof estimateSchema>;
export type CostProfile = z.infer<typeof costProfileSchema>;
export type Totals = z.infer<typeof totalsSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type SwapRecord = z.infer<typeof swapRecordSchema>;
