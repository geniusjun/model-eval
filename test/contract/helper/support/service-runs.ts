import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../../../src/adapter/json-value.js';
import { AdapterDriver, apiEnv, type RpcResponse } from './driver.js';
import { MockApi, ROOT } from './mock-api.js';
import {
  type Api,
  APIS,
  type CaseData,
  caseTitle,
  checkExpect,
  expectationOf,
  fillMessage,
  initializeParams,
  MOCK_URL_VARIABLE,
  type NodeSdkAlias,
  nodeCases,
  nodeSdkAliases,
  providerOf,
  runCase,
  type ScenarioCase,
  scenarioEnv,
  trialParams,
  withClosedPort,
} from './scenarios.js';

// Starting a Node service outside a fixture case, for tests that drive the protocol themselves
// (several requests, `cancel` at a chosen moment, a service of their own), and running the Node
// cases of a fixture file.

export const TIMEOUT_MS = 60_000;

/** One mock API server for the file's tests, started before them and stopped after them. */
export function useMockApi(): () => MockApi {
  let mock: MockApi | undefined;
  beforeAll(async () => {
    mock = await MockApi.start();
  });
  afterAll(async () => {
    await mock?.stop();
  });
  return () => {
    if (mock === undefined) {
      throw new Error('the mock API server did not start');
    }
    return mock;
  };
}

/** How a file's Node cases run: which ones, and the service of a behaviour that has its own. */
export interface RunOptions {
  readonly include?: (scenarioCase: ScenarioCase) => boolean;
  /** Behaviours run by a service of their own instead of scenario.mjs, as Python's tests map them. */
  readonly serviceOf?: Readonly<Record<string, string>>;
}

/** One test per Node case of the fixture file, each held to its `expect`. */
export function itRunsTheCases(
  fileName: string,
  title: string,
  server: () => MockApi,
  options: RunOptions = {},
): void {
  const cases = nodeCases(fileName).filter(options.include ?? (() => true));
  itRunsEach(title, cases, server, options.serviceOf);
}

/** The service that runs the case: the one its behaviour names in `serviceOf`, else scenario.mjs. */
export function serviceFor(
  scenarioCase: ScenarioCase,
  serviceOf: Readonly<Record<string, string>> = {},
): string {
  const behaviour = scenarioCase.data.service.behaviour;
  return (typeof behaviour === 'string' ? serviceOf[behaviour] : undefined) ?? 'scenario';
}

/**
 * Node cases for rows the fixture files hold only for Python, or not at all: each case for every
 * API it names (all when absent) and every SDK alias of `MODEL_EVAL_NODE_SDKS` that calls it,
 * limited to `sdks` when given.
 */
export function nodeCasesOf(scenario: string, cases: readonly CaseData[]): ScenarioCase[] {
  return cases.flatMap((data) =>
    (data.apis ?? APIS).flatMap((api) =>
      nodeSdkAliases()
        .filter((alias) => alias.startsWith(providerOf(api)))
        .filter((alias) => data.sdks?.includes(alias) ?? true)
        .map((sdk) => ({
          scenario,
          name: data.name,
          data: { ...data, languages: ['typescript' as const] },
          api,
          language: 'typescript' as const,
          sdk,
        })),
    ),
  );
}

/** One test per case, each held to its `expect`. */
export function itRunsEach(
  title: string,
  cases: readonly ScenarioCase[],
  server: () => MockApi,
  serviceOf?: Readonly<Record<string, string>>,
): void {
  it.each(cases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    `${title} %s`,
    async (_title, scenarioCase) => {
      const outcome = await runCase(scenarioCase, server(), serviceFor(scenarioCase, serviceOf));
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
    },
    TIMEOUT_MS,
  );
}

/** The first SDK alias of `MODEL_EVAL_NODE_SDKS` that calls the API. */
export function sdkFor(api: Api): NodeSdkAlias {
  const sdk = nodeSdkAliases().find((alias) => alias.startsWith(providerOf(api)));
  if (sdk === undefined) {
    throw new Error(`MODEL_EVAL_NODE_SDKS names no SDK for ${api}`);
  }
  return sdk;
}

/** The APIs some SDK alias of `MODEL_EVAL_NODE_SDKS` calls. */
export function nodeApis(): Api[] {
  const providers = new Set(nodeSdkAliases().map((alias) => alias.split('-')[0]));
  return APIS.filter((api) => providers.has(providerOf(api)));
}

/** A case that no fixture file holds, for one API and its first SDK alias. */
export function inlineCase(
  data: Partial<CaseData> & { readonly service: JsonObject },
  api: Api = nodeApis()[0] ?? 'chat-completions',
  sdk: NodeSdkAlias = sdkFor(api),
): ScenarioCase {
  return {
    scenario: 'S-INLINE-00',
    name: 'inline',
    data: { ...data, name: 'inline', expect: data.expect ?? {} },
    api,
    language: 'typescript',
    sdk,
  };
}

export interface StartOptions {
  /** A module of test/contract/helper/services/ or an absolute path; `scenario` by default. */
  readonly service?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/** The environment runCase gives a Node service: the mock server and the case as data. */
export function serviceEnv(
  scenarioCase: ScenarioCase,
  mock: MockApi,
  env: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...apiEnv(mock.url),
    ...scenarioEnv(scenarioCase),
    [MOCK_URL_VARIABLE]: mock.url,
    ...env,
  };
}

/**
 * A Node service for the case, with the case's script loaded and `{closedPort}` filled, not yet
 * initialised.
 */
export async function startService(
  givenCase: ScenarioCase,
  mock: MockApi,
  options: StartOptions = {},
): Promise<AdapterDriver> {
  const scenarioCase = { ...givenCase, data: await withClosedPort(givenCase.data) };
  await mock.load(scenarioCase.data.script ?? []);
  const sdk = scenarioCase.sdk ?? sdkFor(scenarioCase.api);
  return AdapterDriver.start({
    language: 'typescript',
    service: options.service ?? 'scenario',
    sdk,
    env: serviceEnv(scenarioCase, mock, options.env),
  });
}

/** Runs `use` on a started and initialised service, then shuts it down and waits for its exit. */
export async function withService<T>(
  scenarioCase: ScenarioCase,
  mock: MockApi,
  use: (driver: AdapterDriver, initialized: JsonObject) => Promise<T>,
  options: StartOptions = {},
): Promise<T> {
  const driver = await startService(scenarioCase, mock, options);
  try {
    const initialized = await driver.initialize(initializeParams(scenarioCase.data));
    if (initialized.kind === 'error') {
      throw new Error(`initialize failed: ${initialized.error.message}`);
    }
    const value = await use(driver, asObject(initialized.sent));
    await driver.shutdown();
    return value;
  } finally {
    await driver.close();
  }
}

/** The `generate` params of the case with these fields replaced. */
export function generateParams(scenarioCase: ScenarioCase, fields: JsonObject = {}): JsonObject {
  return { ...trialParams(scenarioCase.data), ...fields };
}

export function asObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined || !isJsonObject(value)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The result of a response that is not an adapter error. */
export function resultOf(response: RpcResponse<unknown>): JsonObject {
  if (response.kind === 'error') {
    throw new Error(`expected a result, got the adapter error ${response.error.message}`);
  }
  return asObject(response.sent);
}

/** The result of an answer: neither an adapter error nor a model failure. */
export function answerOf(response: RpcResponse<unknown>): JsonObject {
  const result = resultOf(response);
  if ('error' in result) {
    throw new Error(`expected an answer result, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** The `calls` of a result, or of an adapter error's data. */
export function callsOf(response: RpcResponse<unknown>): JsonObject[] {
  return callRecords(
    response.kind === 'error' ? asObject(response.error.data ?? {}) : asObject(response.sent),
  );
}

/** The `calls` a result or an adapter error's data holds. */
export function callRecords(holder: JsonObject): JsonObject[] {
  const calls = holder.calls ?? [];
  return isJsonArray(calls) ? calls.map((call) => asObject(call)) : [];
}

const messagesSchema = z.object({
  messages: z.record(z.string(), z.object({ text: z.string() })),
});
let messageTexts: Record<string, { text: string }> | undefined;

/** A message of test/fixtures/helper/messages.json with its placeholders filled. */
export function message(id: string, placeholders: Readonly<Record<string, string>> = {}): string {
  messageTexts ??= messagesSchema.parse(
    JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/helper/messages.json'), 'utf8')),
  ).messages;
  const text = messageTexts[id]?.text;
  if (text === undefined) {
    throw new Error(`messages.json has no message ${id}`);
  }
  return fillMessage(text, placeholders);
}

/** Whether the text is the message with its one placeholder filled by any value. */
export function isMessage(id: string, placeholder: string, text: string): boolean {
  const [before = '', after = ''] = message(id, { [placeholder]: '\u0000' }).split('\u0000');
  return (
    text.length > before.length + after.length && text.startsWith(before) && text.endsWith(after)
  );
}
