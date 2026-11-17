// A service that loads two copies of one SDK, the alias of `MODEL_EVAL_SDK` and the alias of
// `MODEL_EVAL_SECOND_SDK`, as a service whose dependencies bring their own copy does. The first
// copy sends a side call to `model-a`, the second the answer to the variant model.

import process from 'node:process';

import { defineAdapter } from 'model-eval/adapter';

import { ask, makeClient } from './one_call.mjs';

const API = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}').api;

defineAdapter({
  name: 'capture-two-copies',
  version: '0.0.1',
  targets: {
    chat: {
      languages: ['en'],
      async generate(c, variant) {
        const first = await makeClient(process.env.MODEL_EVAL_SDK);
        const second = await makeClient(process.env.MODEL_EVAL_SECOND_SDK);
        await ask(first, API, { model: 'model-a', system: 'Detect the language.' });
        return ask(second, API, { model: variant.model });
      },
    },
  },
}).listen();
