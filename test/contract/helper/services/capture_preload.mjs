// A service that creates its SDK client before it imports the helper: as the adapter file of a
// service whose modules load first. Run as is, the client keeps the `fetch` it found and no
// request is captured (S-UNC-04); run with `node --import model-eval/adapter`, the helper is in
// place before this module, so the request is captured. The target function sends one request
// with that client and returns its text.

import process from 'node:process';

import { ask, makeClient } from './one_call.mjs';

const API = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}').api;
const client = await makeClient();

const { defineAdapter } = await import('model-eval/adapter');

defineAdapter({
  name: 'capture-preload',
  version: '0.0.1',
  targets: {
    chat: {
      languages: ['en'],
      generate: (c, variant) => ask(client, API, { model: variant.model }),
    },
  },
}).listen();
