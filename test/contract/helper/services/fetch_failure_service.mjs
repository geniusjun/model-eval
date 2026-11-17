// An adapter whose one model request fails inside the global `fetch` as fetch_failure.mjs sets
// up: `service.params.call` is the request (`stream` for a streamed one). The fake `fetch` is in
// place before the helper is imported, so the helper wraps it as it wraps undici's.

import process from 'node:process';

import './fetch_failure.mjs';

import { defineAdapter } from 'model-eval/adapter';

import { ask, makeClient } from './one_call.mjs';

const spec = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}');

defineAdapter({
  name: 'fetch-failure-service',
  version: '0.0.1',
  targets: {
    chat: {
      languages: ['en'],
      async generate(c, variant) {
        const client = await makeClient();
        return ask(client, spec.api, { model: variant.model, ...spec.service?.params?.call });
      },
    },
  },
}).listen();
