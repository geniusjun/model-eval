import { z } from 'zod';

import { sha256Schema } from '../config/identifiers.js';
import { jsonObjectSchema, jsonValueSchema } from './json-value.js';

// Adapter protocol v1 (contracts/adapter-protocol.md). Unknown fields are ignored on
// both sides, so these objects strip them instead of rejecting them.

export const PROTOCOL_VERSION = '1';

const tokenCount = z.int().min(0);
/** The per-trial seed is an unsigned 32-bit integer (data-model §Identifiers and Hashing). */
export const seedSchema = z.int().min(0).max(0xffff_ffff);
const durationMs = z.number().min(0);

export const errorKindSchema = z.enum(['config', 'adapter', 'transient', 'permanent', 'timeout']);
export const modelErrorKindSchema = z.enum(['config', 'transient', 'permanent', 'timeout']);
export const finishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'other']);
export const finalKindSchema = z.enum(['model', 'fallback', 'discarded']);

export const usageSchema = z
  .object({
    input: tokenCount.optional(),
    cachedInput: tokenCount.optional(),
    cacheWrite: tokenCount.optional(),
    output: tokenCount.optional(),
    reasoning: tokenCount.optional(),
  })
  .meta({ id: 'Usage' });

/** The only home of the call record (data-model §Trial). */
export const callRecordSchema = z
  .object({
    model: z.string().min(1),
    outcome: z.enum(['ok', 'failed', 'unanswered']),
    responseModel: z.string().min(1).optional(),
    errorKind: modelErrorKindSchema.optional(),
    retryAfterMs: z.int().min(0).optional(),
    branch: z.enum(['answer', 'side']).optional(),
    usage: usageSchema.optional(),
    finishReason: z.string().optional(),
    latencyMs: durationMs.optional(),
  })
  .meta({ id: 'CallRecord' });

export const stageSchema = z.object({ name: z.string(), text: z.string() });

export const capabilitiesSchema = z
  .object({
    render: z.boolean().default(false),
    stages: z.boolean().default(false),
    postprocess: z.boolean().default(true),
    cancel: z.boolean().default(false),
    maxConcurrency: z.int().min(1).optional(),
  })
  .meta({ id: 'Capabilities' });

export const helperSchema = z.object({ language: z.string().min(1), version: z.string().min(1) });

export const serviceSchema = z
  .object({
    version: z.string().min(1).optional(),
    dirty: z.boolean().optional(),
    treeHash: sha256Schema.optional(),
  })
  .meta({ id: 'Service' });

export const targetSchema = z.object({
  name: z.string().min(1),
  languages: z.array(z.string().min(1)).optional(),
  inputSchema: z.union([z.boolean(), jsonObjectSchema]),
});

export const protocolVariantSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  params: jsonObjectSchema.optional(),
});

// initialize

export const initializeParamsSchema = z.object({
  protocolVersion: z.string().min(1),
  client: z.object({ name: z.string().min(1), version: z.string().min(1) }),
  variant: protocolVariantSchema,
  timeoutMs: z.int().min(1),
  toolPaths: z.array(z.string().min(1)),
});

export const initializeResultSchema = z.object({
  protocolVersion: z.string().min(1),
  adapter: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    helper: helperSchema.optional(),
  }),
  service: serviceSchema.optional(),
  targets: z.array(targetSchema).min(1),
  capabilities: capabilitiesSchema.prefault({}),
});

// render and generate

const trialRequestFields = {
  target: z.string().min(1),
  lang: z.string().min(1).optional(),
  input: jsonObjectSchema,
};

export const renderParamsSchema = z.object({
  ...trialRequestFields,
  caseId: z.string().min(1).optional(),
  repeat: z.int().min(0).optional(),
  seed: seedSchema.optional(),
});

export const renderResultSchema = z.object({
  messages: z.array(z.object({ role: z.string().min(1), content: z.string() })).min(1),
  tools: z.array(jsonValueSchema).optional(),
  fingerprint: sha256Schema.optional(),
  inputTokens: tokenCount.optional(),
  maxOutputTokens: z.int().min(1).optional(),
});

export const generateParamsSchema = z.object({
  ...trialRequestFields,
  caseId: z.string().min(1),
  repeat: z.int().min(0),
  seed: seedSchema,
});

const resultCostFields = {
  usage: usageSchema.optional(),
  calls: z.array(callRecordSchema).optional(),
  warnings: z.array(z.string()).optional(),
};

const answerFields = {
  ...resultCostFields,
  raw: z.string(),
  answers: z.int().min(0).default(1),
  stages: z.array(stageSchema).optional(),
  latencyMs: durationMs,
  finishReason: finishReasonSchema,
  modelSnapshot: z.string().min(1).optional(),
  fingerprint: sha256Schema.optional(),
};

/** `answers` 0 means no model answer, so the service cannot have shipped one. */
const modelResultSchema = z.object({
  ...answerFields,
  answers: z.int().min(1).default(1),
  finalKind: z.literal('model'),
  final: z.string(),
});

const fallbackResultSchema = z.object({
  ...answerFields,
  finalKind: z.literal('fallback'),
  final: z.string(),
});

const discardedResultSchema = z.object({
  ...answerFields,
  finalKind: z.literal('discarded'),
  discardReason: z.string().optional(),
});

export const answerResultSchema = z.discriminatedUnion('finalKind', [
  modelResultSchema,
  fallbackResultSchema,
  discardedResultSchema,
]);

export const failureResultSchema = z.object({
  ...resultCostFields,
  error: z.object({
    kind: modelErrorKindSchema,
    message: z.string(),
    retryAfterMs: z.int().min(0).optional(),
  }),
  latencyMs: durationMs.optional(),
});

export const generateResultSchema = z.union([failureResultSchema, answerResultSchema]);

export const rpcErrorDataSchema = z.object({
  usage: usageSchema.optional(),
  calls: z.array(callRecordSchema).optional(),
  capturedRaw: z.string().optional(),
});

export const shutdownResultSchema = z.null();

// Notifications

export const cancelParamsSchema = z.object({ id: z.int() });

export const callsParamsSchema = z.object({
  id: z.int().optional(),
  calls: z.array(callRecordSchema),
});

export const logParamsSchema = z.object({ level: z.string().min(1), message: z.string() });

// JSON-RPC 2.0 framing

const rpcId = z.int();

/** JSON-RPC 2.0 params are structured: an object or an array, and left out when there are none. */
const rpcParams = z.union([jsonObjectSchema, z.array(jsonValueSchema)]);

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId,
  method: z.string().min(1),
  params: rpcParams.optional(),
});

export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: rpcParams.optional(),
});

export const rpcErrorSchema = z.object({
  code: z.int(),
  message: z.string(),
  data: jsonValueSchema.optional(),
});

export const rpcSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId,
  result: jsonValueSchema,
});

export const rpcFailureSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: rpcId.nullable(),
  error: rpcErrorSchema,
});

/** What an adapter may write on stdout: a response or a notification. */
export const adapterMessageSchema = z.union([
  rpcFailureSchema,
  rpcSuccessSchema,
  rpcNotificationSchema,
]);

export type ErrorKind = z.infer<typeof errorKindSchema>;
export type ModelErrorKind = z.infer<typeof modelErrorKindSchema>;
export type FinishReason = z.infer<typeof finishReasonSchema>;
export type FinalKind = z.infer<typeof finalKindSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type CallRecord = z.infer<typeof callRecordSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Helper = z.infer<typeof helperSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type Target = z.infer<typeof targetSchema>;
export type ProtocolVariant = z.infer<typeof protocolVariantSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type RenderParams = z.infer<typeof renderParamsSchema>;
export type RenderResult = z.infer<typeof renderResultSchema>;
export type GenerateParams = z.infer<typeof generateParamsSchema>;
export type AnswerResult = z.infer<typeof answerResultSchema>;
export type FailureResult = z.infer<typeof failureResultSchema>;
export type GenerateResult = z.infer<typeof generateResultSchema>;
export type RpcErrorData = z.infer<typeof rpcErrorDataSchema>;
export type CancelParams = z.infer<typeof cancelParamsSchema>;
export type CallsParams = z.infer<typeof callsParamsSchema>;
export type LogParams = z.infer<typeof logParamsSchema>;
export type RpcError = z.infer<typeof rpcErrorSchema>;
export type AdapterMessage = z.infer<typeof adapterMessageSchema>;
