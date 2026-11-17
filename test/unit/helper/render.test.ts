import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../../../src/adapter/json-types.js';
import { CapturedCall } from '../../../src/helper/capture.js';
import { Trial } from '../../../src/helper/context.js';
import { message } from '../../../src/helper/messages.js';
import type { Target } from '../../../src/helper/outcome.js';
import { renderDecision, renderFunctionDecision } from '../../../src/helper/render.js';

const TARGET: Target = {
  name: 'chat',
  generate: () => '',
  languages: undefined,
  inputSchema: true,
  render: true,
  discardOn: [],
  replyCall: undefined,
  answerTool: undefined,
  postprocess: true,
};

function renderOf(api: 'chat-completions' | 'responses', body: JsonObject) {
  const trial = new Trial(
    1,
    TARGET,
    { id: 'c', lang: 'en', input: {}, repeat: 0, seed: 0, rendering: true },
    { id: 'b', model: 'model-b', params: {} },
    120_000,
  );
  trial.calls.push(new CapturedCall(api, { model: 'model-b', ...body }, 0));
  return renderDecision(trial);
}

describe('render target request', () => {
  it('003 FR-021 S-RV-25 a request that cannot be rendered is A19', () => {
    const a19 = { kind: 'error', message: message('A19'), data: {} };
    expect(renderOf('responses', { input: [] })).toEqual(a19);
    expect(renderOf('chat-completions', { messages: [{ content: 'Hello.' }] })).toEqual(a19);
    expect(
      renderOf('chat-completions', {
        messages: [{ role: 'user', content: 'Hello.' }],
        tools: { name: 'lookup' },
      }),
    ).toEqual(a19);
    expect(renderOf('chat-completions', { messages: [{ role: null, content: 'Hello.' }] })).toEqual(
      a19,
    );
    expect(renderOf('responses', { input: [{ role: null, content: 'Hello.' }] })).toEqual(a19);
    expect(
      renderOf('responses', { input: [{ role: null, type: null, content: 'Hello.' }] }),
    ).toEqual(a19);
    expect(renderOf('responses', { input: [{ type: null, content: 'Hello.' }] })).toEqual(a19);
  });

  it('003 FR-022 a Responses item with a role and a null type is a message', () => {
    expect(
      renderOf('responses', { input: [{ role: 'user', type: null, content: 'Hello.' }] }),
    ).toMatchObject({
      kind: 'result',
      result: { messages: [{ role: 'user', content: 'Hello.' }] },
    });
  });

  it('003 FR-022 a Responses item with a null role but a type takes the type as role', () => {
    const item = { role: null, type: 'message', content: 'Hello.' };
    expect(renderOf('responses', { input: [item] })).toMatchObject({
      kind: 'result',
      result: {
        messages: [
          { role: 'message', content: '{"content":"Hello.","role":null,"type":"message"}' },
        ],
      },
    });
  });

  it('003 FR-021 the render result keeps tools and the first positive output limit', () => {
    const decided = renderOf('chat-completions', {
      messages: [{ role: 'user', content: 'Hello.' }],
      tools: [],
      max_tokens: 0,
      max_completion_tokens: 300,
    });
    expect(decided).toMatchObject({
      kind: 'result',
      result: { messages: [{ role: 'user', content: 'Hello.' }], tools: [], maxOutputTokens: 300 },
    });
  });
});

describe('render target request fields', () => {
  it('003 FR-022 a role that is not a string is its canonical JSON', () => {
    const decided = renderOf('chat-completions', {
      messages: [
        { role: 1.0, content: 'one' },
        { role: { a: 1 }, content: 'object' },
      ],
    });
    expect(decided).toMatchObject({
      kind: 'result',
      result: {
        messages: [
          { role: '1', content: 'one' },
          { role: '{"a":1}', content: 'object' },
        ],
      },
    });
  });

  it('003 FR-021 an output limit above 2^53-1 is not an integer', () => {
    const decided = renderOf('chat-completions', {
      messages: [{ role: 'user', content: 'Hello.' }],
      max_tokens: 2 ** 53,
    });
    expect(decided.kind).toBe('result');
    expect(decided.kind === 'result' ? decided.result : {}).not.toHaveProperty('maxOutputTokens');
  });
});

describe('render function', () => {
  const trial = new Trial(
    1,
    TARGET,
    { id: 'c', lang: 'en', input: {}, repeat: 0, seed: 0, rendering: true },
    { id: 'b', model: 'model-b', params: {} },
    120_000,
  );

  it('003 FR-021 S-RV-22 a cancellation is A17', () => {
    const thrown = new DOMException('This operation was aborted', 'AbortError');
    expect(renderFunctionDecision(trial, { thrown })).toEqual({
      kind: 'error',
      message: message('A17', { exception: 'DOMException: This operation was aborted' }),
      data: {},
    });
  });

  it('003 FR-021 an undefined object member is absent; an undefined list element is A18', () => {
    const hello = { role: 'user', content: 'Hello.', name: undefined };
    const tool = { type: 'function', function: { name: 'lookup', strict: undefined } };
    expect(
      renderFunctionDecision(trial, { value: { messages: [hello], tools: [tool] } }),
    ).toMatchObject({
      kind: 'result',
      result: {
        messages: [{ role: 'user', content: 'Hello.' }],
        tools: [{ type: 'function', function: { name: 'lookup' } }],
      },
    });
    expect(
      renderFunctionDecision(trial, { value: { messages: [hello], tools: [undefined] } }),
    ).toEqual({ kind: 'error', message: message('A18'), data: {} });
  });

  it('003 FR-021 a hole in a list is not JSON: A18', () => {
    const a18 = { kind: 'error', message: message('A18'), data: {} };
    const tool = { type: 'function', function: { name: 'lookup' } };
    // eslint-disable-next-line no-sparse-arrays
    const withHole = [, tool];
    expect(
      renderFunctionDecision(trial, {
        value: { messages: [{ role: 'user', content: 'Hello.' }], tools: withHole },
      }),
    ).toEqual(a18);
    // eslint-disable-next-line no-sparse-arrays
    const parts = [{ type: 'text', text: 'Hello.' }, , { type: 'text', text: 'Again.' }];
    expect(
      renderFunctionDecision(trial, { value: { messages: [{ role: 'user', content: parts }] } }),
    ).toEqual(a18);
    // eslint-disable-next-line no-sparse-arrays
    const nested = [{ type: 'function', function: { name: 'lookup', enum: ['a', , 'b'] } }];
    expect(
      renderFunctionDecision(trial, {
        value: { messages: [{ role: 'user', content: 'Hello.' }], tools: nested },
      }),
    ).toEqual(a18);
  });

  it('003 FR-021 S-RV-23 BigInt values are not JSON: A18', () => {
    const a18 = { kind: 'error', message: message('A18'), data: {} };
    const hello = { role: 'user', content: 'Hello.' };
    expect(
      renderFunctionDecision(trial, { value: { messages: [hello], maxOutputTokens: 1n } }),
    ).toEqual(a18);
    expect(
      renderFunctionDecision(trial, { value: { messages: [hello], tools: [{ n: 1n }] } }),
    ).toEqual(a18);
  });
});
