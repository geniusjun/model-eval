// An adapter whose render functions send model requests or wait (helper-api §Render Mode,
// S-RV-24). `MODEL_EVAL_API` names the API the requests go to.
//
// - `sends-sync` and `sends-async`: the render function sends one request to the variant model
//   and one to `model-a`, as a plain function that returns a promise or as an async function,
//   and returns a render result whose user message is the JSON of how each request ended, keys
//   sorted and no spaces.
// - `sleeps`: a render function that waits `SLEEP_MS` before returning; Node has no worker thread
//   for it, so it waits on a timer.
//
// Every target function sends one request to the variant model and returns its text, so a
// `generate` can run beside a render.

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { defineAdapter } from 'model-eval/adapter';

import { create, makeClient, requestBody, responseText } from './one_call.mjs';

const API = process.env.MODEL_EVAL_API;
const OTHER_MODEL = 'model-a';
const USER = 'Probe.';
const SLEEP_MS = 2000;
const HELLO = { role: 'user', content: 'Hello.' };

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the service sees of a failed request: status, error type and retry header. */
function errorNote(model, error) {
  const body = error?.error;
  const source = isObject(body?.error) ? body.error : body;
  return {
    model,
    shouldRetry: error?.headers?.get?.('x-should-retry') ?? null,
    status: error?.status ?? null,
    type: isObject(source) ? (source.type ?? null) : null,
  };
}

function report(notes) {
  return {
    messages: [
      { role: 'system', content: 'Report.' },
      { role: 'user', content: JSON.stringify(notes) },
    ],
  };
}

async function note(client, model) {
  try {
    await create(client, API, requestBody(API, { model, user: USER }));
    return { model, status: 200 };
  } catch (error) {
    return errorNote(model, error);
  }
}

function sendsSync(c, variant) {
  return makeClient()
    .then(async (client) => [await note(client, variant.model), await note(client, OTHER_MODEL)])
    .then(report);
}

async function sendsAsync(c, variant) {
  const client = await makeClient();
  return report([await note(client, variant.model), await note(client, OTHER_MODEL)]);
}

async function sleeps() {
  await sleep(SLEEP_MS);
  return { messages: [HELLO] };
}

async function answer(c, variant) {
  const client = await makeClient();
  return responseText(
    API,
    await create(client, API, requestBody(API, { model: variant.model, user: USER })),
  );
}

const RENDER_FUNCTIONS = { 'sends-sync': sendsSync, 'sends-async': sendsAsync, sleeps };

defineAdapter({
  name: 'render-requests',
  version: '0.0.1',
  maxConcurrency: 2,
  targets: Object.fromEntries(
    Object.entries(RENDER_FUNCTIONS).map(([name, render]) => [
      name,
      { languages: ['en'], render, generate: answer },
    ]),
  ),
}).listen();
