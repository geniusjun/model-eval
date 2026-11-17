// The global `fetch` the capture_body.mjs service runs on, set up before the helper wraps it. It
// answers every request itself, so the test sees what the helper hands on of a response it knows:
//
// - the status of the request's `x-test-status` header (200 when absent), the header
//   `x-test: kept`, and the request URL as `url`;
// - for a status with a body, a body stream with highWaterMark 0 of three chunks, which counts
//   how often it was pulled and remembers the reason it was cancelled with;
// - the request's `signal` is kept, so the service can see whether aborting its own signal
//   reaches the request.

import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';

export const seen = { pulls: 0, cancelReason: undefined, signal: undefined };

const encoder = new TextEncoder();
const CHUNKS = [
  '{"id":"chatcmpl-1","object":"chat.completion","created":0,"model":"model-b",',
  '"choices":[{"index":0,"message":{"role":"assistant","content":"Hello."},',
  '"finish_reason":"stop"}]}',
];

globalThis.fetch = async (input, init = {}) => {
  seen.signal = init.signal;
  const headers = new globalThis.Headers(init.headers);
  const status = Number(headers.get('x-test-status') ?? '200');
  let next = 0;
  const body = [204, 205, 304].includes(status)
    ? null
    : new ReadableStream(
        {
          pull(controller) {
            seen.pulls += 1;
            const chunk = CHUNKS[next];
            next += 1;
            if (chunk === undefined) {
              controller.close();
            } else {
              controller.enqueue(encoder.encode(chunk));
            }
          },
          cancel(reason) {
            seen.cancelReason = String(reason);
          },
        },
        { highWaterMark: 0 },
      );
  const response = new globalThis.Response(body, {
    status,
    headers: { 'content-type': 'application/json', 'x-test': 'kept' },
  });
  Object.defineProperty(response, 'url', { value: String(input) });
  return response;
};
