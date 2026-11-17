// The `flow` behaviour: a service whose model calls, error handling, concurrency and return value
// are given as data in `service.params`, so one fixture row describes one service shape for every
// API. The Python scenario services read the same parameters (behaviours_flow.py); here they take
// their Node form.
//
//     {"steps": [step, ...], "result": result}
//
// Steps, run in order:
//
// - `{"call": call}`: one model request; see `prepare` and `clientOptions`.
// - `{"parallel": [call, ...], "wait": "all" | "first"}`: the requests sent together. `first`
//   takes the first that succeeds and cancels the rest.
// - `{"thread": call, "context": "copy" | "none", "join": bool}`: the request as separate work,
//   with the trial context or none (work run in the scope of an `AsyncResource` created at module
//   load, the Node form of a thread without the context); `join` waits for it (default true).
// - `{"executor": call}`: the request outside the trial context, waited for.
// - `{"background": call | {"raise": ...}, "delayMs": n}`: started and not awaited, so it runs on
//   after the function returned; `raise` makes that work reject, unhandled.
// - `{"afterCertificateError": call}`: a plain HTTPS GET of the API base URL with `node:https`
//   fails on the server's certificate, and the request is made while that error is handled.
// - `{"uncaptured": call}`, `{"child": call}`: the request sent with `node:http`, in this process
//   or from a child process, so the helper cannot capture it.
// - `{"http": {"method": m, "path": p, "json": body, "status": n, "name": label, "onError": e}}`:
//   one request through the global `fetch` to the API's base URL, its body read whole; `status`
//   makes a different status raise.
// - `{"notLoaded": [module, ...]}`: raises when the SDK of one of the named providers is already
//   imported, so the SDK the next call imports is imported inside the service function.
// - `{"sleepMs": n}`.
// - `{"raise": {"class": name, "message": text}}`.
//
// `result`, what the function ends with after the steps (default: the text of the last call that
// succeeded, or an empty text):
//
// - `{"text": text}`, `{"fallback": text}`: that text, or `fallback(text)`.
// - `{"callText": name}`, `{"fallbackCallText": name}`: the text a named call received.
// - `{"raise": {"class": name, "message": text}}`.
//
// A call's `connectTimeoutMs` is the time limit for connecting: its requests go through a
// dispatcher whose connection never completes, so `fetch` fails with undici's connect time-out
// after that long (support.mjs `connectTimeoutDispatcher`). `bodyTimeoutMs` is undici's time
// limit for the next piece of a response body, set on a dispatcher of Node's own undici
// (`bodyTimeoutDispatcher`), so a stalled body fails with `UND_ERR_BODY_TIMEOUT`; it fires up to
// about a second late. `connectTimeoutMs` wins when both are given. The Python `sharedClient` and
// `poolTimeoutMs` (a connection pool shared by the flow's calls and its wait time-out) have no
// form in the Node SDKs; a case that gives them ends the adapter with a setup error.

import {
  baseUrl,
  cancelledBy,
  bodyTimeoutDispatcher,
  closeStream,
  connectTimeoutDispatcher,
  helperExport,
  makeClient,
  outsideTrial,
  requireApi,
  resource,
  firstSettled,
  outcomeOf,
  sdkLoaded,
  setupError,
  sleep,
  startTask,
  streamHelper,
  aborted,
  eitherSignal,
} from './support.mjs';
import { answerText, post } from './uncaptured_post.mjs';

import { execFile } from 'node:child_process';
import https from 'node:https';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

/**
 * The service's own failure where the Python service raises `RuntimeError`, under the same class
 * name, so the `<exception>` text of helper-api §Messages (class name and message) is the same in
 * both languages.
 */
class RuntimeError extends Error {}

const DEFAULT_SYSTEM = 'You are a helpful assistant.';
const DEFAULT_USER = 'Say hello.';
const DEFAULT_MAX_TOKENS = 256;
const TOOL_RESULT = 'tool result';
const FOLLOW_UP = 'Check the answer.';
const TOOL_PARAMETERS = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const { AbortController } = globalThis;
const UNCAPTURED_POST = fileURLToPath(new URL('./uncaptured_post.mjs', import.meta.url));
const runFile = promisify(execFile);

/** The service's own time limit fired (`limitMs`, `waitMs`). */
export class ServiceTimeout extends Error {
  constructor(message = "the service's time limit fired") {
    super(message);
    this.name = 'ServiceTimeout';
  }
}

// Requests

/** The system, tool names and items of one conversation. */
export function conversationOf(system, tools = [], items = []) {
  return { system, tools, items };
}

/** What the service got from one call: its request, and its response, text or error. */
export function receivedOf(body, options, conversation) {
  return { body, options, conversation, response: null, text: '', error: undefined };
}

function toolDefinitions(api, names) {
  if (api === 'chat-completions') {
    return names.map((name) => ({
      type: 'function',
      function: { name, parameters: TOOL_PARAMETERS },
    }));
  }
  if (api === 'responses') {
    return names.map((name) => ({ type: 'function', name, parameters: TOOL_PARAMETERS }));
  }
  return names.map((name) => ({ name, input_schema: TOOL_PARAMETERS }));
}

function forcedTool(api, name) {
  if (api === 'chat-completions') {
    return { type: 'function', function: { name } };
  }
  if (api === 'responses') {
    return { type: 'function', name };
  }
  return { type: 'tool', name };
}

/**
 * The create method's body and request options. `kwargs` go into the body as they are, except the
 * Python SDK options `extra_body` (merged into the body) and `extra_headers` (request headers).
 */
export function requestBody(api, conversation, spec, model) {
  const body = { model };
  const options = {};
  if (api === 'chat-completions') {
    body.messages = [{ role: 'system', content: conversation.system }, ...conversation.items];
    if ('n' in spec) {
      body.n = spec.n;
    }
    if ('maxTokens' in spec) {
      body.max_tokens = spec.maxTokens;
    }
  } else if (api === 'responses') {
    body.instructions = conversation.system;
    body.input = [...conversation.items];
    if ('maxTokens' in spec) {
      body.max_output_tokens = spec.maxTokens;
    }
  } else {
    body.system = conversation.system;
    body.messages = [...conversation.items];
    body.max_tokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS;
  }
  if (conversation.tools.length > 0) {
    body.tools = toolDefinitions(api, conversation.tools);
  }
  if ('toolChoice' in spec) {
    body.tool_choice = forcedTool(api, spec.toolChoice);
  }
  if (spec.stream) {
    body.stream = true;
  }
  if ('headers' in spec) {
    options.headers = { ...spec.headers };
  }
  for (const [key, value] of Object.entries(spec.kwargs ?? {})) {
    if (key === 'extra_body') {
      Object.assign(body, value);
    } else if (key === 'extra_headers') {
      options.headers = { ...options.headers, ...value };
    } else {
      body[key] = value;
    }
  }
  return { body, options };
}

/** A response value without its null fields, as the Python SDK models dump with `exclude_none`. */
function dump(value) {
  if (Array.isArray(value)) {
    return value.map(dump);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, dump(item)]),
    );
  }
  return value;
}

export function responseText(api, response) {
  if (api === 'chat-completions') {
    return String(response.choices?.[0]?.message?.content ?? '');
  }
  if (api === 'responses') {
    return String(response.output_text ?? '');
  }
  return (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function toolCallIds(api, response) {
  if (api === 'chat-completions') {
    return (response.choices?.[0]?.message?.tool_calls ?? []).map((call) => call.id);
  }
  if (api === 'responses') {
    return (response.output ?? [])
      .filter((item) => item.type === 'function_call')
      .map((item) => item.call_id);
  }
  return (response.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => block.id);
}

/**
 * The conversation after an earlier call: a tool-loop step when it ended in tool calls, else its
 * text and a new user message (data-model §Call Branches).
 */
function continued(api, earlier, followUp) {
  const base = earlier.conversation;
  const conversation = conversationOf(base.system, [...base.tools], [...base.items]);
  const response = earlier.response;
  const ids = response === null || response === undefined ? [] : toolCallIds(api, response);
  if (ids.length === 0) {
    conversation.items.push({ role: 'assistant', content: earlier.text });
    conversation.items.push({ role: 'user', content: followUp });
    return conversation;
  }
  if (api === 'chat-completions') {
    conversation.items.push(dump(response.choices[0].message));
    for (const id of ids) {
      conversation.items.push({ role: 'tool', tool_call_id: id, content: TOOL_RESULT });
    }
  } else if (api === 'responses') {
    conversation.items.push(...response.output.map(dump));
    for (const id of ids) {
      conversation.items.push({ type: 'function_call_output', call_id: id, output: TOOL_RESULT });
    }
  } else {
    conversation.items.push({ role: 'assistant', content: response.content.map(dump) });
    conversation.items.push({
      role: 'user',
      content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: TOOL_RESULT })),
    });
  }
  return conversation;
}

/** The answer text of a JSON model response body, or the body itself for other responses. */
function httpText(api, body) {
  try {
    return answerText(api, JSON.parse(body));
  } catch {
    return body;
  }
}

/** The answer text one stream event carries. */
export function eventText(api, event) {
  if (api === 'chat-completions') {
    return String(event.choices?.[0]?.delta?.content ?? '');
  }
  if (api === 'responses') {
    return event.type === 'response.output_text.delta' ? String(event.delta) : '';
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return String(event.delta.text);
  }
  return '';
}

export const RESPONSES_END_EVENTS = [
  'response.completed',
  'response.incomplete',
  'response.failed',
];

// SDK clients

/**
 * `maxRetries`; `timeoutMs` for the SDK's time limit, `connectTimeoutMs` for connecting and
 * `bodyTimeoutMs` for each wait for body data;
 * `baseUrl` for a server other than the mock API server's.
 */
export function clientOptions(api, spec) {
  if ('poolTimeoutMs' in spec) {
    setupError('poolTimeoutMs (a connection-pool wait time-out) has no form in the Node SDKs');
  }
  const options = { maxRetries: Number(spec.maxRetries ?? 0) };
  if ('timeoutMs' in spec) {
    options.timeout = spec.timeoutMs;
  }
  if ('connectTimeoutMs' in spec) {
    options.fetchOptions = { dispatcher: connectTimeoutDispatcher(Number(spec.connectTimeoutMs)) };
  } else if ('bodyTimeoutMs' in spec) {
    options.fetchOptions = { dispatcher: bodyTimeoutDispatcher(Number(spec.bodyTimeoutMs)) };
  }
  if (spec.plainMock) {
    const plain = process.env.MODEL_EVAL_MOCK_URL ?? '';
    options.baseURL = api === 'messages' ? plain : `${plain}/v1`;
  } else if ('baseUrl' in spec) {
    options.baseURL = spec.baseUrl;
  } else if ('basePath' in spec) {
    options.baseURL = baseUrl(api) + spec.basePath;
  }
  return options;
}

/** Sends one request: (response or null, text read). */
export async function sendAsync(api, spec, body, options, client) {
  const create = resource(client, api);
  const mode = spec.streamingResponse;
  if (mode === 'all') {
    const { data } = await create.create(body, options).withResponse();
    if (!body.stream) {
      return [data, responseText(api, data)];
    }
    let text = '';
    for await (const event of data) {
      text += eventText(api, event);
    }
    return [null, text];
  }
  if (mode !== undefined) {
    // `.asResponse()` gives the response at its headers, its body unread.
    const response = await create.create(body, options).asResponse();
    if (mode === 'chunk' && response.body !== null) {
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
    } else {
      await response.body?.cancel();
    }
    return [null, ''];
  }
  if (spec.streamHelper) {
    return readAsync(api, spec, streamHelper(client, api, body, options));
  }
  const result = await create.create(body, options);
  if (!body.stream) {
    return [result, responseText(api, result)];
  }
  return readAsync(api, spec, result);
}

/**
 * What the service took from a stream: its text and, for Responses, the final response of the
 * end event, so a tool loop can continue from it.
 */
class Collected {
  constructor(api) {
    this.api = api;
    this.pieces = [];
    this.response = null;
  }

  add(event) {
    this.pieces.push(eventText(this.api, event));
    if (RESPONSES_END_EVENTS.includes(event.type)) {
      this.response = event.response;
    }
  }

  result() {
    return [this.response, this.pieces.join('')];
  }
}

/**
 * How much of a stream the service reads: `all` (default), `none` (left unread and open), `close`
 * (closed unread) or `{"events": n}` (`break` after n events); `closeAfterMs` has other work
 * close the stream while the read waits.
 */
async function readAsync(api, spec, stream) {
  const collected = new Collected(api);
  const read = spec.read ?? 'all';
  if (read === 'none') {
    return collected.result();
  }
  if (read === 'close') {
    closeStream(stream);
    return collected.result();
  }
  const limit = typeof read === 'object' ? read.events : undefined;
  const closing =
    'closeAfterMs' in spec ? setTimeout(() => closeStream(stream), spec.closeAfterMs) : undefined;
  try {
    let count = 0;
    for await (const event of stream) {
      collected.add(event);
      count += 1;
      if (limit !== undefined && count >= limit) {
        break;
      }
    }
  } finally {
    clearTimeout(closing);
  }
  return collected.result();
}

// Running a flow

/** One run of the `flow` behaviour inside a target function. */
export class Flow {
  constructor(run) {
    this.run = run;
    this.api = run.api;
    this.received = new Map();
    this.lastOk = undefined;
    if ('sharedClient' in run.params) {
      setupError('sharedClient (one connection pool for the flow) has no form in the Node SDKs');
    }
  }

  /** `{"class": name, "message": text}` as the scenario service's exception of that class. */
  exception(raise) {
    return this.run.exception(raise.class, raise.message ?? '');
  }

  userText() {
    return String((this.run.case.input ?? {}).user ?? DEFAULT_USER);
  }

  apiOf(spec) {
    return requireApi(spec.api ?? this.api);
  }

  /**
   * The body, options and conversation of one call. `name` labels it for later steps; `api`
   * sends it to another API than the case's; `model` defaults to the variant model; `system` and
   * `user` give the prompt, `userBytes` a user message of that many characters; `tools` names
   * function tools and `toolChoice` forces one; `n` and `maxTokens` are body fields; `kwargs` go
   * into the request (`requestBody`) and `headers` are request headers. `streamHelper` reads the
   * stream through the SDK's stream helper (`.stream()`), with the reads of `readAsync`. `after` continues the conversation of an earlier call; `same`
   * sends an earlier call's request again, with `stream` when given.
   */
  prepare(spec) {
    const api = this.apiOf(spec);
    const model = String(spec.model ?? this.run.variant.model);
    if ('same' in spec) {
      const earlier = this.received.get(spec.same);
      const body = { ...earlier.body, model };
      if ('stream' in spec) {
        delete body.stream;
        if (spec.stream) {
          body.stream = true;
        }
      }
      return { body, options: earlier.options, conversation: earlier.conversation };
    }
    let conversation;
    if ('after' in spec) {
      const followUp = String(spec.user ?? FOLLOW_UP);
      conversation = continued(api, this.received.get(spec.after), followUp);
    } else {
      conversation = conversationOf(String(spec.system ?? DEFAULT_SYSTEM), [...(spec.tools ?? [])]);
      let user = String(spec.user ?? this.userText());
      if ('userBytes' in spec) {
        user = 'x'.repeat(Number(spec.userBytes));
      }
      conversation.items.push({ role: 'user', content: user });
    }
    return { ...requestBody(api, conversation, spec, model), conversation };
  }

  record(spec, received) {
    if (spec.name !== undefined) {
      this.received.set(String(spec.name), received);
    }
    if (received.error === undefined) {
      this.lastOk = received;
    }
    return received;
  }

  /**
   * Applies `onError` to a call that raised: `raise` (default), `swallow`, or
   * `{"raise": {"class": name, "message": text}}` to raise the service's own exception instead.
   */
  finish(spec, received) {
    this.record(spec, received);
    const error = received.error;
    if (error === undefined) {
      return received;
    }
    const onError = spec.onError ?? 'raise';
    if (onError === 'swallow') {
      return received;
    }
    if (typeof onError === 'object' && 'raise' in onError) {
      throw this.exception(onError.raise);
    }
    throw error;
  }

  /** The SDK client of one call, built before the call starts. */
  clientFor(spec) {
    const api = this.apiOf(spec);
    return makeClient(clientOptions(api, spec));
  }

  /**
   * One request, waited for. `startAfterMs` waits before sending. `limitMs` is the service's own
   * time limit, which cancels the request; `waitMs` one that only stops waiting and leaves the
   * request running. A cancel of the signal (`Cancelled`) goes on as it is, as a cancelled
   * `asyncio` task's does; the call is then not recorded.
   */
  async callAwaited(spec, client, signal) {
    if ('startAfterMs' in spec) {
      await sleep(spec.startAfterMs, signal);
    }
    const { body, options, conversation } = this.prepare(spec);
    const received = receivedOf(body, options, conversation);
    const used = client ?? (await this.clientFor(spec));
    const api = this.apiOf(spec);
    try {
      [received.response, received.text] = await this.limited(
        spec,
        (inner) => this.sending(api, spec, body, withSignal(options, inner), used, inner),
        signal,
      );
    } catch (error) {
      if (cancelledBy(signal)) {
        throw signal.reason;
      }
      received.error = error;
    }
    return received;
  }

  sending(api, spec, body, options, client) {
    return sendAsync(api, spec, body, options, client);
  }

  /**
   * The service's own time limits: `limitMs` aborts the work (`asyncio.wait_for`), `waitMs` stops
   * waiting for it (`Promise.race`); either way the call ends with `ServiceTimeout`.
   */
  async limited(spec, send, signal) {
    if ('limitMs' in spec) {
      const controller = new AbortController();
      const inner = eitherSignal(signal, controller.signal);
      const timer = setTimeout(() => controller.abort(new ServiceTimeout()), spec.limitMs);
      try {
        const value = await send(inner);
        throwIfAborted(inner);
        return value;
      } catch (error) {
        throwIfAborted(inner);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    if ('waitMs' in spec) {
      // The work keeps running after the wait ends, also when this call is cancelled.
      return Promise.race([waitWithoutCutting(send(undefined), spec.waitMs), aborted(signal)]);
    }
    const value = await send(signal);
    throwIfAborted(signal);
    return value;
  }

  async call(spec) {
    return this.finish(spec, await this.callAwaited(spec));
  }

  // Steps

  async parallel(specs, wait) {
    // Every client is built before the first member starts, so that `startAfterMs` delays only
    // the send and the members leave in the order given.
    const clients = await Promise.all(specs.map((spec) => this.clientFor(spec)));
    const tasks = specs.map((spec, index) =>
      startTask((signal) => this.callAwaited(spec, clients[index], signal)),
    );
    if (wait === 'all') {
      const outcomes = await Promise.all(tasks.map((task) => task.promise));
      specs.forEach((spec, index) => this.finish(spec, outcomes[index]));
      return;
    }
    await this.firstSuccess(specs, tasks);
  }

  /** Takes the first call that succeeds and cancels the rest. */
  async firstSuccess(specs, tasks) {
    let winner;
    let pending = [...tasks];
    while (pending.length > 0 && winner === undefined) {
      const done = await firstSettled(pending);
      pending = pending.filter((task) => task !== done);
      const outcome = await outcomeOf(done);
      if (!outcome.cancelled && outcome.value.error === undefined) {
        winner = done;
      }
    }
    for (const task of pending) {
      task.cancel();
    }
    const outcomes = await Promise.all(tasks.map(outcomeOf));
    const kept = [];
    outcomes.forEach((outcome, index) => {
      if (!outcome.cancelled) {
        this.record(specs[index], outcome.value);
        kept.push(outcome.value);
      }
    });
    if (winner === undefined) {
      this.finish(specs[0], kept[0]);
    }
  }

  /** The request as separate work, with the trial context (`copy`) or without it (`none`). */
  async thread(spec, context, join) {
    const work = () => this.callAwaited(spec).then((received) => this.record(spec, received));
    const running = context === 'copy' ? work() : outsideTrial(work);
    if (join) {
      await running;
    }
  }

  async executor(spec) {
    this.finish(spec, await outsideTrial(() => this.callAwaited(spec)));
  }

  background(step) {
    const delay = Number(step.delayMs ?? 0);
    const work = step.background;
    // Never awaited: a rejection is unhandled, as an exception of an `asyncio` task nobody awaits.
    void (async () => {
      await sleep(delay);
      if ('raise' in work) {
        throw this.exception(work.raise);
      }
      this.record(work, await this.callAwaited(work));
    })();
  }

  async step(step) {
    if ('call' in step) {
      await this.call(step.call);
    } else if ('parallel' in step) {
      await this.parallel(step.parallel, String(step.wait ?? 'all'));
    } else if ('thread' in step) {
      await this.thread(step.thread, String(step.context ?? 'none'), step.join ?? true);
    } else if ('executor' in step) {
      await this.executor(step.executor);
    } else if ('background' in step) {
      this.background(step);
    } else if ('uncaptured' in step || 'child' in step) {
      await this.uncaptured(step.uncaptured ?? step.child, 'child' in step);
    } else if ('notLoaded' in step) {
      // The Node form of Python's `sys.modules`: whether this process imported the SDK yet.
      const named = step.notLoaded.filter((name) => name === 'openai' || name === 'anthropic');
      if (named.length > 0 && sdkLoaded()) {
        throw new RuntimeError(`imported before the service function: ${JSON.stringify(named)}`);
      }
    } else if ('http' in step) {
      await this.http(step.http);
    } else if ('afterCertificateError' in step) {
      await this.afterCertificateError(step.afterCertificateError);
    } else if ('sleepMs' in step) {
      await sleep(step.sleepMs);
    } else if ('raise' in step) {
      throw this.exception(step.raise);
    } else {
      throw new Error(`unknown flow step ${JSON.stringify(step)}`);
    }
  }

  async uncaptured(spec, child) {
    const { body, options, conversation } = this.prepare(spec);
    const received = receivedOf(body, options, conversation);
    const api = this.apiOf(spec);
    try {
      if (child) {
        const done = await runFile(process.execPath, [UNCAPTURED_POST, api, JSON.stringify(body)]);
        received.text = done.stdout.replace(/\n$/, '');
      } else {
        received.text = await post(api, body);
      }
    } catch (error) {
      received.error = error;
    }
    this.finish(spec, received);
  }

  async http(data) {
    const url = baseUrl(this.api) + String(data.path);
    const headers = { authorization: 'Bearer test', 'x-api-key': 'test' };
    const received = receivedOf({}, {}, conversationOf(''));
    try {
      const init = { method: String(data.method ?? 'POST'), headers };
      if (data.json !== undefined) {
        init.body = JSON.stringify(data.json);
        headers['content-type'] = 'application/json';
      }
      const response = await globalThis.fetch(url, init);
      const body = await response.text();
      if ('status' in data && response.status !== data.status) {
        throw new RuntimeError(`status ${String(response.status)}, not ${String(data.status)}`);
      }
      received.text = httpText(this.api, body);
    } catch (error) {
      received.error = error;
    }
    this.finish(data, received);
  }

  async afterCertificateError(spec) {
    try {
      await httpsGet(`${baseUrl(this.api)}/models`);
    } catch {
      await this.call(spec);
      return;
    }
    throw new RuntimeError('the HTTPS request was expected to fail on the certificate');
  }

  result(spec) {
    if (spec === undefined) {
      return this.lastOk === undefined ? '' : this.lastOk.text;
    }
    if ('text' in spec) {
      return spec.text;
    }
    if ('fallback' in spec) {
      return helperExport('fallback')(spec.fallback);
    }
    if ('callText' in spec) {
      return this.received.get(spec.callText).text;
    }
    if ('fallbackCallText' in spec) {
      return helperExport('fallback')(this.received.get(spec.fallbackCallText).text);
    }
    if ('raise' in spec) {
      throw this.exception(spec.raise);
    }
    throw new Error(`unknown flow result ${JSON.stringify(spec)}`);
  }
}

/** Request options with the signal, or as they are without one. */
export function withSignal(options, signal) {
  return signal === undefined ? options : { ...options, signal };
}

/** Ends the work with the signal's reason once it aborted, though the work itself returned. */
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

/** The promise's value, or `ServiceTimeout` after `ms`; the work is left running. */
export async function waitWithoutCutting(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ServiceTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 10_000 }, (response) => {
      response.resume();
      response.on('error', reject);
      response.on('end', () => {
        // As Python's `urlopen`, an error status fails the request too.
        const status = response.statusCode ?? 0;
        if (status >= 400) {
          reject(new Error(`HTTP Error ${String(status)}`));
        } else {
          resolve();
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

export async function flow(run) {
  const runner = new Flow(run);
  for (const step of run.params.steps ?? []) {
    await runner.step(step);
  }
  return runner.result(run.params.result);
}

// `sdk-at-import` is the same flow in a process that capture_import_order.mjs prepares before the
// scenario service starts.
export const BEHAVIOURS = {
  flow,
  'sdk-at-import': flow,
};
