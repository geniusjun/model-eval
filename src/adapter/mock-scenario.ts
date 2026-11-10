import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, hashValue } from './canonical-json.js';
import { jsonObjectSchema } from './json-value.js';
import {
  capabilitiesSchema,
  helperSchema,
  PROTOCOL_VERSION,
  serviceSchema,
  usageSchema,
  type CallRecord,
  type FailureResult,
  type GenerateParams,
  type GenerateResult,
  type InitializeResult,
  type ModelErrorKind,
  type ProtocolVariant,
  type RenderParams,
  type RenderResult,
  type RpcErrorData,
} from './protocol.js';

// Scenario files that drive the mock adapter (test/fixtures/mock/). Every random choice is
// drawn from the per-trial seed, so both variants of a trial see the same draws and a
// candidate whose violation probability is higher fails on a superset of the baseline's trials.

/** Outcome rows of data-model §Trial Outcomes, in table order. */
export const OUTCOME_ROWS = [
  'config',
  'adapter',
  'transient',
  'permanent',
  'timeout',
  'empty-raw',
  'discarded',
  'fallback',
  'empty-final',
  'cut',
  'normal',
] as const;

export type OutcomeRow = (typeof OUTCOME_ROWS)[number];

const probability = z.number().min(0).max(1);
const perLang = z.record(z.string().min(1), z.string());

const behaviourSchema = z.strictObject({
  /** Answer template per language (`*` for any); `{caseId}`, `{repeat}` and `{lang}` are filled in. */
  answer: perLang.default({ '*': 'answer to {caseId} #{repeat}' }),
  fallback: z.string().default('Sorry, please try again.'),
  violations: z
    .array(
      z.strictObject({
        text: z.string().min(1),
        probability,
        langs: z.array(z.string().min(1)).optional(),
        /** Post-processing removes it from the shipped text. */
        masked: z.boolean().default(false),
      }),
    )
    .default([]),
  outcomes: z
    .array(
      z.strictObject({
        row: z.enum(OUTCOME_ROWS),
        probability,
        message: z.string().optional(),
        retryAfterMs: z.int().min(0).optional(),
      }),
    )
    .default([]),
  answers: z.int().min(1).default(1),
  stages: z.boolean().default(false),
  usage: usageSchema.optional(),
  calls: z.boolean().default(false),
  latencyMs: z.number().min(0).default(100),
  /** Real wait before answering, drawn per trial between min and max. */
  delayMs: z.strictObject({ min: z.int().min(0), max: z.int().min(0) }).default({ min: 0, max: 0 }),
  modelSnapshot: z.string().min(1).optional(),
});

export const scenarioSchema = z.strictObject({
  protocolVersion: z.string().min(1).default(PROTOCOL_VERSION),
  adapter: z
    .strictObject({
      name: z.string().min(1),
      version: z.string().min(1),
      helper: helperSchema.optional(),
    })
    .default({ name: 'mock', version: '0.0.0' }),
  service: serviceSchema.optional(),
  targets: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        languages: z.array(z.string().min(1)).optional(),
        inputSchema: jsonObjectSchema.default({ type: 'object' }),
      }),
    )
    .min(1),
  capabilities: capabilitiesSchema.prefault({}),
  /** System prompt per language (`*` for any), returned by `render`. */
  prompts: perLang.default({}),
  inputTokens: z.int().min(0).optional(),
  maxOutputTokens: z.int().min(1).optional(),
  /** Sends a `log` notification with the number of requests in flight at each `generate`. */
  reportInflight: z.boolean().default(false),
  /** Behaviour per variant ID; `*` applies to variants without their own entry. */
  variants: z.record(z.string().min(1), behaviourSchema),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Behaviour = z.infer<typeof behaviourSchema>;

export type MockReply =
  | { readonly result: GenerateResult }
  | {
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: RpcErrorData;
      };
    };

/** A uniform draw in [0, 1) from the per-trial seed and a key. */
export function draw(seed: number, key: string): number {
  return (
    createHash('sha256')
      .update(`${String(seed)}:${key}`)
      .digest()
      .readUInt32BE(0) /
    2 ** 32
  );
}

export function behaviourFor(scenario: Scenario, variant: ProtocolVariant): Behaviour {
  const behaviour = scenario.variants[variant.id] ?? scenario.variants['*'];
  if (behaviour === undefined) {
    throw new Error(`the scenario has no behaviour for variant ${variant.id} and no * entry`);
  }
  return behaviour;
}

export function delayFor(scenario: Scenario, variant: ProtocolVariant, seed: number): number {
  const { min, max } = behaviourFor(scenario, variant).delayMs;
  return max > min ? min + Math.floor(draw(seed, 'delay') * (max - min + 1)) : min;
}

export function initializeResult(scenario: Scenario): InitializeResult {
  return {
    protocolVersion: scenario.protocolVersion,
    adapter: scenario.adapter,
    ...(scenario.service === undefined ? {} : { service: scenario.service }),
    targets: scenario.targets,
    capabilities: scenario.capabilities,
  };
}

export function renderCase(scenario: Scenario, params: RenderParams): RenderResult {
  const messages = [
    { role: 'system', content: pick(scenario.prompts, params.lang) ?? '' },
    { role: 'user', content: canonicalJson(params.input) },
  ];
  return {
    messages,
    fingerprint: hashValue({ messages, tools: null }),
    ...(scenario.inputTokens === undefined ? {} : { inputTokens: scenario.inputTokens }),
    ...(scenario.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: scenario.maxOutputTokens }),
  };
}

export function generateTrial(
  scenario: Scenario,
  variant: ProtocolVariant,
  params: GenerateParams,
): MockReply {
  const behaviour = behaviourFor(scenario, variant);
  const outcome = pickOutcome(behaviour, params.seed);

  if (outcome.row === 'adapter') {
    return { error: { code: -32603, message: outcome.message ?? 'mock adapter exception' } };
  }
  const failureKind = FAILURE_KINDS[outcome.row];
  if (failureKind !== undefined) {
    const failure: FailureResult = {
      error: {
        kind: failureKind,
        message: outcome.message ?? `mock ${failureKind} failure`,
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
      },
      latencyMs: behaviour.latencyMs,
      // A failed call was rejected and an unanswered one got no response: neither has usage.
      ...withCalls(
        [
          {
            model: variant.model,
            outcome: failureKind === 'timeout' ? 'unanswered' : 'failed',
            errorKind: failureKind,
            branch: 'answer',
            latencyMs: behaviour.latencyMs,
            ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
          },
        ],
        behaviour.calls,
      ),
    };
    return { result: failure };
  }

  const { raw, shipped } = texts(behaviour, params);
  const fingerprint = scenario.capabilities.render
    ? renderCase(scenario, params).fingerprint
    : undefined;
  const common = {
    raw: outcome.row === 'empty-raw' ? '' : raw,
    answers: behaviour.answers,
    latencyMs: behaviour.latencyMs,
    finishReason:
      outcome.row === 'cut' || outcome.row === 'empty-raw'
        ? ('length' as const)
        : ('stop' as const),
    ...(behaviour.stages ? { stages: [{ name: 'postprocess', text: shipped }] } : {}),
    ...(behaviour.usage === undefined ? {} : { usage: behaviour.usage }),
    ...(behaviour.modelSnapshot === undefined ? {} : { modelSnapshot: behaviour.modelSnapshot }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...withCalls([answerCallRecord(behaviour, variant)], behaviour.calls),
  };
  switch (outcome.row) {
    case 'discarded':
      return {
        result: {
          ...common,
          finalKind: 'discarded',
          discardReason: 'MockDiscard: answer thrown away',
        },
      };
    case 'fallback':
      return { result: { ...common, finalKind: 'fallback', final: behaviour.fallback } };
    case 'empty-raw':
    case 'empty-final':
      return { result: { ...common, finalKind: 'model', final: '' } };
    case 'cut':
      return { result: { ...common, finalKind: 'model', final: firstHalf(shipped) } };
    default:
      return { result: { ...common, finalKind: 'model', final: shipped } };
  }
}

const FAILURE_KINDS: Partial<Record<OutcomeRow, ModelErrorKind>> = {
  config: 'config',
  transient: 'transient',
  permanent: 'permanent',
  timeout: 'timeout',
};

type ScenarioOutcome = Behaviour['outcomes'][number];

const NORMAL: ScenarioOutcome = { row: 'normal', probability: 1 };

function pickOutcome(behaviour: Behaviour, seed: number): ScenarioOutcome {
  const u = draw(seed, 'outcome');
  let cumulative = 0;
  for (const outcome of behaviour.outcomes) {
    cumulative += outcome.probability;
    if (u < cumulative) {
      return outcome;
    }
  }
  return NORMAL;
}

function texts(behaviour: Behaviour, params: GenerateParams): { raw: string; shipped: string } {
  const base = fill(pick(behaviour.answer, params.lang) ?? '', params);
  const applied = behaviour.violations.filter(
    (violation, index) =>
      (violation.langs === undefined ||
        (params.lang !== undefined && violation.langs.includes(params.lang))) &&
      draw(params.seed, `violation:${String(index)}`) < violation.probability,
  );
  return {
    raw: base + applied.map((violation) => violation.text).join(''),
    shipped:
      base +
      applied
        .filter((violation) => !violation.masked)
        .map((violation) => violation.text)
        .join(''),
  };
}

function answerCallRecord(behaviour: Behaviour, variant: ProtocolVariant): CallRecord {
  return {
    model: variant.model,
    outcome: 'ok',
    branch: 'answer',
    latencyMs: behaviour.latencyMs,
    ...(behaviour.modelSnapshot === undefined ? {} : { responseModel: behaviour.modelSnapshot }),
    ...(behaviour.usage === undefined ? {} : { usage: behaviour.usage }),
  };
}

function withCalls(calls: CallRecord[], enabled: boolean): { calls?: CallRecord[] } {
  return enabled ? { calls } : {};
}

function pick(
  values: Readonly<Record<string, string>>,
  lang: string | undefined,
): string | undefined {
  return (lang === undefined ? undefined : values[lang]) ?? values['*'];
}

function fill(template: string, params: GenerateParams): string {
  const fields: Readonly<Record<string, string>> = {
    caseId: params.caseId,
    repeat: String(params.repeat),
    lang: params.lang ?? '*',
  };
  return template.replace(
    /\{(caseId|repeat|lang)\}/g,
    (_match, name: string) => fields[name] ?? '',
  );
}

function firstHalf(text: string): string {
  const codePoints = Array.from(text);
  return codePoints.slice(0, Math.ceil(codePoints.length / 2)).join('');
}
