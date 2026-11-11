import { createHash } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson, hashValue } from './canonical-json.js';
import { jsonObjectSchema } from './json-value.js';
import {
  callRecordSchema,
  capabilitiesSchema,
  helperSchema,
  PROTOCOL_VERSION,
  rpcErrorDataSchema,
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

/**
 * Adapter faults of adapter-protocol §Time Limits and Recovery: `hang` never answers (until a
 * declared `cancel`), `late` answers after `delayMs`, `crash` exits, `noise` writes a non-protocol
 * line on stdout, and `missing-fields` answers without `raw` and `finishReason`.
 */
export const FAULT_ROWS = ['hang', 'late', 'crash', 'noise', 'missing-fields'] as const;

export type FaultRow = (typeof FAULT_ROWS)[number];
export type ScenarioRow = OutcomeRow | FaultRow;

const probability = z.number().min(0).max(1);
const perLang = z.record(z.string().min(1), z.string());

const behaviourSchema = z.strictObject({
  /** Answer template per language (`*` for any); `{caseId}`, `{repeat}` and `{lang}` are filled in. */
  answer: perLang.default({ '*': 'answer to {caseId} #{repeat}' }),
  fallback: z.string().default('Sorry, please try again.'),
  /** System prompt per language for this variant, before the scenario's `prompts`. */
  prompts: perLang.default({}),
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
        row: z.enum([...OUTCOME_ROWS, ...FAULT_ROWS]),
        probability,
        /** The error message; for `noise`, the line written on stdout. */
        message: z.string().optional(),
        retryAfterMs: z.int().min(0).optional(),
        /** The row applies only to the first N `generate` requests of a trial key. */
        firstSends: z.int().min(1).optional(),
        /** The row applies only to these cases. */
        caseIds: z.array(z.string().min(1)).optional(),
        /** `late`: how long after the request the answer comes. */
        delayMs: z.int().min(0).optional(),
        /** `late` and `hang`: the calls of the answer that comes late or after `cancel`. */
        calls: z.array(callRecordSchema).optional(),
        /** `adapter`: the `data` of the JSON-RPC error. */
        data: rpcErrorDataSchema.optional(),
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
  /** `{repeat}` is filled in, so a snapshot can change between repeats. */
  modelSnapshot: z.string().min(1).optional(),
  /** `other` reports a request fingerprint that differs from the render's. */
  requestFingerprint: z.enum(['render', 'other']).default('render'),
  /** Sent as a `calls` notification for the request before its response. */
  beforeCalls: z.array(callRecordSchema).default([]),
  /** Sent as a `calls` notification for the request after its response. */
  afterCalls: z.array(callRecordSchema).default([]),
  /** Waits this long after the response before sending `afterCalls`; `shutdown` waits for them. */
  afterCallsDelayMs: z.int().min(0).default(0),
  /** Sentences attached to results as `warnings`, each drawn per trial. */
  warnings: z.array(z.strictObject({ text: z.string().min(1), probability })).default([]),
  /** `log` notifications sent at each `generate`; `{caseId}`, `{repeat}` and `{lang}` are filled in. */
  logs: z.array(z.strictObject({ level: z.string().min(1), message: z.string() })).default([]),
  /** A line written to stderr at each `generate`, filled in like `logs`. */
  stderr: z.string().optional(),
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
  /**
   * What a restarted process declares instead of `adapter` and `service`. A process counts as
   * restarted when `MOCK_STATE_DIR` is set and an earlier process of its variant started there.
   */
  restarted: z
    .strictObject({
      adapter: z
        .strictObject({
          name: z.string().min(1),
          version: z.string().min(1),
          helper: helperSchema.optional(),
        })
        .optional(),
      service: serviceSchema.optional(),
      /** `at-start` exits before answering `initialize`; `after-initialize` right after it. */
      exit: z.enum(['at-start', 'after-initialize']).optional(),
    })
    .optional(),
  /** A line written on stdout before anything else, which breaks the protocol at the start. */
  startNoise: z.string().optional(),
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
  /** Cases whose `render` answers with a JSON-RPC error. */
  renderErrors: z.array(z.string().min(1)).default([]),
  /** Cases whose `render` result has no `messages`, which breaks the protocol. */
  renderInvalid: z.array(z.string().min(1)).default([]),
  /** Cases whose `render` makes the adapter exit without answering. */
  renderExits: z.array(z.string().min(1)).default([]),
  /** Cases whose `render` is answered, after which the adapter exits before `shutdown`. */
  renderThenExit: z.array(z.string().min(1)).default([]),
  /** Wait before each `render` answer. */
  renderDelayMs: z.int().min(0).default(0),
  /**
   * `ignore` never answers `shutdown`, `exit` exits without answering it, `error` answers it with
   * a JSON-RPC error, and `stray` writes a non-protocol line to stdout before answering.
   */
  shutdownReply: z.enum(['answer', 'ignore', 'exit', 'error', 'stray']).default('answer'),
  /** Sent as a `calls` notification without an `id` before the `shutdown` response. */
  shutdownCalls: z.array(callRecordSchema).default([]),
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

/** `restarted` is whether an earlier process of this variant started (`MOCK_STATE_DIR`). */
export function initializeResult(scenario: Scenario, restarted = false): InitializeResult {
  const adapter = (restarted ? scenario.restarted?.adapter : undefined) ?? scenario.adapter;
  const service = (restarted ? scenario.restarted?.service : undefined) ?? scenario.service;
  return {
    protocolVersion: scenario.protocolVersion,
    adapter,
    ...(service === undefined ? {} : { service }),
    targets: scenario.targets,
    capabilities: scenario.capabilities,
  };
}

/** `behaviour` is the initialised variant's, whose own prompts come first. */
export function renderCase(
  scenario: Scenario,
  params: RenderParams,
  behaviour?: Behaviour,
): RenderResult {
  const prompt = pick(behaviour?.prompts ?? {}, params.lang) ?? pick(scenario.prompts, params.lang);
  const messages = [
    { role: 'system', content: prompt ?? '' },
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

/** What the mock does with one `generate` request. */
export type MockAction =
  | { readonly kind: 'reply'; readonly reply: MockReply }
  /** Answers `reply` after `delayMs`, or never without it; a declared `cancel` answers at once. */
  | { readonly kind: 'late'; readonly reply: MockReply; readonly delayMs?: number }
  /** A result without `raw` and `finishReason`, which breaks the protocol. */
  | { readonly kind: 'broken'; readonly result: BrokenResult }
  | { readonly kind: 'crash' }
  | { readonly kind: 'noise'; readonly line: string };

export interface BrokenResult {
  readonly finalKind: 'model';
  readonly final: string;
  readonly latencyMs: number;
}

/** `sends` counts the `generate` requests of this trial key so far, this one included. */
export function generateAction(
  scenario: Scenario,
  variant: ProtocolVariant,
  params: GenerateParams,
  sends = 1,
): MockAction {
  const behaviour = behaviourFor(scenario, variant);
  const outcome = pickOutcome(behaviour, params, sends);
  switch (outcome.row) {
    case 'crash':
      return { kind: 'crash' };
    case 'noise':
      return { kind: 'noise', line: fill(outcome.message ?? 'debug: {caseId}', params) };
    case 'hang':
      return { kind: 'late', reply: lateReply(scenario, behaviour, variant, params, outcome) };
    case 'late':
      return {
        kind: 'late',
        reply: lateReply(scenario, behaviour, variant, params, outcome),
        delayMs: outcome.delayMs ?? 0,
      };
    case 'missing-fields':
      return {
        kind: 'broken',
        result: {
          finalKind: 'model',
          final: texts(behaviour, params).shipped,
          latencyMs: behaviour.latencyMs,
        },
      };
    default:
      return { kind: 'reply', reply: tableReply(scenario, behaviour, variant, params, outcome) };
  }
}

/** The answer of a trial whose row is a row of data-model §Trial Outcomes. */
function tableReply(
  scenario: Scenario,
  behaviour: Behaviour,
  variant: ProtocolVariant,
  params: GenerateParams,
  outcome: ScenarioOutcome,
): MockReply {
  if (outcome.row === 'adapter') {
    return {
      error: {
        code: -32603,
        message: outcome.message ?? 'mock adapter exception',
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
      },
    };
  }
  const warnings = drawnWarnings(behaviour, params);
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
      ...warnings,
    };
    return { result: failure };
  }

  const { raw, shipped } = texts(behaviour, params);
  const fingerprint = requestFingerprint(scenario, behaviour, params);
  const modelSnapshot =
    behaviour.modelSnapshot === undefined ? undefined : fill(behaviour.modelSnapshot, params);
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
    ...(modelSnapshot === undefined ? {} : { modelSnapshot }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...withCalls([answerCallRecord(behaviour, variant, modelSnapshot)], behaviour.calls),
    ...warnings,
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

/** The normal answer, with the row's `calls` when it gives them. */
function lateReply(
  scenario: Scenario,
  behaviour: Behaviour,
  variant: ProtocolVariant,
  params: GenerateParams,
  outcome: ScenarioOutcome,
): MockReply {
  const reply = tableReply(scenario, behaviour, variant, params, NORMAL);
  return 'result' in reply && outcome.calls !== undefined
    ? { result: { ...reply.result, calls: outcome.calls } }
    : reply;
}

function drawnWarnings(behaviour: Behaviour, params: GenerateParams): { warnings?: string[] } {
  const warnings = behaviour.warnings
    .filter((warning, index) => draw(params.seed, `warning:${String(index)}`) < warning.probability)
    .map((warning) => warning.text);
  return warnings.length === 0 ? {} : { warnings };
}

const FAILURE_KINDS: Partial<Record<ScenarioRow, ModelErrorKind>> = {
  config: 'config',
  transient: 'transient',
  permanent: 'permanent',
  timeout: 'timeout',
};

type ScenarioOutcome = Behaviour['outcomes'][number];

const NORMAL: ScenarioOutcome = { row: 'normal', probability: 1 };

function pickOutcome(behaviour: Behaviour, params: GenerateParams, sends: number): ScenarioOutcome {
  const u = draw(params.seed, 'outcome');
  let cumulative = 0;
  for (const outcome of behaviour.outcomes) {
    if (outcome.firstSends !== undefined && sends > outcome.firstSends) {
      continue;
    }
    if (outcome.caseIds !== undefined && !outcome.caseIds.includes(params.caseId)) {
      continue;
    }
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

function requestFingerprint(
  scenario: Scenario,
  behaviour: Behaviour,
  params: GenerateParams,
): string | undefined {
  if (!scenario.capabilities.render) {
    return undefined;
  }
  return behaviour.requestFingerprint === 'render'
    ? renderCase(scenario, params, behaviour).fingerprint
    : hashValue({ messages: [], tools: null });
}

function answerCallRecord(
  behaviour: Behaviour,
  variant: ProtocolVariant,
  modelSnapshot: string | undefined,
): CallRecord {
  return {
    model: variant.model,
    outcome: 'ok',
    branch: 'answer',
    latencyMs: behaviour.latencyMs,
    ...(modelSnapshot === undefined ? {} : { responseModel: modelSnapshot }),
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

/** Fills `{caseId}`, `{repeat}` and `{lang}` of a template with one request's values. */
export function fill(template: string, params: GenerateParams): string {
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
