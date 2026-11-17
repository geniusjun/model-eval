// A service that calls the global `fetch` itself on the fetch of capture_body_fetch.mjs and
// writes what it observed of the response the helper handed it to stderr, as one line
// `{"bodyReport": …}` (helper-api §Reading Response Bodies, Node). `service.params.check` names
// the observation:
//
// - `read-ahead`: pulls of the original body before any read and after reading one chunk;
// - `cancel`: the reason the original body was cancelled with after the service cancelled its own;
// - `signal`: whether aborting the service's signal aborted the signal the request carried;
// - `kept`: status, the `x-test` header and `url`;
// - `no-body`: for each of 204, 205 and 304, the status and whether the body is null.

import process from 'node:process';

import { seen } from './capture_body_fetch.mjs';

import { defineAdapter } from 'model-eval/adapter';

const spec = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}');
const URL_OF_API = `${(process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '')}/chat/completions`;

function send(model, options = {}) {
  return globalThis.fetch(URL_OF_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello.' }] }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function observe(check, model) {
  if (check === 'read-ahead') {
    const response = await send(model);
    const before = seen.pulls;
    const reader = response.body.getReader();
    await reader.read();
    const afterOne = seen.pulls;
    await reader.cancel('done');
    return { before, afterOne };
  }
  if (check === 'cancel') {
    const response = await send(model);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel('the service stopped');
    return { cancelReason: seen.cancelReason };
  }
  if (check === 'signal') {
    const controller = new globalThis.AbortController();
    const response = await send(model, { signal: controller.signal });
    const before = seen.signal?.aborted ?? null;
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    return { before, after: seen.signal?.aborted ?? null };
  }
  if (check === 'kept') {
    const response = await send(model);
    await response.text();
    return {
      status: response.status,
      header: response.headers.get('x-test'),
      url: response.url,
      expectedUrl: URL_OF_API,
    };
  }
  const statuses = [];
  for (const status of [204, 205, 304]) {
    const response = await send(model, { headers: { 'x-test-status': String(status) } });
    statuses.push({ status: response.status, bodyIsNull: response.body === null });
  }
  return { statuses };
}

defineAdapter({
  name: 'capture-body',
  version: '0.0.1',
  targets: {
    chat: {
      languages: ['en'],
      async generate(c, variant) {
        let report;
        try {
          report = await observe(spec.service?.params?.check, variant.model);
        } catch (error) {
          report = { error: `${error?.constructor?.name}: ${error?.message}` };
        }
        process.stderr.write(`${JSON.stringify({ bodyReport: report })}\n`);
        return 'Done.';
      },
    },
  },
}).listen();
