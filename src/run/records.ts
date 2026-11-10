import { z } from 'zod';

import {
  callRecordSchema,
  seedSchema,
  errorKindSchema,
  finishReasonSchema,
  stageSchema,
  usageSchema,
} from '../adapter/protocol.js';
import { idSchema, sha256Schema } from '../config/identifiers.js';

// Lines of trials.jsonl (data-model §Trial).

const repeat = z.int().min(0);
const attempt = z.int().min(1);
const segment = z.int().min(1);
const usd = z.number().min(0);
/** `null` when no price at all is configured: cost is then unknown, never 0. */
const costUsd = usd.nullable();

export const sendLineSchema = z
  .object({
    caseId: idSchema,
    repeat,
    attempt,
    segment,
    reservedUsd: costUsd,
    sending: z.literal(true),
  })
  .meta({ id: 'SendLine' });

const attemptBase = {
  caseId: idSchema,
  repeat,
  attempt,
  segment,
  seed: seedSchema,
  costUsd,
  costEstimated: z.boolean().optional(),
  usage: usageSchema.optional(),
  calls: z.array(callRecordSchema).optional(),
  warnings: z.array(z.string()).optional(),
};

const okBase = {
  ...attemptBase,
  status: z.literal('ok'),
  raw: z.string(),
  answers: z.int().min(0),
  stages: z.array(stageSchema).optional(),
  latencyMs: z.number().min(0),
  finishReason: finishReasonSchema,
  modelSnapshot: z.string().min(1).optional(),
  fingerprint: sha256Schema.optional(),
};

const modelAttemptSchema = z.object({
  ...okBase,
  answers: z.int().min(1),
  finalKind: z.literal('model'),
  final: z.string(),
});

const fallbackAttemptSchema = z.object({
  ...okBase,
  finalKind: z.literal('fallback'),
  final: z.string(),
});

const discardedAttemptSchema = z.object({
  ...okBase,
  finalKind: z.literal('discarded'),
  discardReason: z.string().optional(),
});

/** Constitution I: an `ok` attempt always records `raw` and `finalKind`. */
export const okAttemptSchema = z.discriminatedUnion('finalKind', [
  modelAttemptSchema,
  fallbackAttemptSchema,
  discardedAttemptSchema,
]);

export const errorAttemptSchema = z.object({
  ...attemptBase,
  status: z.literal('error'),
  error: z.object({
    kind: errorKindSchema,
    message: z.string(),
    retryAfterMs: z.int().min(0).optional(),
    abandoned: z.enum(['timeout', 'restart']).optional(),
    capturedRaw: z.string().optional(),
  }),
  latencyMs: z.number().min(0).optional(),
});

export const stoppedAttemptSchema = z.object({ ...attemptBase, status: z.literal('stopped') });

export const attemptLineSchema = z
  .discriminatedUnion('status', [okAttemptSchema, errorAttemptSchema, stoppedAttemptSchema])
  .meta({ id: 'AttemptLine' });

const costLineBase = {
  segment,
  source: z.enum(['late', 'calls']),
  costUsd,
  costEstimated: z.boolean().optional(),
  usage: usageSchema.optional(),
  costCorrection: z.literal(true),
};

export const keyedCostLineSchema = z.object({
  ...costLineBase,
  caseId: idSchema,
  repeat,
  attempt,
  calls: z.array(callRecordSchema).optional(),
});

/** Calls the adapter reported for no known trial; a trial key here is an error, not a key. */
export const unkeyedCostLineSchema = z.strictObject({
  ...costLineBase,
  calls: z.array(callRecordSchema),
});

export const costLineSchema = z
  .union([keyedCostLineSchema, unkeyedCostLineSchema])
  .meta({ id: 'CostLine' });

export const trialLineSchema = z.union([sendLineSchema, attemptLineSchema, costLineSchema]);

export type SendLine = z.infer<typeof sendLineSchema>;
export type OkAttempt = z.infer<typeof okAttemptSchema>;
export type ErrorAttempt = z.infer<typeof errorAttemptSchema>;
export type StoppedAttempt = z.infer<typeof stoppedAttemptSchema>;
export type AttemptLine = z.infer<typeof attemptLineSchema>;
export type CostLine = z.infer<typeof costLineSchema>;
export type TrialLine = z.infer<typeof trialLineSchema>;
