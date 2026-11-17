// The `stream-report` behaviour: the `flow-report` of behaviours_report.mjs, whose target function
// reports as a `result()` or a `ModelCallError`, with streams the service cuts in the styles of
// data-model §Cut Streams. The Python scenario services read the same parameters
// (behaviours_raw.py).
//
//     {"steps": [...], "result": result, "report": report, "onException": report}
//
// `steps`, `result`, `report` and `onException` are those of `flow-report`. Every streamed call
// other than `uncaptured` and `streamingResponse` ones is read here: it keeps the text and tool
// calls it received when it fails or is cut, and also takes:
//
// - `cut`: `{"at": at, "style": style}`, where the service stops reading the stream.
//   - `at`: `{"text": s}` once the received text contains `s` (a content check or a configured
//     stop string); `{"ms": n}` once n ms passed since the request was sent (the service's time
//     limit); `{"event": type}` at the first event of that type, or `{"event": "finish"}` at the
//     event that carries the finish reason (Chat Completions `finish_reason`, Anthropic
//     `message_delta`, a Responses end event).
//   - `style`: `break` leaves the read loop; `close` aborts the stream, then leaves; `abort` is
//     `close` after `after`; `cancel` aborts the read the service is awaiting; `stop-waiting`
//     stops waiting and leaves the read running (`Promise.race`). With `ms`, `break`, `close` and
//     `abort` act at the first event after the deadline.
//   - `in`: `loop` (default) reads with `for await`; `handler` (stream helper, style `abort`)
//     reads in the helper's event handler and calls `abort()` there, then awaits `done()`.
//   - `after`: what `abort` waits for before it calls `abort()`: nothing (default, at once),
//     `await` (one `await`) or `setImmediate` (one turn of the event loop).
//   - The text kept is what was received up to and including the event where the cut happens.
// - `processMs`: an awaited pause after each event, the service's work on each chunk, so a time
//   limit (`limitMs`) can fire while no read is awaited.
// - `processTextMs`: the same pause after each event that adds text only, so a time limit can be
//   placed inside the work on the first text, whatever number of events comes before it.
// - `streamHelper`: true reads the stream through the SDK's stream helper
//   (`client.chat.completions.stream()`, `client.messages.stream()`, `client.responses.stream()`).
//   A Chat Completions helper's text comes from its `content.delta` events, and a cut can name
//   its `content.done` event (`{"event": "content.done"}`); the other helpers give the stream
//   events themselves.
//
// One more step: `{"closeStream": name}` aborts the stream of that earlier call.

import {
  RESPONSES_END_EVENTS,
  receivedOf,
  ServiceTimeout,
  withSignal,
} from './behaviours_flow.mjs';
import { ReportFlow, StreamAnswer, runReport } from './behaviours_report.mjs';
import {
  HELPER_STREAM_EVENT,
  cancelledBy,
  closeStream,
  eitherSignal,
  resource,
  settled,
  setupError,
  sleep,
  streamHelper,
} from './support.mjs';

import { performance } from 'node:perf_hooks';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';

const { AbortController } = globalThis;
const HELPER_TEXT_EVENT = 'content.delta';
/** The Chat Completions stream helper's events a cut can name, besides the text deltas. */
const HELPER_EVENTS = ['content.done', 'refusal.done', 'tool_calls.function.arguments.done'];

// What a stream gave the service

/** The text and tool calls of one stream as the service took them, up to its cut. */
class CutStream {
  constructor(api, helper) {
    this.answer = new StreamAnswer(api);
    // Only a Chat Completions helper gives text events of its own; the others give stream events.
    this.helper = helper && api === 'chat-completions';
    this.cut = false;
    this.stream = undefined;
  }

  get text() {
    return this.answer.text;
  }

  add(event) {
    if (this.cut) {
      return;
    }
    if (!this.helper) {
      this.answer.add(event);
    } else if (event.type === HELPER_TEXT_EVENT) {
      this.answer.pieces.push(String(event.delta));
    }
  }

  /** The response `after` continues a tool loop from, and the text. */
  result() {
    return [this.helper ? null : this.answer.response(), this.text];
  }
}

/** Whether the event carries the finish reason of the answer. */
function finishEvent(api, event) {
  if (api === 'chat-completions') {
    return (event.choices ?? []).some(
      (choice) => choice.finish_reason !== null && choice.finish_reason !== undefined,
    );
  }
  if (api === 'responses') {
    return RESPONSES_END_EVENTS.includes(event.type);
  }
  return event.type === 'message_delta';
}

/** Where and how the service stops reading a stream (`cut`). */
class Cut {
  constructor(at, style, place = 'loop', after = undefined) {
    this.at = at;
    this.style = style;
    this.place = place;
    this.after = after;
    this.started = performance.now();
  }

  /** Whether other work cuts the read loop while it waits (`cancel`, `stop-waiting`). */
  get outside() {
    return this.style === 'cancel' || this.style === 'stop-waiting';
  }

  reached(api, taken, event) {
    if ('text' in this.at) {
      return taken.text.includes(String(this.at.text));
    }
    if ('ms' in this.at) {
      return this.elapsedMs() >= Number(this.at.ms);
    }
    const wanted = String(this.at.event);
    if (wanted === 'finish') {
      return finishEvent(api, event);
    }
    return event.type === wanted;
  }

  elapsedMs() {
    return performance.now() - this.started;
  }

  remainingMs() {
    if (!('ms' in this.at)) {
      return undefined;
    }
    return Math.max(0, Number(this.at.ms) - this.elapsedMs());
  }
}

function cutOf(spec) {
  const cut = spec.cut;
  if (cut === undefined) {
    return undefined;
  }
  if (cut.in === 'handler' && (!spec.streamHelper || cut.style !== 'abort')) {
    setupError('cut `in: handler` takes `streamHelper` and the style `abort`');
  }
  return new Cut({ ...cut.at }, String(cut.style), cut.in ?? 'loop', cut.after);
}

/** Calls `abort()` on the stream after what `after` names: nothing, one `await`, one turn. */
async function abortAfter(stream, after) {
  if (after === 'await') {
    await null;
  } else if (after === 'setImmediate') {
    await new Promise((resolve) => setImmediate(resolve));
  }
  closeStream(stream);
}

/** A one-shot flag that work can wait for, as an `asyncio.Event`. */
class Reached {
  constructor() {
    this.isSet = false;
    this.waiting = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  set() {
    this.isSet = true;
    this.resolve();
  }
}

/** Calls `listener` with each event of a Chat Completions stream helper's `HELPER_EVENTS`. */
function onChatHelperEvents(stream, listener) {
  for (const type of [HELPER_TEXT_EVENT, ...HELPER_EVENTS]) {
    stream.on(type, (event) => listener({ ...event, type }));
  }
}

/**
 * The events of a Chat Completions stream helper, each chunk's events after it arrives: the
 * iterator yields chunks, and the helper emits `content.delta` and the other events as it adds
 * a chunk. The other helpers' iterators yield their stream events.
 */
async function* helperEvents(api, stream) {
  if (api !== 'chat-completions') {
    yield* stream;
    return;
  }
  const queued = [];
  onChatHelperEvents(stream, (event) => queued.push(event));
  for await (const chunk of stream) {
    yield* queued.splice(0);
    yield chunk;
  }
  yield* queued.splice(0);
}

// Running the flow

/** A `flow-report` that reads and cuts its streams itself. */
class StreamReportFlow extends ReportFlow {
  constructor(run) {
    super(run);
    this.taken = new Map();
  }

  static cutHere(spec) {
    const others = ['uncaptured', 'streamingResponse', 'closeAfterMs'];
    return Boolean(spec.stream) && !others.some((key) => key in spec);
  }

  keep(spec, received, taken) {
    if (spec.name !== undefined) {
      this.taken.set(String(spec.name), taken);
    }
    [received.response, received.text] = taken.result();
    return received;
  }

  async callAwaited(spec, client, signal) {
    if (!StreamReportFlow.cutHere(spec)) {
      return super.callAwaited(spec, client, signal);
    }
    if ('startAfterMs' in spec) {
      await sleep(spec.startAfterMs, signal);
    }
    const api = this.apiOf(spec);
    const { body, options, conversation } = this.prepare(spec);
    const received = receivedOf(body, options, conversation);
    const taken = new CutStream(api, Boolean(spec.streamHelper));
    const used = client ?? (await this.clientFor(spec));
    try {
      await this.limited(
        spec,
        (inner) => this.sendStream(api, spec, body, options, used, taken, inner),
        signal,
      );
    } catch (error) {
      if (cancelledBy(signal)) {
        throw signal.reason;
      }
      received.error = error;
    }
    return this.keep(spec, received, taken);
  }

  async sendStream(api, spec, body, options, client, taken, signal) {
    const cut = cutOf(spec);
    const reached = new Reached();
    const consume = async (readSignal) => {
      const request = withSignal(options, readSignal);
      const stream = spec.streamHelper
        ? streamHelper(client, api, body, request)
        : await resource(client, api).create(body, request);
      if (cut?.place === 'handler') {
        await this.readInHandler(api, stream, taken, cut);
      } else {
        await this.readStream(api, spec, stream, taken, cut, reached, readSignal);
      }
    };
    if (cut === undefined || !cut.outside) {
      await consume(signal);
    } else {
      await this.cutFromOutside(consume, taken, cut, reached, signal);
    }
    return taken.result();
  }

  /**
   * Reads the stream. At the cut point the `break` and `close` styles leave the loop; the other
   * styles signal `reached` and read on until the service cuts from outside.
   */
  async readStream(api, spec, stream, taken, cut, reached, signal) {
    taken.stream = stream;
    const pauseMs = Number(spec.processMs ?? 0);
    const textPauseMs = Number(spec.processTextMs ?? 0);
    const events = spec.streamHelper ? helperEvents(api, stream) : stream;
    for await (const event of events) {
      const textBefore = taken.text.length;
      taken.add(event);
      if (cut !== undefined && !reached.isSet && cut.reached(api, taken, event)) {
        taken.cut = true;
        if (cut.outside) {
          reached.set();
          continue;
        }
        if (cut.style === 'close') {
          closeStream(stream);
        } else if (cut.style === 'abort') {
          await abortAfter(stream, cut.after);
        }
        return;
      }
      if (pauseMs > 0) {
        await sleep(pauseMs, signal);
      }
      if (textPauseMs > 0 && taken.text.length > textBefore) {
        await sleep(textPauseMs, signal);
      }
    }
  }

  /**
   * Reads a stream helper in its event handler, as a service that uses `.on()` and `done()`; at
   * the cut point the handler aborts the stream. The service then answers with what it took, so
   * the abort's rejection of `done()` is caught.
   */
  async readInHandler(api, stream, taken, cut) {
    taken.stream = stream;
    let aborting;
    const listener = (event) => {
      taken.add(event);
      if (aborting === undefined && cut.reached(api, taken, event)) {
        taken.cut = true;
        aborting = abortAfter(stream, cut.after);
      }
    };
    if (api === 'chat-completions') {
      onChatHelperEvents(stream, listener);
    }
    stream.on(HELPER_STREAM_EVENT[api], listener);
    try {
      await stream.done();
    } catch (error) {
      if (!taken.cut) {
        throw error;
      }
    }
    await aborting;
  }

  /**
   * The request and its read loop run as their own work. At the cut point the service aborts
   * that work, which is then awaiting the next read (`cancel`), or stops waiting for it
   * (`stop-waiting`).
   */
  async cutFromOutside(consume, taken, cut, reached, signal) {
    const controller = new AbortController();
    let done = false;
    const reader = consume(eitherSignal(signal, controller.signal));
    const finished = settled(reader).then(() => {
      done = true;
    });
    const remaining = cut.remainingMs();
    let timer;
    const deadline =
      remaining === undefined
        ? new Promise(() => undefined)
        : new Promise((resolve) => {
            timer = setTimeout(resolve, remaining);
          });
    await Promise.race([finished, reached.waiting, deadline]);
    clearTimeout(timer);
    if (done) {
      await reader;
      return;
    }
    taken.cut = true;
    if (cut.style === 'cancel') {
      controller.abort(new ServiceTimeout('the service cut the stream'));
      await settled(reader);
    }
    // `stop-waiting` leaves the reader running; nothing waits for it.
  }

  async step(step) {
    if (!('closeStream' in step)) {
      await super.step(step);
      return;
    }
    closeStream(this.taken.get(String(step.closeStream)).stream);
  }
}

async function streamReport(run) {
  return runReport(new StreamReportFlow(run));
}

export const BEHAVIOURS = { 'stream-report': streamReport };
