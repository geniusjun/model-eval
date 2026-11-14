// A service that reads a raw response body (`.asResponse()`) which the server drops mid-body
// (S-CONN-22). It reports the exception it received, so that the SDK's resends and that exception
// can be compared with and without the helper:
//
//     MODEL_EVAL_WITHOUT_HELPER=1 node capture_streaming_drop.mjs   # prints the report as JSON
//     node capture_streaming_drop.mjs                                # an adapter with the helper
//
// With the helper the report is also printed, so it reaches stderr through the helper's stdout
// protection. `MODEL_EVAL_SCENARIO` gives the API as for the scenario service.

import process from 'node:process';

const WITHOUT_HELPER = process.env.MODEL_EVAL_WITHOUT_HELPER === '1';
// The helper before the SDK, and not at all without it.
const helper = WITHOUT_HELPER ? undefined : await import('model-eval/adapter');
const API = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}').api;
const MAX_RETRIES = 2;

function request(model) {
  const messages = [{ role: 'user', content: 'Say hello.' }];
  if (API === 'chat-completions') {
    return { model, messages };
  }
  if (API === 'responses') {
    return { model, input: messages };
  }
  return { model, messages, max_tokens: 64 };
}

/** `<exception class>: <message>` of what the service got, or `read <n> bytes`. */
async function report(model) {
  const sdk = await import(process.env.MODEL_EVAL_SDK ?? '');
  const client = new sdk.default({ maxRetries: MAX_RETRIES });
  const resource =
    API === 'chat-completions'
      ? client.chat.completions
      : API === 'responses'
        ? client.responses
        : client.messages;
  try {
    const response = await resource.create(request(model)).asResponse();
    const body = await response.arrayBuffer();
    return `read ${String(body.byteLength)} bytes`;
  } catch (error) {
    return `${String(error?.constructor?.name)}: ${String(error?.message)}`;
  }
}

if (helper === undefined) {
  globalThis.console.log(JSON.stringify({ report: await report('model-b') }));
} else {
  helper
    .defineAdapter({
      name: 'streaming-drop',
      version: '0.0.1',
      targets: {
        chat: {
          async generate(c, variant) {
            const text = await report(variant.model);
            globalThis.console.log(JSON.stringify({ report: text }));
            return text;
          },
        },
      },
    })
    .listen();
}
