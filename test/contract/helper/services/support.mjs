// What the Node scenario services share: the helper's exports, the SDK of `MODEL_EVAL_SDK`, and
// the ways service code waits, gives up and leaves the trial context.
//
// Import this module before any SDK, so the helper (imported here first) wraps `fetch` before a
// client is created (helper-api §Captured Requests).

import * as helper from 'model-eval/adapter';

import { AsyncResource } from 'node:async_hooks';
import { writeSync } from 'node:fs';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const { AbortController, AbortSignal } = globalThis;

/** Exit code of an adapter that cannot set up what a case asks for. */
export const SETUP_ERROR_EXIT = 70;

/**
 * Ends the adapter at once with one line on stderr. An exception here would reach the helper's
 * outcome decision as the service's own and could match an expectation.
 */
export function setupError(message) {
  writeSync(2, `scenario service: ${message}\n`);
  process.exit(SETUP_ERROR_EXIT);
}

/** An export of `model-eval/adapter`, looked up when it is used; a missing one is a setup error. */
export function helperExport(name) {
  const value = helper[name];
  if (value === undefined) {
    setupError(`the helper has no export ${name}`);
  }
  return value;
}

// SDKs

/** The provider of each API, which is the SDK that serves it. */
const PROVIDER_OF_API = {
  'chat-completions': 'openai',
  responses: 'openai',
  messages: 'anthropic',
};
const SDK_ALIAS = process.env.MODEL_EVAL_SDK ?? '';
const SDK_PROVIDER = SDK_ALIAS.startsWith('anthropic') ? 'anthropic' : 'openai';

let sdkModule;

/** The SDK module, imported on first use, after the helper. */
export function loadSdk() {
  sdkModule ??= import(SDK_ALIAS);
  return sdkModule;
}

/** Whether the SDK module has been imported yet. */
export function sdkLoaded() {
  return sdkModule !== undefined;
}

/** Refuses an API the process's one SDK does not serve. */
export function requireApi(api) {
  if (PROVIDER_OF_API[api] !== SDK_PROVIDER) {
    setupError(`${api} needs the other provider's SDK; the process has ${SDK_ALIAS}`);
  }
  return api;
}

/** A new client of the SDK; it reads the base URL and key the harness set. */
export async function makeClient(options) {
  const module = await loadSdk();
  return new module.default(options);
}

/** The create method's owner for an API. */
export function resource(client, api) {
  if (api === 'chat-completions') {
    return client.chat.completions;
  }
  if (api === 'responses') {
    return client.responses;
  }
  return client.messages;
}

/**
 * The SDK's stream helper for the API (`client.chat.completions.stream()`,
 * `client.messages.stream()`, `client.responses.stream()`), which takes the body without `stream`.
 */
export function streamHelper(client, api, body, options) {
  const { stream: _stream, ...rest } = body;
  return resource(client, api).stream(rest, options);
}

/**
 * The event each stream helper emits for every stream event it adds: Chat Completions chunks,
 * Anthropic stream events, Responses events.
 */
export const HELPER_STREAM_EVENT = {
  'chat-completions': 'chunk',
  messages: 'streamEvent',
  responses: 'event',
};

/** Ends a stream the SDK returned, stream helper or plain `Stream`, without reading on. */
export function closeStream(stream) {
  if (typeof stream.abort === 'function') {
    stream.abort();
  } else {
    stream.controller.abort();
  }
}

/**
 * A `fetch` dispatcher whose connection never completes: each request fails after `ms` with the
 * error undici's connector raises when its connect time limit fires (`ConnectTimeoutError`,
 * `UND_ERR_CONNECT_TIMEOUT`), so `fetch` rejects with `TypeError: fetch failed` and that error as
 * its `cause`, and the request never reaches the server. A loopback server accepts a connection
 * at once, so a real connect time-out cannot be produced against the mock server.
 */
export function connectTimeoutDispatcher(ms) {
  return {
    dispatch(_options, handler) {
      setTimeout(() => {
        const error = new Error('Connect Timeout Error');
        error.name = 'ConnectTimeoutError';
        error.code = 'UND_ERR_CONNECT_TIMEOUT';
        handler.onError(error);
      }, ms);
      return true;
    },
  };
}

/**
 * A `fetch` dispatcher of Node's own undici with the body time limit `ms`: a body read that waits
 * longer than that for data fails with undici's `UND_ERR_BODY_TIMEOUT`, as a real read time-out
 * does. undici checks the limit on a coarse timer, so it fires up to about a second late. The
 * `Agent` class is the one of the global dispatcher, which undici sets when it loads (touching
 * `Headers` loads it); undici 8 keeps it under `undici.globalDispatcher.2` and a wrapper under
 * `.1`, earlier releases only under `.1`.
 */
export function bodyTimeoutDispatcher(ms) {
  void globalThis.Headers;
  const global =
    globalThis[Symbol.for('undici.globalDispatcher.2')] ??
    globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (global?.constructor?.name !== 'Agent') {
    setupError(`no undici Agent behind the global dispatcher of Node ${process.version}`);
  }
  return new global.constructor({ bodyTimeout: ms });
}

/** The base URL the harness gave the SDK of this API. */
export function baseUrl(api) {
  const name = api === 'messages' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL';
  return (process.env[name] ?? '').replace(/\/+$/, '');
}

// Waiting and giving up

/** Work cancelled from outside, as `asyncio` cancels a task: not a failure of the work itself. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/** Whether the signal was aborted to cancel the work it belongs to. */
export function cancelledBy(signal) {
  return signal?.aborted === true && signal.reason instanceof Cancelled;
}

/** Waits `ms`; an aborted signal ends the wait with its reason. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A promise that rejects with the signal's reason once it aborts. */
export function aborted(signal) {
  return new Promise((_, reject) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** The two signals as one; either may be absent. */
export function eitherSignal(first, second) {
  if (first === undefined) {
    return second;
  }
  return second === undefined ? first : AbortSignal.any([first, second]);
}

/**
 * Work started now that can be cancelled the way an `asyncio` task is: `cancel()` aborts the
 * signal the work receives with `Cancelled`.
 */
export function startTask(work, parent) {
  const controller = new AbortController();
  return {
    promise: work(eitherSignal(parent, controller.signal)),
    cancel() {
      controller.abort(new Cancelled());
    },
  };
}

/**
 * How a task ended: `{cancelled: true}` when its work gave up on `Cancelled`, else its value; any
 * other rejection goes on.
 */
export function outcomeOf(task) {
  return task.promise.then(
    (value) => ({ cancelled: false, value }),
    (error) => {
      if (error instanceof Cancelled) {
        return { cancelled: true };
      }
      throw error;
    },
  );
}

/** The first of the tasks to settle, whatever its outcome. */
export function firstSettled(tasks) {
  return Promise.race(tasks.map((task) => settled(task.promise).then(() => task)));
}

/** Waits for a promise to settle, whatever its outcome. */
export function settled(promise) {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

// The trial context

/**
 * Captures the async context of module load, before any trial. Work run in its scope carries no
 * trial context, as a Python thread started without `contextvars.copy_context()` does: the Node
 * form of a worker pool created at start-up.
 */
const OUTSIDE = new AsyncResource('model-eval-scenario-outside');

/** Runs the function outside every trial context and gives its promise. */
export function outsideTrial(work) {
  return OUTSIDE.runInAsyncScope(work);
}

// JSON

/** JSON text with keys sorted and no spaces, as Python's `sort_keys=True, separators=(",", ":")`. */
export function sortedJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
