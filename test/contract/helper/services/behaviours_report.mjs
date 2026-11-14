// The `flow-report` and `task-group` behaviours: the `flow` of behaviours_flow.mjs whose target
// function reports what the helper cannot see, as a `result()` or a thrown `ModelCallError`
// (helper-api §Return Values, §`ModelCallError`, §What the Target Function Reports). The Python
// scenario services read the same parameters (behaviours_report.py).
//
//     {"steps": [...], "result": result, "report": report, "onException": report}
//
// `steps` and `result` are those of `flow`. `report` is what the target function gives once the
// flow returned; without it, the flow's own value. `onException` is what it gives when the flow
// threw, so the service's exception is caught and replaced; without it the exception goes on.
// A report is one of:
//
// - `{"result": fields}`: `result({...})` with `final`, `kind`, `discardReason`, `stages`, `raw`,
//   `answers`, `finishReason`, `stoppedEarly`, `usage`, `model` and `modelSnapshot`. `raw` and
//   `final` may be `{"callText": name}`, the text a named call received; `final` defaults to the
//   flow's value when that is a text; `"finalFromFlow": false` next to `result` leaves it out, for
//   a result without `final`.
// - `{"throw": fields}`: `throw new ModelCallError({...})` with `message` (a fixed text by
//   default), `status`, `type`, `code`, `kind`, `retryAfterMs`, `model` and `usage`. `errorOf:
//   selector` adds a captured call's failure as helper-api §Target Function says to pass it,
//   `new ModelCallError({ message, model: c.model, ...c.error })`; `call: selector` gives the call
//   itself as `call`. A selector picks an element of the target function's third argument, read
//   when the report is built: the calls with every given field (`model`, `outcome`,
//   `systemIncludes`, `failed`: whether it has an `error`, `retried`), the first of them, or the
//   `index`-th (`-1` for the last).
//
// A helper that lacks `result` or `ModelCallError` ends the adapter with one line on stderr, so a
// trial that needs them cannot pass by another path.
//
// Steps besides those of `flow`:
//
// - `{"guard": {"check": call, "answer": call | [call, ...], "alongside": [call, ...],
//   "blockText": text, "cut": "cancel" | "break" | "stopWaiting"}}`: the check, the answer
//   requests (one after another in one task) and the `alongside` calls sent together. When the
//   check failed or its text contains `blockText` (default `block`), the answers are cut:
//   `cancel` (default) aborts the awaited read, `break` leaves the stream's read loop at its next
//   event, `stopWaiting` leaves the requests running and no longer waits for them (helper-scenarios,
//   cut styles per client). Otherwise the step waits for the answers. It always waits for the
//   `alongside` calls.
// - `{"taskGroup": [call, ...], "except": "raise" | "swallow"}` (`task-group`): the calls sent
//   together, a call's exception cancelling the others, as Python's `asyncio.TaskGroup` does;
//   `raise` (default) throws an `AggregateError` of the calls' exceptions, `swallow` catches it
//   and the flow goes on to its `result`.
// - `{"poolWait": call, "waitMs": n, "then": [step, ...]}`: the request outside the trial context,
//   waited for at most `waitMs`; when the wait ends first, the `then` steps run, and the step
//   waits for the late response before it ends.
//
// Call fields besides those of `flow`:
//
// - `read: {"untilText": text}`: `break` after the stream event whose collected text contains it;
//   `read: {"untilMs": n}`: `break` at the first event after n ms since the request was sent.
// - `processMs`: an awaited pause after each stream event, the service's work on each chunk.
// - `uncaptured: true`: the request sent with `node:http` (uncaptured_post.mjs), outside every
//   captured transport, so leaving it is only stopping to wait.
//
// A streaming call keeps the tool calls its events carry, so `after` continues a streaming tool
// loop as it continues a non-stream one.

import {
  Flow,
  receivedOf,
  RESPONSES_END_EVENTS,
  ServiceTimeout,
  eventText,
  sendAsync,
  waitWithoutCutting,
  withSignal,
} from './behaviours_flow.mjs';
import {
  Cancelled,
  cancelledBy,
  firstSettled,
  helperExport,
  loadSdk,
  outcomeOf,
  outsideTrial,
  resource,
  settled,
  sleep,
  startTask,
} from './support.mjs';
import { post } from './uncaptured_post.mjs';

import { performance } from 'node:perf_hooks';

const DEFAULT_ERROR_MESSAGE = 'The model call failed.';

// Streams the service collects itself

/** The text and tool calls of one stream as the service collected them. */
export class StreamAnswer {
  constructor(api) {
    this.api = api;
    this.pieces = [];
    this.tools = new Map();
    this.responsesFinal = null;
    this.model = '';
  }

  get text() {
    return this.pieces.join('');
  }

  add(event) {
    this.pieces.push(eventText(this.api, event));
    if (this.api === 'chat-completions') {
      this.addChat(event);
    } else if (this.api === 'responses') {
      if (RESPONSES_END_EVENTS.includes(event.type)) {
        this.responsesFinal = event.response;
      }
    } else {
      this.addMessages(event);
    }
  }

  addChat(event) {
    this.model = String(event.model ?? '') || this.model;
    for (const choice of event.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        if (!this.tools.has(call.index)) {
          this.tools.set(call.index, { id: '', name: '', arguments: '' });
        }
        const entry = this.tools.get(call.index);
        if (call.id) {
          entry.id = call.id;
        }
        if (call.function?.name) {
          entry.name = call.function.name;
        }
        if (call.function?.arguments) {
          entry.arguments += call.function.arguments;
        }
      }
    }
  }

  addMessages(event) {
    if (event.type === 'message_start') {
      this.model = String(event.message.model);
    } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const block = event.content_block;
      this.tools.set(event.index, { id: block.id, name: block.name, arguments: '' });
    } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      this.tools.get(event.index).arguments += event.delta.partial_json;
    }
  }

  /**
   * A response that ends in these tool calls, in the SDK's response shape, so `after` continues
   * the tool loop; null when the stream called no tool.
   */
  response() {
    if (this.api === 'responses') {
      return this.responsesFinal;
    }
    if (this.tools.size === 0) {
      return null;
    }
    const calls = [...this.tools.keys()].sort((a, b) => a - b).map((key) => this.tools.get(key));
    if (this.api === 'chat-completions') {
      const message = {
        role: 'assistant',
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
      if (this.text) {
        message.content = this.text;
      }
      return {
        id: 'chatcmpl-stream',
        object: 'chat.completion',
        created: 0,
        model: this.model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message }],
      };
    }
    const content = this.text ? [{ type: 'text', text: this.text }] : [];
    for (const call of calls) {
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: JSON.parse(call.arguments || '{}'),
      });
    }
    return {
      id: 'msg-stream',
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

/**
 * Whether the service reads this call's stream with the loop below rather than the flow's: every
 * whole read and the reads this module adds.
 */
function readsItself(spec) {
  if (spec.uncaptured) {
    return false;
  }
  const read = spec.read ?? 'all';
  const plain =
    read === 'all' || (typeof read === 'object' && ('untilText' in read || 'untilMs' in read));
  const others = ['streamingResponse', 'closeAfterMs'];
  return Boolean(spec.stream) && plain && !others.some((key) => key in spec);
}

/**
 * When the service leaves a stream's read loop after an event: once the collected text holds
 * `read.untilText`, once `read.untilMs` passed since the request was sent (at the first event
 * after that deadline), or once a guard's check blocked (`cut`).
 */
class Leaving {
  constructor(spec, cut) {
    const read = typeof spec.read === 'object' ? spec.read : {};
    this.text = 'untilText' in read ? String(read.untilText) : undefined;
    this.deadline = 'untilMs' in read ? performance.now() + Number(read.untilMs) : undefined;
    this.cut = cut;
  }

  now(answer) {
    if (this.text !== undefined && answer.text.includes(this.text)) {
      return true;
    }
    if (this.deadline !== undefined && performance.now() >= this.deadline) {
      return true;
    }
    return this.cut?.set === true;
  }
}

async function readStream(api, spec, body, options, client, cut, signal) {
  const answer = new StreamAnswer(api);
  const leaving = new Leaving(spec, cut);
  const pause = spec.processMs;
  const stream = await resource(client, api).create(body, options);
  for await (const event of stream) {
    answer.add(event);
    if (leaving.now(answer)) {
      break;
    }
    if (pause !== undefined) {
      await sleep(Number(pause), signal);
    }
  }
  return [answer.response(), answer.text];
}

function postUncaptured(api, body, signal) {
  const { stream: _stream, ...rest } = body;
  return post(api, rest, signal);
}

// Running a reporting flow

/** A `flow` with the steps, call fields and reports of this module. */
export class ReportFlow extends Flow {
  constructor(run) {
    super(run);
    // Set by a guard whose check blocked with the cut style `break`; the stream reads of the
    // answer leave their loop at the next event.
    this.cut = { set: false };
  }

  async callAwaited(spec, client, signal) {
    if (!(readsItself(spec) || spec.uncaptured)) {
      return super.callAwaited(spec, client, signal);
    }
    if ('startAfterMs' in spec) {
      await sleep(spec.startAfterMs, signal);
    }
    const { body, options, conversation } = this.prepare(spec);
    const received = receivedOf(body, options, conversation);
    const used = client ?? (spec.uncaptured ? undefined : await this.clientFor(spec));
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

  sending(api, spec, body, options, client, signal) {
    if (spec.uncaptured) {
      return postUncaptured(api, body, signal).then((text) => [null, text]);
    }
    if (readsItself(spec)) {
      return readStream(api, spec, body, options, client, this.cut, signal);
    }
    return sendAsync(api, spec, body, options, client);
  }

  /** The clients of calls sent together, built before the first one starts. */
  clientsFor(specs) {
    return Promise.all(specs.map((spec) => (spec.uncaptured ? undefined : this.clientFor(spec))));
  }

  async step(step) {
    if ('guard' in step) {
      await this.guard(step.guard);
    } else if ('taskGroup' in step) {
      await this.taskGroup(step);
    } else if ('poolWait' in step) {
      await this.poolWait(step);
    } else {
      await super.step(step);
    }
  }

  async guard(data) {
    const check = data.check;
    const answers = Array.isArray(data.answer) ? data.answer : [data.answer];
    const alongside = data.alongside ?? [];
    const [checkClient, ...answerClients] = await this.clientsFor([check, ...answers]);
    const sideClients = await this.clientsFor(alongside);
    const answerTask = startTask((signal) => this.answerInTurn(answers, answerClients, signal));
    const sideTasks = alongside.map((spec, index) =>
      startTask((signal) => this.callAwaited(spec, sideClients[index], signal)),
    );
    const checked = await this.callAwaited(check, checkClient);
    const blocked =
      checked.error !== undefined || checked.text.includes(String(data.blockText ?? 'block'));
    const style = data.cut ?? 'cancel';
    if (!blocked) {
      await answerTask.promise;
    } else if (style === 'cancel') {
      answerTask.cancel();
      await settled(answerTask.promise);
    } else if (style === 'break') {
      this.cut.set = true;
      await settled(answerTask.promise);
      this.cut.set = false;
    }
    for (const [index, spec] of alongside.entries()) {
      this.finish(spec, await sideTasks[index].promise);
    }
    this.finish(check, checked);
  }

  async answerInTurn(specs, clients, signal) {
    for (const [index, spec] of specs.entries()) {
      this.finish(spec, await this.callAwaited(spec, clients[index], signal));
    }
  }

  async taskGroup(step) {
    const specs = step.taskGroup;
    const clients = await this.clientsFor(specs);
    const tasks = specs.map((spec, index) =>
      startTask(async (signal) => {
        const received = await this.callAwaited(spec, clients[index], signal);
        this.record(spec, received);
        if (received.error !== undefined) {
          throw received.error;
        }
      }),
    );
    const errors = [];
    let pending = [...tasks];
    while (pending.length > 0) {
      const done = await firstSettled(pending);
      pending = pending.filter((task) => task !== done);
      try {
        await outcomeOf(done);
      } catch (error) {
        errors.push(error);
        for (const task of pending) {
          task.cancel();
        }
      }
    }
    if (errors.length === 0 || step.except === 'swallow') {
      return;
    }
    throw new AggregateError(errors, 'unhandled errors in a TaskGroup');
  }

  async poolWait(step) {
    const spec = step.poolWait;
    const running = outsideTrial(() => this.callAwaited(spec));
    let received;
    try {
      received = await waitWithoutCutting(running, Number(step.waitMs));
    } catch (error) {
      if (!(error instanceof ServiceTimeout)) {
        throw error;
      }
      for (const later of step.then ?? []) {
        await this.step(later);
      }
      await settled(running);
      return;
    }
    this.finish(spec, received);
  }

  // Reports

  value(given) {
    if (typeof given === 'object' && given !== null && 'callText' in given) {
      return this.received.get(given.callText).text;
    }
    return given;
  }

  /**
   * What the target function gives: the flow's value, a `result()`, or a thrown
   * `ModelCallError`. The helper's names are looked up here, at report time.
   */
  report(report, returned) {
    if (report.flow) {
      return returned;
    }
    if ('result' in report) {
      const fields = {};
      for (const [key, value] of Object.entries(report.result)) {
        fields[key] = this.value(value);
      }
      const fill = report.finalFromFlow ?? true;
      if (fill && !('final' in fields) && typeof returned === 'string') {
        fields.final = returned;
      }
      return helperExport('result')(fields);
    }
    const { errorOf, call, ...fields } = report.throw;
    const options = { message: DEFAULT_ERROR_MESSAGE };
    if (errorOf !== undefined) {
      const failed = this.select(errorOf);
      Object.assign(options, { model: failed.model, ...failed.error });
    }
    if (call !== undefined) {
      options.call = this.select(call);
    }
    Object.assign(options, fields);
    const ModelCallError = helperExport('ModelCallError');
    throw new ModelCallError(options);
  }

  /** The call of the third argument the selector names. */
  select(selector) {
    const matching = [...this.run.calls].filter((call) => callMatches(call, selector));
    const index = Number(selector.index ?? 0);
    if (!(-matching.length <= index && index < matching.length)) {
      throw new RangeError(
        `no captured call ${JSON.stringify(selector)} among ${String(matching.length)}`,
      );
    }
    return matching.at(index);
  }
}

function callMatches(call, selector) {
  if ('model' in selector && call.model !== selector.model) {
    return false;
  }
  if ('outcome' in selector && call.outcome !== selector.outcome) {
    return false;
  }
  const failed = call.error !== undefined && call.error !== null;
  if ('failed' in selector && failed !== selector.failed) {
    return false;
  }
  if ('retried' in selector && call.retried !== selector.retried) {
    return false;
  }
  if ('systemIncludes' in selector) {
    const systems = (call.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content ?? ''));
    if (!systems.some((text) => text.includes(selector.systemIncludes))) {
      return false;
    }
  }
  return true;
}

/**
 * Runs a reporting flow's steps and gives what its target function gives: `report` after the
 * steps, `onException` when they threw. The SDK is loaded first, as a service that creates its
 * client at start-up has it, so the first request of a step under a time limit is not held up.
 */
export async function runReport(runner) {
  await loadSdk();
  const params = runner.run.params;
  let returned;
  try {
    for (const step of params.steps ?? []) {
      await runner.step(step);
    }
    returned = runner.result(params.result);
  } catch (error) {
    const onException = params.onException;
    if (onException === undefined || error instanceof Cancelled) {
      throw error;
    }
    return runner.report(onException, error);
  }
  const report = params.report;
  return report === undefined ? returned : runner.report(report, returned);
}

async function flowReport(run) {
  return runReport(new ReportFlow(run));
}

export const BEHAVIOURS = {
  'flow-report': flowReport,
  'task-group': flowReport,
};
