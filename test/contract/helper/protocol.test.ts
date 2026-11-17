import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { startAdapter } from '../../../src/adapter/client.js';
import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../../src/adapter/json-value.js';
import { PROTOCOL_VERSION } from '../../../src/adapter/protocol.js';
import { BUNDLED_HELPER_VERSION } from '../../../src/lint/helper-version.js';
import { NODE_SERVICES } from './support/driver.js';
import type { Api, CaseData, ScenarioCase } from './support/scenarios.js';
import {
  answerOf,
  generateParams,
  inlineCase,
  nodeApis,
  serviceEnv,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// Protocol v1 through the TypeScript helper: `defineAdapter({...}).listen()` with camelCase
// options, `initialize`, concurrent `generate`, the target function's arguments
// `generate(c, variant, calls)` and `shutdown` (helper-api §TypeScript, §Adapter Options, §Target
// Options, §Target Function; 001 adapter-protocol §Transport, §`initialize`, §`shutdown`).

const server = useMockApi();
const INPUT_SCHEMA = {
  type: 'object',
  required: ['user'],
  properties: { user: { type: 'string' } },
};
const APIS = nodeApis();

function replyCase(data: Partial<CaseData> = {}, api?: Api): ScenarioCase {
  return inlineCase({ service: { behaviour: 'reply' }, ...data }, api);
}

function stepsCase(steps: JsonObject[], data: Partial<CaseData> = {}, api?: Api): ScenarioCase {
  return inlineCase({ service: { behaviour: 'steps', params: { steps } }, ...data }, api);
}

async function initialized(scenarioCase: ScenarioCase, service?: string): Promise<JsonObject> {
  return withService(scenarioCase, server(), (_driver, result) => Promise.resolve(result), {
    ...(service === undefined ? {} : { service }),
  });
}

/** The JSON a `report` step returned as the shipped text. */
function reported(result: JsonObject): JsonValue {
  if (typeof result.final !== 'string') {
    throw new Error(`the report is not text: ${JSON.stringify(result.final)}`);
  }
  return JSON.parse(result.final) as JsonValue;
}

function objects(value: JsonValue): JsonObject[] {
  return isJsonArray(value) ? value.filter((item) => isJsonObject(item)) : [];
}

describe('003 protocol v1 through the TypeScript helper (helper-api §TypeScript)', () => {
  it(
    '003 FR-001 FR-004 initialize reports adapter, helper and protocol',
    async () => {
      const result = await initialized(
        replyCase({
          adapter: { maxConcurrency: 3 },
          target: { languages: ['ko', 'en', 'ja'], inputSchema: INPUT_SCHEMA },
        }),
      );
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result.adapter).toEqual({
        name: 'scenario-service',
        version: '0.0.1',
        helper: { language: 'typescript', version: BUNDLED_HELPER_VERSION },
      });
      expect(result.targets).toEqual([
        { name: 'chat', languages: ['ko', 'en', 'ja'], inputSchema: INPUT_SCHEMA },
      ]);
      const capabilities = isJsonObject(result.capabilities) ? result.capabilities : {};
      expect(capabilities.stages).toBe(true);
      expect(capabilities.cancel).toBe(true);
      expect(capabilities.maxConcurrency).toBe(3);
      // A capability left out is false, except postprocess, which is true (001 adapter-protocol).
      expect(capabilities.render ?? false).toBe(false);
      expect(capabilities.postprocess ?? true).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 initialize declares render and postprocess as set',
    async () => {
      const result = await initialized(replyCase({ target: { render: true, postprocess: false } }));
      expect(result.capabilities).toMatchObject({ render: true, postprocess: false });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 initialize without maxConcurrency sets no limit',
    async () => {
      const result = await initialized(replyCase());
      expect(result.capabilities).not.toHaveProperty('maxConcurrency');
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 S-RESP-15 capabilities hold when any target has them',
    async () => {
      // One target renders and has no post-processing, the other has neither; the render part
      // of S-RESP-15 is in render.test.ts.
      const result = await initialized(replyCase(), 'two_targets');
      expect(result.capabilities).toMatchObject({ render: true, postprocess: true });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 concurrent generate requests are matched by id',
    async () => {
      const scenarioCase = replyCase({
        script: [
          { match: { bodyIncludes: 'slow' }, delayMs: 1500, reply: { text: 'slow answer' } },
          { match: { bodyIncludes: 'fast' }, reply: { text: 'fast answer' } },
        ],
      });
      const { slow, fast, fastAfterMs } = await withService(
        scenarioCase,
        server(),
        async (driver) => {
          const sent = performance.now();
          const slowSent = driver.generate(
            generateParams(scenarioCase, { input: { user: 'slow' }, caseId: 'slow' }),
          );
          const fastSent = driver.generate(
            generateParams(scenarioCase, { input: { user: 'fast' }, caseId: 'fast' }),
          );
          const fastResult = answerOf(await fastSent.done);
          const fastAfter = performance.now() - sent;
          return { fast: fastResult, fastAfterMs: fastAfter, slow: answerOf(await slowSent.done) };
        },
      );
      expect(fast.raw).toBe('fast answer');
      expect(slow.raw).toBe('slow answer');
      // The fast trial is answered while the slow one still waits for its response headers.
      expect(fastAfterMs).toBeLessThan(1200);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 the target function receives the case and variant fields',
    async () => {
      const params = { lang: 'ja', input: { user: 'hi' }, caseId: 'greet-ja', repeat: 2, seed: 7 };
      const reports: Record<string, JsonValue> = {};
      for (const what of ['case', 'variant']) {
        const scenarioCase = stepsCase([{ call: {} }, { report: what }], {
          initialize: { variant: { id: 'next', model: 'model-b', params: { t: 1 } } },
          script: [{ reply: { text: 'Hello.' } }],
        });
        reports[what] = await withService(scenarioCase, server(), async (driver) =>
          reported(answerOf(await driver.generate(generateParams(scenarioCase, params)).done)),
        );
      }
      expect(reports.case).toEqual({
        id: 'greet-ja',
        lang: 'ja',
        input: { user: 'hi' },
        repeat: 2,
        seed: 7,
        rendering: false,
      });
      expect(reports.variant).toEqual({ id: 'next', model: 'model-b', params: { t: 1 } });
    },
    TIMEOUT_MS,
  );

  it.each(APIS)(
    '003 FR-001 the third argument holds the calls captured so far [%s]',
    async (api) => {
      const scenarioCase = stepsCase(
        [
          { call: { system: 'Be brief.', user: 'first' } },
          { call: { user: 'second' } },
          { report: 'calls' },
        ],
        {
          target: { replyCall: { systemIncludes: 'Be brief.' } },
          script: [
            { reply: { text: 'One.', finishReason: 'stop' } },
            { reply: { text: 'Two.', finishReason: 'stop' } },
          ],
        },
        api,
      );
      const calls = await withService(scenarioCase, server(), async (driver) =>
        objects(reported(answerOf(await driver.generate(generateParams(scenarioCase)).done))),
      );
      const finish = { 'chat-completions': 'stop', responses: 'completed', messages: 'end_turn' };
      expect(calls.map((call) => call.model)).toEqual(['model-b', 'model-b']);
      expect(calls[0]?.messages).toEqual([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'first' },
      ]);
      expect(calls[1]?.messages).toEqual([{ role: 'user', content: 'second' }]);
      expect(calls.map((call) => call.toolNames)).toEqual([[], []]);
      expect(calls.map((call) => call.text)).toEqual(['One.', 'Two.']);
      expect(calls.map((call) => call.finishReason)).toEqual([finish[api], finish[api]]);
      expect(calls.map((call) => call.outcome)).toEqual(['ok', 'ok']);
    },
    TIMEOUT_MS,
  );

  it.each(APIS)(
    '003 FR-001 the third argument gives failure, retry, usage and tool fields [%s]',
    async (api) => {
      const toolCalls = [{ name: 'lookup', arguments: '{"b": 1, "a": "x"}' }];
      if (api !== 'messages') {
        // Anthropic tool input is always a JSON object, so only OpenAI can send text that is not.
        toolCalls.push({ name: 'broken', arguments: '{not json' });
      }
      const lookup = { model: 'model-a', user: 'Look it up.', tools: ['lookup', 'broken'] };
      const rateLimit = { type: 'rate_limit_error', code: 'slow_down', message: 'slow down' };
      const scenarioCase = stepsCase(
        [
          { call: lookup, swallow: true },
          { call: lookup },
          { call: {} },
          { report: 'calls', toolArgs: ['lookup', 'missing', 'broken'] },
        ],
        {
          script: [
            { status: 429, headers: { 'retry-after-ms': '1500' }, error: rateLimit },
            {
              reply: { toolCalls, usage: { input: 12, cachedInput: 3, output: 6 } },
            },
            { reply: { text: 'Answer.' } },
          ],
        },
        api,
      );
      const [failed = {}, withTools = {}, answer = {}] = await withService(
        scenarioCase,
        server(),
        async (driver) =>
          objects(reported(answerOf(await driver.generate(generateParams(scenarioCase)).done))),
      );

      expect(failed.outcome).toBe('failed');
      expect(failed.error).toEqual({
        status: 429,
        type: 'rate_limit_error',
        code: 'slow_down',
        retryAfterMs: 1500,
      });
      // The same request was sent again in its branch after the failure ended.
      expect(failed.retried).toBe(true);
      expect(failed.usage ?? null).toBeNull();

      expect(withTools.error ?? null).toBeNull();
      expect(withTools.retried ?? null).toBeNull();
      expect(withTools.usage).toEqual({ input: 12, cachedInput: 3, output: 6 });
      const sentCalls = objects(withTools.toolCalls ?? []);
      const ids = sentCalls.map((call) => call.id);
      expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
      if (api === 'responses') {
        // A Responses tool call's ID is its `call_id`, not the output item's `id`.
        expect(ids.every((id) => typeof id === 'string' && id.startsWith('call_'))).toBe(true);
      }
      const withoutIds = sentCalls.map(({ id: _id, ...call }) => call);
      expect(withoutIds).toEqual(
        api === 'messages'
          ? // Anthropic `input` becomes canonical JSON text.
            [{ name: 'lookup', arguments: '{"a":"x","b":1}' }]
          : toolCalls,
      );
      const toolArgs = isJsonObject(withTools.toolArgs) ? withTools.toolArgs : {};
      expect(toolArgs.lookup).toEqual({ b: 1, a: 'x' });
      expect(toolArgs.missing ?? null).toBeNull();
      expect(toolArgs.broken ?? null).toBeNull();

      expect(answer.outcome).toBe('ok');
      expect(answer.error ?? null).toBeNull();
    },
    TIMEOUT_MS,
  );

  it.runIf(APIS.includes('responses'))(
    '003 FR-001 a Responses tool call id is its call_id read as text: 0 gives "0", an empty call_id the item id',
    async () => {
      // data-model §Finish Reasons, the call_id pairing: a call_id that is missing, null or empty
      // counts as not given and the item's id takes its place; any other non-string call_id is its
      // canonical JSON.
      const functionCall = (id: string, callId: JsonValue) => ({
        type: 'function_call',
        id,
        call_id: callId,
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
      });
      const body = {
        id: 'resp_call_ids',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'model-a',
        output: [functionCall('fc_zero', 0), functionCall('fc_empty', '')],
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      };
      const scenarioCase = stepsCase(
        [
          { call: { model: 'model-a', user: 'Look it up.', tools: ['lookup'] } },
          { call: {} },
          { report: 'calls' },
        ],
        { script: [{ body }, { reply: { text: 'Answer.' } }] },
        'responses',
      );
      const [withTools] = await withService(scenarioCase, server(), async (driver) =>
        objects(reported(answerOf(await driver.generate(generateParams(scenarioCase)).done))),
      );
      expect(objects(withTools?.toolCalls ?? []).map((call) => call.id)).toEqual(['0', 'fc_empty']);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 shutdown answers null and the process exits cleanly',
    async () => {
      const ended = await shutdownOf(replyCase({ script: [{ reply: { text: 'Hello.' } }] }));
      expect(ended).toMatchObject({ answered: true, exitCode: 0, forced: false });
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-001 the process exits after shutdown while a target function still runs',
    async () => {
      // shutdown waits for the function up to timeoutMs minus 5 s; after its response the process
      // must exit within the 5 s the tool gives (001 adapter-protocol §Transport), although a
      // timer of the target function is still pending.
      const ended = await shutdownOf(
        stepsCase([{ sleep: 20_000 }], { initialize: { timeoutMs: 6000 }, script: [] }),
        true,
      );
      expect(ended).toMatchObject({ answered: true, exitCode: 0, forced: false });
    },
    TIMEOUT_MS,
  );
});

/** Starts the scenario service through the tool's client, runs one trial and shuts it down. */
async function shutdownOf(scenarioCase: ScenarioCase, leaveRunning = false): Promise<object> {
  const mock = server();
  await mock.load(scenarioCase.data.script ?? []);
  const started = await startAdapter({
    launch: {
      command: [process.execPath, path.join(NODE_SERVICES, 'scenario.mjs')],
      cwd: NODE_SERVICES,
      env: { ...serviceEnv(scenarioCase, mock), MODEL_EVAL_SDK: String(scenarioCase.sdk) },
    },
    initialize: {
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: scenarioCase.data.initialize?.timeoutMs ?? 30_000,
      toolPaths: [],
    },
    concurrency: 1,
  });
  if (!started.ok) {
    throw new Error(`the scenario service did not start: ${started.error.message}`);
  }
  const trial = { target: 'chat', caseId: 'case-1', lang: 'en', input: {}, repeat: 0, seed: 1 };
  const generated = started.client.generate(trial);
  if (!leaveRunning) {
    await generated;
  }
  return started.client.shutdown();
}
