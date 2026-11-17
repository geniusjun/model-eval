import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonObject } from '../../../src/adapter/json-value.js';
import { type RenderResult, renderResultSchema } from '../../../src/adapter/protocol.js';
import { renderFingerprint } from '../../../src/run/hashes.js';
import type { RpcResponse } from './support/driver.js';
import {
  type Api,
  type CaseData,
  caseTitle,
  checkExpect,
  expectationOf,
  nodeCases,
  runCase,
  type ScenarioCase,
} from './support/scenarios.js';
import {
  answerOf,
  inlineCase,
  itRunsEach,
  message,
  nodeApis,
  resultOf,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// Render mode and fingerprints of the TypeScript helper (helper-api §Render Mode; User Story 2;
// data-model §Derived Result Fields `fingerprint`): the target function runs with
// `c.rendering`, every captured request gets a non-retried HTTP 400 `render_only` so none reaches
// the mock server, and the render result is built from the render target request or from a
// render function normalised the same way; A11, A15, A17 and A18. Every render fingerprint, and
// the `generate` fingerprint of S-ANS-04, equals what the tool computes itself (renderFingerprint
// of src/run/hashes.ts) on the render's `messages` and `tools`.

const server = useMockApi();
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const RENDER_PARAMS = { lang: 'en', input: {}, caseId: 'greet-1', repeat: 0, seed: 7 };
const BLOCKED = { shouldRetry: null, status: 400, type: 'render_only' };

/** What the tool hashes when the adapter gives no fingerprint: `messages` and `tools`. */
function withoutFingerprint(render: RenderResult): RenderResult {
  return {
    messages: render.messages,
    ...(render.tools === undefined ? {} : { tools: render.tools }),
  };
}

function statusOk(data: CaseData): boolean {
  return data.expect?.status === 'ok';
}

const renderCases = nodeCases('render.json');
const renderingCases = renderCases.filter(
  ({ data }) => data.request === 'render' && statusOk(data),
);
const regenerationCases = nodeCases('fingerprint.json').filter(
  ({ scenario, data }) => scenario === 'S-ANS-04' && data.expect?.fingerprint === 'render',
);

/** The case's render result, from a `render` request. */
async function renderOf(scenarioCase: ScenarioCase): Promise<RenderResult> {
  const data: CaseData = { ...scenarioCase.data, request: 'render', expect: { status: 'ok' } };
  const outcome = await runCase({ ...scenarioCase, data }, server());
  return renderResultSchema.parse(resultOf(outcome.response));
}

/** A `render` of one target of a service of its own, with the variant model `model-b`. */
async function renderTarget(
  service: string,
  target: string,
  options: { api?: Api; variant?: JsonObject; env?: Record<string, string> } = {},
): Promise<{ response: RpcResponse<unknown>; requests: number }> {
  const scenarioCase = inlineCase(
    {
      service: { behaviour: 'none' },
      ...(options.variant === undefined ? {} : { initialize: { variant: options.variant } }),
    },
    options.api,
  );
  return withService(
    scenarioCase,
    server(),
    async (driver) => ({
      response: await driver.render({ ...RENDER_PARAMS, target }),
      requests: (await server().log()).length,
    }),
    { service, ...(options.env === undefined ? {} : { env: options.env }) },
  );
}

function adapterError(response: RpcResponse<unknown>): [number, string] | undefined {
  return response.kind === 'error' ? [response.error.code, response.error.message] : undefined;
}

/** S-RV-24 and the resend fingerprint run on each API the SDK aliases serve. */
const APIS = nodeApis();

describe('003 render mode of the TypeScript helper (helper-api §Render Mode)', () => {
  it.each(renderCases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    '003 FR-021 %s',
    async (_title, scenarioCase) => {
      const outcome = await runCase(scenarioCase, server());
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
      if (scenarioCase.data.request === 'render' && outcome.response.kind === 'result') {
        const result = outcome.response.result;
        if (isJsonObject(result) && !('error' in result)) {
          expect(result.fingerprint, 'a render result carries its fingerprint').toMatch(
            FINGERPRINT,
          );
        }
      }
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 render function gets case and variant and returns tools',
    async () => {
      // render_function.mjs echoes its arguments into the render result; its target function
      // calls no model, so the result can only come from the render function.
      const variant = { id: 'next', model: 'model-b', params: { tone: 'warm' } };
      const { response, requests } = await renderTarget('render_function', 'chat', { variant });
      const result = resultOf(response);
      const echoed = {
        case: { id: 'greet-1', input: {}, lang: 'en', repeat: 0, seed: 7 },
        variant: { id: 'next', model: 'model-b', params: { tone: 'warm' } },
      };
      expect(result.messages).toEqual([
        { role: 'system', content: 'Answer the user.' },
        { role: 'user', content: JSON.stringify(echoed) },
      ]);
      expect(result.tools).toEqual([
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
        },
      ]);
      expect(result.maxOutputTokens).toBe(32);
      expect(result.fingerprint).toMatch(FINGERPRINT);
      expect(requests).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-RESP-15 the target with render renders and the other is A15',
    async () => {
      const scenarioCase = inlineCase({ service: { behaviour: 'none' } });
      const { capabilities, rendered, refused } = await withService(
        scenarioCase,
        server(),
        async (driver, initialized) => ({
          capabilities: initialized.capabilities,
          rendered: resultOf(await driver.render({ ...RENDER_PARAMS, target: 'chat' })),
          refused: await driver.render({ ...RENDER_PARAMS, target: 'plain' }),
        }),
        { service: 'render_function' },
      );
      expect(capabilities).toMatchObject({ render: true, postprocess: true });
      expect(rendered.fingerprint).toMatch(FINGERPRINT);
      expect(refused.kind === 'error' ? refused.error.message : undefined).toBe(message('A15'));
      expect(await server().log()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  // `<exception>` per helper-api §Messages: `e.constructor.name` and `e.message` in TypeScript, so
  // the cancellation an aborted signal throws is `DOMException: This operation was aborted`, not
  // Python's `CancelledError`; it is no value of spec FR-024.
  it.each([
    ['raises-sync', 'RenderError: no template for this case'],
    ['raises-async', 'RenderError: no template for this case'],
    ['cancels-async', 'DOMException: This operation was aborted'],
  ])(
    '003 FR-021 S-RV-22 a render function that throws is A17 with <exception> from constructor.name and message (%s)',
    async (target, exception) => {
      const { response, requests } = await renderTarget('render_failures', target);
      const text = message('A17', { exception });
      expect(adapterError(response)).toEqual([-32000, text]);
      expect(requests).toBe(0);
    },
    TIMEOUT_MS,
  );

  it.each([
    'returns-none',
    'returns-null',
    'returns-string',
    'returns-list',
    'no-messages',
    'messages-string',
    'messages-string-element',
    'empty-messages',
    'message-without-role',
    'tools-dict',
    'max-output-tokens-0',
    'max-output-tokens-string',
    'tools-object',
    'tools-nan',
    'part-object',
  ])(
    '003 FR-021 S-RV-23 a render function that returns no render result is A18 (%s)',
    async (target) => {
      const { response, requests } = await renderTarget('render_failures', target);
      expect(adapterError(response)).toEqual([-32000, message('A18')]);
      expect(requests).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-RV-23 the smallest render result renders',
    async () => {
      const result = resultOf((await renderTarget('render_failures', 'smallest')).response);
      expect(result.messages).toEqual([{ role: 'user', content: 'Hello.' }]);
      expect(result.maxOutputTokens).toBe(1);
      expect(result.fingerprint).toMatch(FINGERPRINT);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-RV-23 tools and maxOutputTokens null count as not given',
    async () => {
      const result = resultOf((await renderTarget('render_failures', 'none-as-absent')).response);
      expect(result.messages).toEqual([{ role: 'user', content: 'Hello.' }]);
      expect(result).not.toHaveProperty('tools');
      expect(result).not.toHaveProperty('maxOutputTokens');
      expect(result.fingerprint).toMatch(FINGERPRINT);
    },
    TIMEOUT_MS,
  );

  it.each(
    APIS.flatMap((api) => ['sends-sync', 'sends-async'].map((target) => [api, target] as const)),
  )(
    '003 FR-021 S-RV-24 requests a render function sends get the render 400 [%s %s]',
    async (api, target) => {
      const { response, requests } = await renderTarget('render_requests', target, {
        api,
        env: { MODEL_EVAL_API: api },
      });
      const notes = [
        { model: 'model-b', ...BLOCKED },
        { model: 'model-a', ...BLOCKED },
      ];
      expect(resultOf(response).messages).toEqual([
        { role: 'system', content: 'Report.' },
        { role: 'user', content: JSON.stringify(notes) },
      ]);
      expect(requests).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-RV-24 a render function that waits does not hold up a generate',
    async () => {
      const api = APIS[0] ?? 'chat-completions';
      const scenarioCase = inlineCase(
        { service: { behaviour: 'none' }, script: [{ reply: { text: 'Hi.' } }] },
        api,
      );
      const params = { ...RENDER_PARAMS, target: 'sleeps' };
      const { generated, renderedFirst, rendered } = await withService(
        scenarioCase,
        server(),
        async (driver) => {
          let renderDone = false;
          const render = driver.render(params).then((response) => {
            renderDone = true;
            return response;
          });
          const generate = await driver.generate(params).done;
          const renderedFirst = renderDone;
          return { generated: answerOf(generate), renderedFirst, rendered: await render };
        },
        { service: 'render_requests', env: { MODEL_EVAL_API: api } },
      );
      expect(generated.raw).toBe('Hi.');
      expect(renderedFirst).toBe(false);
      expect(resultOf(rendered).messages).toEqual([{ role: 'user', content: 'Hello.' }]);
    },
    TIMEOUT_MS,
  );
});

describe('003 fingerprints of the TypeScript helper (data-model §Derived Result Fields)', () => {
  itRunsEach('003 FR-022', nodeCases('fingerprint.json'), server);

  it('003 FR-021 the render cases include renders with tools and without them', () => {
    const tools = renderingCases.map(({ data }) => {
      const render = data.expect?.render;
      return isJsonObject(render) ? render.tools : undefined;
    });
    expect(tools.some((value) => Array.isArray(value))).toBe(true);
    expect(tools.some((value) => value === undefined || value === null)).toBe(true);
  });

  it.each(renderingCases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    '003 FR-021 %s: the render fingerprint equals renderFingerprint of its messages and tools',
    async (_title, scenarioCase) => {
      const render = await renderOf(scenarioCase);
      expect(render.fingerprint).toBeDefined();
      expect(render.fingerprint).toBe(renderFingerprint(withoutFingerprint(render)));
    },
    TIMEOUT_MS,
  );

  it.each(
    regenerationCases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const),
  )(
    '003 FR-022 %s: the generate fingerprint equals renderFingerprint of the render',
    async (_title, scenarioCase) => {
      const render = await renderOf(scenarioCase);
      const outcome = await runCase(scenarioCase, server());
      expect(resultOf(outcome.response).fingerprint).toBe(
        renderFingerprint(withoutFingerprint(render)),
      );
    },
    TIMEOUT_MS,
  );

  /** The first request of render-mismatch cause 1, and what the mock server answers it with. */
  const FIRST_REQUESTS = {
    failed: [{ name: 'first', onError: 'swallow' }, { error: { status: 500 } }],
    'tool call only': [
      { name: 'first', tools: ['lookup'] },
      { reply: { toolCalls: [{ name: 'lookup', arguments: '{"text":"weather"}' }] } },
    ],
  } as const;
  const RESENT = { name: 'again', user: 'Say hello, briefly.' };

  function flowCase(steps: JsonObject[], api: Api, data: Partial<CaseData>): ScenarioCase {
    const service = { behaviour: 'flow', params: { steps, result: { callText: 'again' } } };
    return inlineCase({ service, ...data }, api);
  }

  it.each(
    APIS.flatMap((api) =>
      Object.keys(FIRST_REQUESTS).map(
        (first) => [api, first as keyof typeof FIRST_REQUESTS] as const,
      ),
    ),
  )(
    '003 FR-022 the fingerprint of a modified resend is its own render fingerprint [%s, first request %s]',
    async (api, first) => {
      // After a first request that failed or ended only in a tool call, the fingerprint is the
      // render fingerprint of a service whose only request is the modified one.
      const [firstCall, firstAnswer] = FIRST_REQUESTS[first];
      const trial = flowCase([{ call: { ...firstCall } }, { call: RESENT }], api, {
        target: { render: true, replyCall: true },
        script: [{ ...firstAnswer }, { reply: { text: 'Hello.' } }],
      });
      const alone = flowCase([{ call: RESENT }], api, {
        target: { render: true },
        request: 'render',
      });
      const generated = answerOf((await runCase(trial, server())).response);
      const rendered = answerOf((await runCase(alone, server())).response);
      expect(rendered.fingerprint).toMatch(FINGERPRINT);
      expect(generated.fingerprint).toBe(rendered.fingerprint);
    },
    TIMEOUT_MS,
  );
});
