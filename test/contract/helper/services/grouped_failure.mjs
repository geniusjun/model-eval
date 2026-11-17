// Targets whose `ModelCallError` reaches the helper inside an `AggregateError`, as from
// `Promise.any` or a service that gathers its parallel failures: the aggregate is the service's
// own exception, not a reported failure (helper-api §`ModelCallError`). `discarded` lists
// `AggregateError` in `discardOn`; `raised` does not. Each target answers one model request
// first. `MODEL_EVAL_SCENARIO` gives the API.

import process from 'node:process';

import { defineAdapter, ModelCallError } from 'model-eval/adapter';

import { ask, makeClient } from './one_call.mjs';

const API = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}').api;

async function answerThenAggregate(model) {
  await ask(await makeClient(), API, { model });
  const failure = new ModelCallError({ message: 'The model call failed.', status: 429 });
  throw new AggregateError([failure], 'check failed');
}

defineAdapter({
  name: 'grouped-failure',
  version: '0.0.1',
  targets: {
    discarded: {
      languages: ['en'],
      discardOn: [AggregateError],
      generate: (c, variant) => answerThenAggregate(variant.model),
    },
    raised: {
      languages: ['en'],
      generate: (c, variant) => answerThenAggregate(variant.model),
    },
  },
}).listen();
