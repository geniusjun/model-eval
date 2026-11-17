import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { type GenerateOutcome, startAdapter } from '../../../src/adapter/client.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../../src/adapter/json-value.js';
import { NODE_SERVICES } from './support/driver.js';
import type { ReceivedRequest } from './support/mock-api.js';
import {
  type CaseData,
  caseTitle,
  checkExpect,
  expectationOf,
  NODE_SDK_ALIASES,
  type NodeSdkAlias,
  nodeCases,
  nodeSdkAliases,
  runCase,
  type ScenarioCase,
} from './support/scenarios.js';
import {
  callRecords,
  generateParams,
  inlineCase,
  itRunsTheCases,
  nodeApis,
  resultOf,
  serviceEnv,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// Capture on the TypeScript helper (helper-api §Captured Requests, §Reading Response Bodies,
// Node): which requests are captured (the fixture rows of S-RESP-01, S-UNC-01, S-UNC-04,
// S-UNC-05 and S-UNC-07; S-UNC-04 is a client created before the helper import, run by
// services/capture_preload.mjs); a client created before the adapter module imports the helper,
// captured with `node --import model-eval/adapter`; two copies of one SDK; and the response the helper hands the SDK: a body
// stream that reads the original only as the SDK reads (highWaterMark 0), passes cancellation
// and the request `signal` on, keeps status, headers and `url`, and has no body for 204, 205 and
// 304; the Node part of S-PAR-07, compressed responses as `fetch` advertises and decodes them;
// the Node part of S-CONN-22, an `.asResponse()` body dropped mid-body, whose SDK resends and
// exception equal those without the helper. User Story 3 acceptance scenarios 1 and 2.

const server = useMockApi();
const APIS = nodeApis();

/** Starts a service through the tool's client, with extra Node options, and runs one trial. */
async function trialThroughClient(
  scenarioCase: ScenarioCase,
  service: string,
  nodeOptions: readonly string[],
): Promise<GenerateOutcome> {
  const mock = server();
  await mock.load(scenarioCase.data.script ?? []);
  const started = await startAdapter({
    launch: {
      command: [process.execPath, ...nodeOptions, path.join(NODE_SERVICES, `${service}.mjs`)],
      cwd: NODE_SERVICES,
      env: { ...serviceEnv(scenarioCase, mock), MODEL_EVAL_SDK: String(scenarioCase.sdk) },
    },
    initialize: {
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: 30_000,
      toolPaths: [],
    },
    concurrency: 1,
  });
  if (!started.ok) {
    throw new Error(`${service} did not start: ${started.error.message}`);
  }
  try {
    return await started.client.generate({
      target: 'chat',
      caseId: 'case-1',
      lang: 'en',
      input: {},
      repeat: 0,
      seed: 1,
    });
  } finally {
    await started.client.shutdown();
  }
}

/** The other installed alias of the same SDK, for a service with two copies of it. */
function secondCopy(sdk: NodeSdkAlias): NodeSdkAlias {
  const provider = sdk.startsWith('anthropic') ? 'anthropic' : 'openai';
  const other = NODE_SDK_ALIASES.find((alias) => alias !== sdk && alias.startsWith(provider));
  if (other === undefined) {
    throw new Error(`no second copy of ${sdk}`);
  }
  return other;
}

/** What capture_body.mjs observed, from its stderr line `{"bodyReport": …}`. */
async function bodyReport(check: string): Promise<JsonObject> {
  const scenarioCase = inlineCase(
    { service: { behaviour: 'capture-body', params: { check } }, script: [] },
    'chat-completions',
  );
  const stderr = await withService(
    scenarioCase,
    server(),
    async (driver) => {
      await driver.generate(generateParams(scenarioCase)).done;
      return driver.stderr();
    },
    { service: 'capture_body' },
  );
  const line = stderr.split('\n').find((text) => text.startsWith('{"bodyReport"'));
  if (line === undefined) {
    throw new Error(`capture_body.mjs wrote no report:\n${stderr}`);
  }
  const parsed = JSON.parse(line) as JsonValue;
  const report = isJsonObject(parsed) ? parsed.bodyReport : undefined;
  if (report === undefined || !isJsonObject(report)) {
    throw new Error(`not a report: ${line}`);
  }
  return report;
}

/** Content codings an accept-encoding header names, leaving out those with q=0. */
function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const item of (header ?? '').split(',')) {
    const [name = '', ...params] = item.split(';').map((part) => part.trim());
    const quality = params.find((param) => param.toLowerCase().startsWith('q='))?.slice(2) ?? '1';
    if (name !== '' && Number(quality) > 0) {
      accepted.add(name.toLowerCase());
    }
  }
  return accepted;
}

function caseEncoding(data: CaseData): string | undefined {
  const entry = (data.script ?? []).find((item) => isJsonObject(item) && 'encoding' in item);
  return isJsonObject(entry) && typeof entry.encoding === 'string' ? entry.encoding : undefined;
}

/**
 * Requests not served in the case's encoding although their accept-encoding names it, or served
 * compressed although it does not.
 */
function wronglyServed(data: CaseData, requests: readonly ReceivedRequest[]): string[] {
  const encoding = caseEncoding(data);
  return requests.flatMap((request) => {
    const accepted = acceptedEncodings(request.headers['accept-encoding']);
    const wanted = encoding !== undefined && accepted.has(encoding) ? encoding : 'identity';
    return request.servedEncoding === wanted
      ? []
      : [`${request.path}: served ${String(request.servedEncoding)}, not ${wanted}`];
  });
}

/** Behaviours run by a service of their own. */
const SERVICE_OF = { 'client-before-helper': 'capture_preload' };
const runFile = promisify(execFile);
/** S-PAR-07, Node part: compressed responses as `fetch` advertises and decodes them. */
const S_PAR_07 = nodeCases('capture.json').filter(({ scenario }) => scenario === 'S-PAR-07');
/** S-CONN-22, Node part: an `.asResponse()` body dropped mid-body, with and without the helper. */
const S_CONN_22 = nodeCases('capture.json').filter(({ scenario }) => scenario === 'S-CONN-22');
const DROP_SERVICE = path.join(NODE_SERVICES, 'capture_streaming_drop.mjs');

/** The `{"report": …}` line a capture_streaming_drop.mjs run wrote. */
function dropReport(output: string): string {
  const line = output.split('\n').find((text) => text.startsWith('{"report"'));
  const parsed = line === undefined ? undefined : (JSON.parse(line) as JsonValue);
  if (!isJsonObject(parsed) || typeof parsed.report !== 'string') {
    throw new Error(`capture_streaming_drop.mjs wrote no report:\n${output}`);
  }
  return parsed.report;
}

/** What the service received and how many requests its SDK sent, without the helper. */
async function dropWithoutHelper(scenarioCase: ScenarioCase): Promise<[string, number]> {
  const mock = server();
  await mock.load(scenarioCase.data.script ?? []);
  const env = {
    ...serviceEnv(scenarioCase, mock),
    MODEL_EVAL_SDK: String(scenarioCase.sdk),
    MODEL_EVAL_WITHOUT_HELPER: '1',
  };
  const { stdout } = await runFile(process.execPath, [DROP_SERVICE], { cwd: NODE_SERVICES, env });
  return [dropReport(stdout), (await mock.log()).length];
}

describe('003 capture on the TypeScript helper (helper-api §Captured Requests)', () => {
  itRunsTheCases('capture.json', '003 FR-005 FR-012 SC-005', server, {
    include: ({ scenario }) => scenario !== 'S-PAR-07' && scenario !== 'S-CONN-22',
    serviceOf: SERVICE_OF,
  });

  it.each(S_PAR_07.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    '003 FR-005 FR-024 %s: served as fetch advertised and decoded',
    async (_title, scenarioCase) => {
      const outcome = await runCase(scenarioCase, server());
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
      expect(wronglyServed(scenarioCase.data, outcome.requests)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each(S_CONN_22.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    "003 FR-005 %s: the SDK's resends and the service's exception equal those without the helper",
    async (_title, scenarioCase) => {
      const outcome = await runCase(scenarioCase, server(), 'capture_streaming_drop');
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
      const withHelper = [dropReport(outcome.exchange.stderr.join('')), outcome.requests.length];
      expect(withHelper).toEqual(await dropWithoutHelper(scenarioCase));
    },
    TIMEOUT_MS,
  );

  it.each(APIS)(
    '003 FR-005 a client created after the helper import is captured (acceptance scenario 1) [%s]',
    async (api) => {
      const scenarioCase = inlineCase(
        {
          service: { behaviour: 'reply' },
          script: [{ reply: { text: 'Hello.', usage: { input: 5, output: 2 } } }],
        },
        api,
      );
      const result = await withService(scenarioCase, server(), async (driver) =>
        resultOf(await driver.generate(generateParams(scenarioCase)).done),
      );
      expect(result.raw).toBe('Hello.');
      expect(callRecords(result).map((call) => [call.model, call.outcome, call.usage])).toEqual([
        ['model-b', 'ok', { input: 5, output: 2 }],
      ]);
    },
    TIMEOUT_MS,
  );

  it.each(APIS)(
    '003 FR-005 node --import model-eval/adapter captures a client created before the adapter module imports the helper [%s]',
    async (api) => {
      const scenarioCase = inlineCase(
        { service: { behaviour: 'none' }, script: [{ reply: { text: 'Hello.' } }] },
        api,
      );
      const outcome = await trialThroughClient(scenarioCase, 'capture_preload', [
        '--import',
        'model-eval/adapter',
      ]);
      expect(outcome.kind).toBe('result');
      if (outcome.kind === 'result') {
        expect(outcome.value).toMatchObject({ raw: 'Hello.' });
        expect(outcome.value.calls?.map((call) => [call.model, call.outcome])).toEqual([
          ['model-b', 'ok'],
        ]);
      }
    },
    TIMEOUT_MS,
  );

  it.each(APIS)(
    '003 FR-005 requests of two copies of one SDK are both captured [%s]',
    async (api) => {
      const scenarioCase = inlineCase(
        {
          service: { behaviour: 'none' },
          script: [{ reply: { text: 'en' } }, { reply: { text: 'Hello.' } }],
        },
        api,
      );
      const sdk = scenarioCase.sdk ?? nodeSdkAliases()[0] ?? 'openai-7';
      const result = await withService(
        scenarioCase,
        server(),
        async (driver) => resultOf(await driver.generate(generateParams(scenarioCase)).done),
        { service: 'capture_two_copies', env: { MODEL_EVAL_SECOND_SDK: secondCopy(sdk) } },
      );
      expect(result.raw).toBe('Hello.');
      expect(callRecords(result).map((call) => [call.model, call.outcome])).toEqual([
        ['model-a', 'ok'],
        ['model-b', 'ok'],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-005 the body stream reads the original only as the service reads (highWaterMark 0)',
    async () => {
      expect(await bodyReport('read-ahead')).toEqual({ before: 0, afterOne: 1 });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-005 cancelling the body stream cancels the original body',
    async () => {
      expect(await bodyReport('cancel')).toEqual({ cancelReason: 'the service stopped' });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-005 the request signal reaches the original fetch',
    async () => {
      expect(await bodyReport('signal')).toEqual({ before: false, after: true });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-005 status, headers and url of the original are kept',
    async () => {
      const report = await bodyReport('kept');
      expect(report).toMatchObject({ status: 200, header: 'kept' });
      expect(report.url).toBe(report.expectedUrl);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-005 a 204, 205 or 304 response is handed on without a body',
    async () => {
      expect(await bodyReport('no-body')).toEqual({
        statuses: [
          { status: 204, bodyIsNull: true },
          { status: 205, bodyIsNull: true },
          { status: 304, bodyIsNull: true },
        ],
      });
    },
    TIMEOUT_MS,
  );
});
