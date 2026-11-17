// Parity driver: the TypeScript half of parity.test.ts, which runs the same trials through
// adapters/python/tests/services/parity.py and compares the values of spec FR-024 byte for byte
// (helper-scenarios §Two-Language Parity). Every target sends Chat Completions requests through
// the OpenAI SDK of `MODEL_EVAL_SDK` without retries; the trial's `c.input` carries the vector.
//
// - `reply`: one request; returns its text (S-PAR-01).
// - `discard`: one request, then throws an error of class `exceptionName` with `message`, which
//   `discardOn` takes (S-PAR-02).
// - `answer-tool`: one request with the tool `reply`, whose argument `text` is the answer
//   (`answerTool`); returns a fixed text (S-PAR-03 to S-PAR-06).
// - `retry`: one request, whose 429 response carries the vector's headers, read at the clock time
//   `nowMs` (S-PAR-09, S-PAR-10, S-PAR-12).
// - `throw-model-call-error`: throws `ModelCallError` with status 429 and `retryAfter` as its
//   `retryAfterMs`, the text `nan` standing for NaN (S-PAR-11).
//
// The clock the helper reads (`Date.now`) is the trial's `nowMs` while that trial runs.

import { defineAdapter, ModelCallError } from 'model-eval/adapter';

import { makeClient } from './one_call.mjs';

const USER = { role: 'user', content: 'Say hello.' };
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'reply',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
  },
];
const realNow = Date.now;
const clock = { nowMs: undefined };
Date.now = () => clock.nowMs ?? realNow();

async function ask(model, extra = {}) {
  const client = await makeClient();
  const response = await client.chat.completions.create({ model, messages: [USER], ...extra });
  return response.choices[0]?.message?.content ?? '';
}

function errorClass(name) {
  return { [name]: class extends Error {} }[name];
}

defineAdapter({
  name: 'parity',
  version: '0.0.1',
  targets: {
    reply: { languages: ['en'], generate: (c, variant) => ask(variant.model) },
    discard: {
      languages: ['en'],
      discardOn: () => true,
      async generate(c, variant) {
        await ask(variant.model);
        const ErrorClass = errorClass(String(c.input.exceptionName));
        throw new ErrorClass(c.input.message);
      },
    },
    'answer-tool': {
      languages: ['en'],
      answerTool: ['reply', 'text'],
      async generate(c, variant) {
        await ask(variant.model, { tools: TOOLS });
        return 'Shipped.';
      },
    },
    retry: {
      languages: ['en'],
      generate(c, variant) {
        clock.nowMs = Number(c.input.nowMs);
        return ask(variant.model);
      },
    },
    'throw-model-call-error': {
      languages: ['en'],
      generate(c) {
        const given = c.input.retryAfter;
        throw new ModelCallError({
          message: 'rate limited',
          status: 429,
          retryAfterMs: given === 'nan' ? Number.NaN : given,
          usage: { input: 0, output: 0 },
        });
      },
    },
  },
}).listen();
