// Replaces the global `fetch` with one that fails as `service.params.failure` of
// `MODEL_EVAL_SCENARIO` says, before the helper wraps it, so a test can give the helper a failure
// of undici or of Node's TLS layer that a local server cannot produce on demand:
//
//     {"code": "UND_ERR_SOCKET", "syscall": "read", "at": "request" | "body"}
//
// `at: "request"`: the `fetch` promise rejects as undici's does, a `TypeError` whose `cause` has
// the code. `at: "body"`: the response arrives with status 200 and part of its body, then the
// body fails with that error, as a dropped or timed-out read does. The request makes no
// connection.

import process from 'node:process';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';

const spec = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}');
const failure = spec.service?.params?.failure ?? {};

function cause() {
  const error = new Error(`${failure.code} from the test fetch`);
  error.code = failure.code;
  if (failure.syscall !== undefined) {
    error.syscall = failure.syscall;
  }
  return error;
}

/** The start of a response body of the API, cut before it ends. */
function partialBody(stream) {
  if (stream) {
    return 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"model-b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n';
  }
  return '{"id":"chatcmpl-1","object":"chat.completion","created":0,';
}

globalThis.fetch = async (input, init = {}) => {
  if (failure.at !== 'body') {
    throw new TypeError('fetch failed', { cause: cause() });
  }
  const stream = typeof init.body === 'string' && JSON.parse(init.body).stream === true;
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(partialBody(stream)));
    },
    pull(controller) {
      controller.error(new TypeError('terminated', { cause: cause() }));
    },
  });
  const response = new globalThis.Response(body, {
    status: 200,
    headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' },
  });
  Object.defineProperty(response, 'url', {
    value: String(input instanceof globalThis.Request ? input.url : input),
  });
  return response;
};
