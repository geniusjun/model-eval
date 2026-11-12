import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import { canonicalJson } from '../../../../src/adapter/canonical-json.js';
import {
  isJsonArray,
  isJsonObject,
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
  jsonValueSchema,
} from '../../../../src/adapter/json-value.js';
import type { RpcError } from '../../../../src/adapter/protocol.js';
import {
  AdapterDriver,
  type AdapterLanguage,
  apiEnv,
  type Exchange,
  type Provider,
  ROOT_CA,
  type RpcResponse,
} from './driver.js';
import { type MockApi, type ReceivedRequest, ROOT } from './mock-api.js';

const HELPER_FIXTURES = path.join(ROOT, 'test/fixtures/helper');
/** The mock server's plain HTTP address, also in a TLS case, for services that call it directly. */
export const MOCK_URL_VARIABLE = 'MODEL_EVAL_MOCK_URL';
const SCENARIOS = path.join(HELPER_FIXTURES, 'scenarios');

/** The SDK aliases of package.json, the Node SDK releases the contract tests run against. */
export const NODE_SDK_ALIASES = [
  'openai-5-first',
  'openai-5',
  'openai-6',
  'openai-7',
  'anthropic-sdk-0-first',
  'anthropic-sdk-0',
  'anthropic-sdk-1',
] as const;
export type NodeSdkAlias = (typeof NODE_SDK_ALIASES)[number];

export const APIS = ['chat-completions', 'responses', 'messages'] as const;
export type Api = (typeof APIS)[number];

/** The provider whose SDK calls an API, in Node and in Python. */
export function providerOf(api: Api): Provider {
  return api === 'messages' ? 'anthropic' : 'openai';
}

function isNodeSdkAlias(value: string): value is NodeSdkAlias {
  return NODE_SDK_ALIASES.some((alias) => alias === value);
}

/** `MODEL_EVAL_NODE_SDKS`, comma-separated, or every alias when unset. */
export function nodeSdkAliases(): NodeSdkAlias[] {
  const listed = process.env.MODEL_EVAL_NODE_SDKS;
  if (listed === undefined || listed.trim() === '') {
    return [...NODE_SDK_ALIASES];
  }
  return listed.split(',').map((name) => {
    const alias = name.trim();
    if (!isNodeSdkAlias(alias)) {
      throw new Error(
        `MODEL_EVAL_NODE_SDKS names ${alias}, not one of ${NODE_SDK_ALIASES.join(', ')}`,
      );
    }
    return alias;
  });
}

function aliasProvider(alias: NodeSdkAlias): Provider {
  return alias.startsWith('anthropic') ? 'anthropic' : 'openai';
}

const caseSchema = z
  .object({
    name: z.string(),
    languages: z.array(z.enum(['python', 'typescript'])).optional(),
    apis: z.array(z.enum(APIS)).optional(),
    sdks: z.array(z.string()).optional(),
    service: jsonObjectSchema,
    target: jsonObjectSchema.optional(),
    adapter: jsonObjectSchema.optional(),
    initialize: z
      .object({
        variant: jsonObjectSchema.optional(),
        timeoutMs: z.int().optional(),
        toolPaths: z.array(z.string()).optional(),
      })
      .optional(),
    request: z.enum(['generate', 'render']).optional(),
    params: jsonObjectSchema.optional(),
    trials: z.int().min(1).optional(),
    trialsInARow: z.int().min(2).optional(),
    shutdownAfterRequests: z.int().min(1).optional(),
    cancel: z
      .union([z.object({ afterRequests: z.int() }), z.object({ afterMs: z.int() })])
      .optional(),
    tls: z.string().optional(),
    script: z.array(jsonValueSchema).optional(),
    expect: jsonObjectSchema.optional(),
    expectPerTrial: z.array(jsonObjectSchema).min(2).optional(),
  })
  .loose()
  .refine((data) => (data.expect === undefined) !== (data.expectPerTrial === undefined), {
    message: 'a case gives exactly one of expect and expectPerTrial',
  });
export type CaseData = z.infer<typeof caseSchema>;
const fixtureSchema = z.record(z.string(), z.array(caseSchema));

/** One case of a scenario fixture, for one API and one SDK. */
export interface ScenarioCase {
  readonly scenario: string;
  readonly name: string;
  readonly data: CaseData;
  readonly api: Api;
  readonly language: AdapterLanguage;
  /** The Node SDK alias; absent for a Python adapter, whose SDK is the environment's. */
  readonly sdk?: NodeSdkAlias;
}

export function readScenarios(fileName: string): Record<string, CaseData[]> {
  const value: unknown = JSON.parse(readFileSync(path.join(SCENARIOS, fileName), 'utf8'));
  return fixtureSchema.parse(value);
}

/** The TypeScript cases of a fixture file, for every API and SDK alias they apply to. */
export function nodeCases(fileName: string): ScenarioCase[] {
  const aliases = nodeSdkAliases();
  return Object.entries(readScenarios(fileName)).flatMap(([scenario, cases]) =>
    cases
      .filter((data) => data.languages?.includes('typescript') ?? true)
      .flatMap((data) =>
        (data.apis ?? APIS).flatMap((api) =>
          aliases
            .filter((alias) => aliasProvider(alias) === providerOf(api))
            .filter((alias) => data.sdks?.includes(alias) ?? true)
            .map((sdk) => ({
              scenario,
              name: data.name,
              data,
              api,
              language: 'typescript' as const,
              sdk,
            })),
        ),
      ),
  );
}

/** The test name of a case. */
export function caseTitle(scenarioCase: ScenarioCase): string {
  const runtime = scenarioCase.sdk ?? 'python';
  return `${scenarioCase.scenario} ${scenarioCase.name} [${runtime} ${scenarioCase.api}]`;
}

// Running a case

const DEFAULT_VARIANT = { id: 'next', model: 'model-b' };

export interface Outcome {
  /** The response of the first trial. */
  readonly response: RpcResponse<JsonValue>;
  /** The response of every trial of a case with `trials` or `trialsInARow`, in send order. */
  readonly responses: readonly RpcResponse<JsonValue>[];
  readonly exchange: Exchange;
  readonly requests: ReceivedRequest[];
  readonly renderFingerprint: string | undefined;
}

function scenarioEnv(scenarioCase: ScenarioCase): Record<string, string> {
  const { data } = scenarioCase;
  const spec = {
    scenario: scenarioCase.scenario,
    service: data.service,
    target: data.target ?? {},
    adapter: data.adapter ?? {},
    api: scenarioCase.api,
    backend: 'async',
  };
  return { MODEL_EVAL_SCENARIO: JSON.stringify(spec) };
}

function initializeParams(data: CaseData): JsonObject {
  return {
    protocolVersion: '1',
    client: { name: 'model-eval', version: '0.0.0-test' },
    variant: { ...DEFAULT_VARIANT, ...data.initialize?.variant },
    timeoutMs: data.initialize?.timeoutMs ?? 30_000,
    toolPaths: data.initialize?.toolPaths ?? [],
  };
}

function trialParams(data: CaseData): JsonObject {
  const defaults = { target: 'chat', input: {}, caseId: 'case-1', lang: 'en', repeat: 0, seed: 1 };
  return { ...defaults, ...data.params };
}

/** The parts of the mock API server a case run uses. */
export type MockControl = Pick<MockApi, 'url' | 'load' | 'log' | 'tlsUrl'>;

/** Loads the case's script, runs its request in a new adapter, and shuts the adapter down. */
export async function runCase(
  scenarioCase: ScenarioCase,
  mock: MockControl,
  service = 'scenario',
): Promise<Outcome> {
  const { data } = scenarioCase;
  await mock.load(data.script ?? []);
  const baseUrl = data.tls === undefined ? mock.url : await mock.tlsUrl(data.tls);
  const env = {
    ...apiEnv(baseUrl),
    ...scenarioEnv(scenarioCase),
    [MOCK_URL_VARIABLE]: mock.url,
    ...(data.tls === undefined ? {} : { SSL_CERT_FILE: ROOT_CA, NODE_EXTRA_CA_CERTS: ROOT_CA }),
  };
  const driver = AdapterDriver.start({
    language: scenarioCase.language,
    service,
    env,
    ...(scenarioCase.language === 'python' ? { pythonSdk: providerOf(scenarioCase.api) } : {}),
    ...(scenarioCase.sdk === undefined ? {} : { sdk: scenarioCase.sdk }),
  });
  try {
    const initialized = await driver.initialize(initializeParams(data));
    if (initialized.kind === 'error') {
      throw new Error(`initialize failed: ${initialized.error.message}`);
    }
    let renderFingerprint: string | undefined;
    const fingerprints = eachExpect(expectationOf(data)).map((expected) => expected.fingerprint);
    if (fingerprints.some((value) => value === 'render' || value === 'not-render')) {
      const rendered = await driver.render(trialParams(data));
      renderFingerprint = rendered.kind === 'result' ? rendered.result.fingerprint : undefined;
    }
    const responses = await sendTrials(driver, data, mock);
    const [response] = responses;
    if (response === undefined) {
      throw new Error('the case sent no request');
    }
    if (data.shutdownAfterRequests !== undefined) {
      await waitForRequests(data.shutdownAfterRequests, mock);
    }
    await driver.shutdown();
    return {
      response,
      responses,
      exchange: driver.exchange,
      requests: await mock.log(),
      renderFingerprint,
    };
  } finally {
    await driver.close();
  }
}

/**
 * Sends the case's request. With `trials` N, that many `generate`s with caseIds `case-1` to
 * `case-N`, all before waiting for any response; with `trialsInARow` N, each after the previous
 * response arrived.
 */
async function sendTrials(
  driver: AdapterDriver,
  data: CaseData,
  mock: MockControl,
): Promise<RpcResponse<JsonValue>[]> {
  const together = data.trials ?? 1;
  const inARow = data.trialsInARow ?? 1;
  const total = Math.max(together, inARow);
  if (
    total > 1 &&
    (data.request === 'render' || data.cancel !== undefined || Math.min(together, inARow) > 1)
  ) {
    throw new Error('`trials` and `trialsInARow` take one generate request without `cancel`');
  }
  if (data.request === 'render') {
    return [asJson(await driver.render(trialParams(data)))];
  }
  const params =
    total > 1
      ? Array.from({ length: total }, (_, index) => ({
          ...trialParams(data),
          caseId: `case-${String(index + 1)}`,
        }))
      : [trialParams(data)];
  if (inARow > 1) {
    const responses: RpcResponse<JsonValue>[] = [];
    for (const trial of params) {
      responses.push(asJson(await driver.generate(trial).done));
    }
    return responses;
  }
  const sent = params.map((trial) => driver.generate(trial));
  const [first] = sent;
  if (data.cancel !== undefined && first !== undefined) {
    await waitToCancel(data.cancel, mock);
    driver.cancel(first.id);
  }
  const responses: RpcResponse<JsonValue>[] = [];
  for (const { done } of sent) {
    responses.push(asJson(await done));
  }
  return responses;
}

/** The result as the adapter sent it, for comparing with `expect`. */
function asJson(response: RpcResponse<unknown>): RpcResponse<JsonValue> {
  return response.kind === 'error'
    ? response
    : { kind: 'result', result: response.sent, sent: response.sent };
}

async function waitToCancel(
  cancel: { afterRequests: number } | { afterMs: number },
  mock: MockControl,
): Promise<void> {
  if ('afterMs' in cancel) {
    await sleep(cancel.afterMs);
    return;
  }
  await waitForRequests(cancel.afterRequests, mock);
}

/** Waits until the mock server's log holds `count` requests. */
async function waitForRequests(count: number, mock: MockControl): Promise<void> {
  const deadline = Date.now() + 30_000;
  while ((await mock.log()).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`the mock server never received ${String(count)} requests`);
    }
    await sleep(10);
  }
}

// Comparing with `expect`

const messagesSchema = z.object({
  messages: z.record(z.string(), z.object({ text: z.string() })),
});
const messageRefSchema = z.object({
  message: z.string(),
  placeholders: z.record(z.string(), z.string()).optional(),
});
type MessageRef = z.infer<typeof messageRefSchema>;

let messageTexts: Record<string, { text: string }> | undefined;

function messageText(id: string): string {
  messageTexts ??= messagesSchema.parse(
    JSON.parse(readFileSync(path.join(HELPER_FIXTURES, 'messages.json'), 'utf8')),
  ).messages;
  const message = messageTexts[id];
  if (message === undefined) {
    throw new Error(`messages.json has no message ${id}`);
  }
  return message.text;
}

/**
 * A message with its placeholders filled per helper-api §Messages: no period is added after a
 * value that already ends with '.', '!' or '?'.
 */
export function fillMessage(text: string, placeholders: Readonly<Record<string, string>>): string {
  return Object.entries(placeholders).reduce((filled, [name, value]) => {
    const marker = `<${name}>`;
    const ended = /[.!?]$/.test(value) ? filled.replaceAll(`${marker}.`, value) : filled;
    return ended.replaceAll(marker, value);
  }, text);
}

function sentence(ref: MessageRef): string {
  return fillMessage(messageText(ref.message), ref.placeholders ?? {});
}

/** Expected null means the field is absent, or with `nullIsAbsent` false the JSON null. */
function compare(
  name: string,
  expected: JsonValue,
  actual: JsonValue | undefined,
  mismatches: string[],
  nullIsAbsent = true,
): void {
  if (expected === null && nullIsAbsent) {
    if (actual !== undefined) {
      mismatches.push(`${name}: expected absent, got ${JSON.stringify(actual)}`);
    }
  } else if (actual === undefined || canonicalJson(expected) !== canonicalJson(actual)) {
    const shown = actual === undefined ? 'absent' : JSON.stringify(actual);
    mismatches.push(`${name}: expected ${JSON.stringify(expected)}, got ${shown}`);
  }
}

/** Records in order; only the fields each expected record lists are compared. */
function compareRecords(
  name: string,
  expected: JsonValue,
  actual: JsonValue | undefined,
  mismatches: string[],
  nullIsAbsent = true,
): void {
  const wanted = isJsonArray(expected) ? expected : [];
  const records = isJsonArray(actual) ? actual : [];
  if (wanted.length !== records.length) {
    mismatches.push(
      `${name}: expected ${String(wanted.length)} records, got ${JSON.stringify(records)}`,
    );
    return;
  }
  wanted.forEach((fields, index) => {
    const record = records[index];
    for (const [key, value] of Object.entries(isJsonObject(fields) ? fields : {})) {
      compare(
        `${name}[${String(index)}].${key}`,
        value,
        isJsonObject(record) ? record[key] : undefined,
        mismatches,
        nullIsAbsent,
      );
    }
  });
}

function compareMessages(
  name: string,
  expected: JsonValue,
  actual: readonly string[],
  mismatches: string[],
): void {
  const sentences = z.array(messageRefSchema).parse(expected).map(sentence);
  if (canonicalJson(sentences) !== canonicalJson([...actual])) {
    mismatches.push(
      `${name}: expected ${JSON.stringify(sentences)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function statusOf(response: RpcResponse<JsonValue>): string {
  if (response.kind === 'error') {
    return 'adapter-error';
  }
  return isJsonObject(response.result) && 'error' in response.result ? 'failed' : 'ok';
}

function errorData(error: RpcError): JsonObject {
  return isJsonObject(error.data) ? error.data : {};
}

/** A result field, or a field of the JSON-RPC error's data for an adapter error. */
function resultField(response: RpcResponse<JsonValue>, name: string): JsonValue | undefined {
  if (response.kind === 'error') {
    return errorData(response.error)[name];
  }
  const result = isJsonObject(response.result) ? response.result : {};
  if (name === 'answers' && 'finalKind' in result) {
    return result.answers ?? 1;
  }
  return result[name];
}

function stringList(value: JsonValue | undefined): string[] {
  return isJsonArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/** A case's `expect`, or its `expectPerTrial`: one per trial in send order. */
export type Expectation = JsonObject | readonly JsonObject[];

/** `expectPerTrial` when the case gives one, else `expect`. */
export function expectationOf(data: CaseData): Expectation {
  const expectation = data.expectPerTrial ?? data.expect;
  if (expectation === undefined) {
    throw new Error(`the case ${data.name} gives neither expect nor expectPerTrial`);
  }
  return expectation;
}

function eachExpect(expect: Expectation): readonly JsonObject[] {
  return isExpectList(expect) ? expect : [expect];
}

function isExpectList(expect: Expectation): expect is readonly JsonObject[] {
  return Array.isArray(expect);
}

/**
 * Mismatches between `expect` and what the adapter and the mock server did. Every trial's
 * response is held to `expect`, or with a list (`expectPerTrial`) to the entry of its place in
 * send order, so one mismatch in any trial fails the case.
 */
export function checkExpect(expect: Expectation, outcome: Outcome): string[] {
  const { responses } = outcome;
  const expected = isExpectList(expect) ? expect : responses.map(() => expect);
  if (expected.length !== responses.length) {
    return [`${String(expected.length)} expectations for ${String(responses.length)} trials`];
  }
  return responses.flatMap((response, index) => {
    const prefix = responses.length > 1 ? `trial ${String(index + 1)}: ` : '';
    const wanted = expected[index] ?? {};
    return checkResponse(wanted, { ...outcome, response }).map((mismatch) => prefix + mismatch);
  });
}

function checkResponse(expect: JsonObject, outcome: Outcome): string[] {
  const mismatches: string[] = [];
  const { response } = outcome;
  const result = response.kind === 'result' && isJsonObject(response.result) ? response.result : {};
  const modelError = isJsonObject(result.error) ? result.error : {};
  for (const [name, value] of Object.entries(expect)) {
    switch (name) {
      case 'status':
        compare(name, value, statusOf(response), mismatches);
        break;
      case 'errorKind':
        compare(name, value, modelError.kind, mismatches);
        break;
      case 'retryAfterMs':
        compare(name, value, modelError.retryAfterMs, mismatches);
        break;
      case 'fingerprint':
        checkFingerprint(value, result.fingerprint, outcome.renderFingerprint, mismatches);
        break;
      case 'adapterError':
        compareMessages(
          name,
          [value],
          response.kind === 'error' ? [response.error.message] : [],
          mismatches,
        );
        break;
      case 'warnings':
        compareMessages(name, value, stringList(result.warnings), mismatches);
        break;
      case 'calls':
        if (value === null) {
          compare(name, null, resultField(response, 'calls'), mismatches);
        } else {
          compareRecords(name, value, resultField(response, 'calls') ?? [], mismatches);
        }
        break;
      case 'render':
        for (const [key, wanted] of Object.entries(isJsonObject(value) ? value : {})) {
          compare(`render.${key}`, wanted, result[key], mismatches);
        }
        break;
      case 'notifications':
        checkNotifications(value, outcome.exchange, mismatches);
        break;
      case 'log': {
        const warnings = outcome.exchange.logs
          .filter((log) => log.level === 'warn')
          .map((log) => log.message);
        compareMessages(name, value, warnings, mismatches);
        break;
      }
      case 'stderrIncludes': {
        const stderr = outcome.exchange.stderr.join('');
        for (const text of stringList(value)) {
          if (!stderr.includes(text)) {
            mismatches.push(`stderr lacks ${JSON.stringify(text)}`);
          }
        }
        break;
      }
      case 'requests':
        // Request records always carry their fields, so null there is the JSON null.
        compareRecords(name, value, jsonValueSchema.parse(outcome.requests), mismatches, false);
        break;
      default:
        compare(name, value, resultField(response, name), mismatches);
    }
  }
  return mismatches;
}

function checkNotifications(expected: JsonValue, exchange: Exchange, mismatches: string[]): void {
  const wanted = isJsonArray(expected) ? expected : [];
  if (wanted.length !== exchange.calls.length) {
    mismatches.push(
      `notifications: expected ${String(wanted.length)}, got ${JSON.stringify(exchange.calls)}`,
    );
    return;
  }
  wanted.forEach((notification, index) => {
    const calls = isJsonObject(notification) ? (notification.calls ?? []) : [];
    const sent = jsonValueSchema.parse(exchange.calls[index]?.calls ?? []);
    compareRecords(`notifications[${String(index)}].calls`, calls, sent, mismatches);
  });
}

function checkFingerprint(
  expected: JsonValue,
  actual: JsonValue | undefined,
  renderFingerprint: string | undefined,
  mismatches: string[],
): void {
  if ((expected === 'render' || expected === 'not-render') && renderFingerprint === undefined) {
    mismatches.push('fingerprint: the render gave no fingerprint to compare with');
  } else if (expected === 'render') {
    compare('fingerprint', renderFingerprint ?? null, actual, mismatches);
  } else if (expected === 'not-render') {
    if (actual === undefined || actual === renderFingerprint) {
      mismatches.push(`fingerprint: expected a value other than ${String(renderFingerprint)}`);
    }
  } else {
    compare('fingerprint', expected, actual, mismatches);
  }
}
