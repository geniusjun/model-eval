// An adapter whose targets each have a render function that fails one way, for the render
// function rules of helper-api §Render Mode (S-RV-22, S-RV-23): one that throws, synchronous and
// asynchronous, one that throws a cancel, and ones that return a value that is not a render
// result. `smallest` returns the smallest render result: one message, an empty `tools` list and
// `maxOutputTokens` 1, and `none-as-absent` gives `tools` and `maxOutputTokens` as null, which
// count as not given. No target function calls a model. Python's `max-output-tokens-huge`
// (10**400, an integer) has no Node form: a JavaScript number that large is `Infinity`.

import { helperExport } from './support.mjs';

/** The exception the throwing render functions throw. */
class RenderError extends Error {}

/** An object of a class JSON cannot carry, as Python's `object()`. */
function lookup() {
  return new Map([['name', 'lookup']]);
}

const { AbortController } = globalThis;
const HELLO = { role: 'user', content: 'Hello.' };

function returning(value) {
  return () => value;
}

const RENDER_FUNCTIONS = {
  'raises-sync': () => {
    throw new RenderError('no template for this case');
  },
  'raises-async': async () => {
    throw new RenderError('no template for this case');
  },
  // A cancel, as an aborted signal gives it: the `AbortError` `DOMException`.
  'cancels-async': async () => {
    const controller = new AbortController();
    controller.abort();
    throw controller.signal.reason;
  },
  // A render function with a missing `return`.
  'returns-none': () => undefined,
  // TypeScript only: an explicit `null`.
  'returns-null': returning(null),
  'returns-string': returning('Hello.'),
  'returns-list': returning([{ role: 'user', content: 'Hello.' }]),
  'no-messages': returning({ tools: [] }),
  'messages-string': returning({ messages: 'Hello.' }),
  'messages-string-element': returning({ messages: ['Hello.'] }),
  'empty-messages': returning({ messages: [] }),
  'message-without-role': returning({ messages: [{ content: 'Hello.' }] }),
  'tools-dict': returning({ messages: [HELLO], tools: { name: 'lookup' } }),
  'max-output-tokens-0': returning({ messages: [HELLO], maxOutputTokens: 0 }),
  'max-output-tokens-string': returning({ messages: [HELLO], maxOutputTokens: '100' }),
  'tools-object': returning({ messages: [HELLO], tools: [lookup()] }),
  'tools-nan': returning({ messages: [HELLO], tools: [{ name: 'lookup', x: NaN }] }),
  'part-object': returning({
    messages: [{ role: 'user', content: [{ type: 'input_image', image_url: lookup() }] }],
  }),
  smallest: returning({ messages: [HELLO], tools: [], maxOutputTokens: 1 }),
  'none-as-absent': returning({ messages: [HELLO], tools: null, maxOutputTokens: null }),
};

const targets = Object.fromEntries(
  Object.entries(RENDER_FUNCTIONS).map(([name, render]) => [
    name,
    {
      languages: ['en'],
      render,
      async generate() {
        return 'Hello.';
      },
    },
  ]),
);

helperExport('defineAdapter')({ name: 'render-failures', version: '0.0.1', targets }).listen();
