import { performance } from 'node:perf_hooks';

import { canonicalJson } from '../adapter/canonical-json.js';
import { type JsonObject, type JsonValue } from '../adapter/json-types.js';
import {
  asDict,
  asList,
  type CapturedCall,
  conversationItems,
  type Failure,
  type FinishReason,
  type Parsed,
  partsText,
  protocolFinish,
  readJson,
  type RenderMessage,
  renderFingerprint,
  RESULT_ITEM_TYPES,
  RESULT_ITEMS,
  responsesInput,
  type ToolCall,
  toolNamesOf,
  type Usage,
  callIdOf,
} from './capture.js';
import type { Trial } from './context.js';
import {
  classify,
  type ErrorKind,
  type ErrorObject,
  errorObjectOf,
  failureKind,
  failureOutcome,
  type TransportKind,
  waitMs,
} from './errors.js';
import {
  discardReason,
  exceptionText,
  message,
  type MessageId,
  modelList,
  trimText,
} from './messages.js';

// data-model §Answers, §Outcome Decision, §Raw Cannot Be Determined and §Derived Result Fields;
// helper-api §Return Values and §Trial Warnings.

// --- The adapter's view (helper-api §Target Function, §Return Values, §`ModelCallError`) -----

/** The case of one trial: `rendering` is true in render mode, where `repeat` is 0. */
export interface Case {
  readonly id: string;
  readonly lang: string | undefined;
  readonly input: JsonObject;
  readonly repeat: number;
  readonly seed: number;
  readonly rendering: boolean;
}

export interface Variant {
  readonly id: string;
  readonly model: string;
  readonly params: JsonObject;
}

/** A failed call's failure, under `ModelCallError`'s names. */
export interface CallError {
  readonly status?: number;
  readonly type?: string;
  readonly code?: string;
  readonly kind?: TransportKind;
  readonly retryAfterMs?: number;
}

/**
 * One captured call as the target function's third argument and `replyCall` see it. Response
 * fields are undefined for calls that have not ended (data-model §When a Call Ended).
 */
export class Call {
  readonly text: string | undefined;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: string | undefined;
  readonly usage: Usage | undefined;
  readonly outcome: 'ok' | 'failed' | 'unanswered' | undefined;
  readonly error: CallError | undefined;
  readonly retried: boolean | undefined;

  constructor(
    readonly model: string,
    readonly messages: readonly RenderMessage[],
    readonly toolNames: readonly string[],
    response: Partial<Omit<Call, 'model' | 'messages' | 'toolNames' | 'toolArgs'>> = {},
  ) {
    this.text = response.text;
    this.toolCalls = response.toolCalls ?? [];
    this.finishReason = response.finishReason;
    this.usage = response.usage === undefined ? undefined : { ...response.usage };
    this.outcome = response.outcome;
    this.error = response.error;
    this.retried = response.retried;
  }

  /**
   * The parsed arguments of the first tool call with that name, or undefined when there is none
   * or its arguments are not JSON.
   */
  toolArgs(name: string): JsonValue | undefined {
    const call = this.toolCalls.find((item) => item.name === name);
    return call === undefined ? undefined : readJson(call.arguments);
  }
}

/** The captured call each view shows, so that `ModelCallError({ call })` finds it. */
const SOURCES = new WeakMap<Call, CapturedCall>();

// Marks of the helper's own values, read with `Symbol.for` so that a value built by another copy
// of this module (a second install of the package) is still recognised.
const FALLBACK_MARK = Symbol.for('model-eval.adapter.fallback');
const RESULT_MARK = Symbol.for('model-eval.adapter.result');
const MODEL_CALL_ERROR_MARK = Symbol.for('model-eval.adapter.model-call-error');

function marked(value: unknown, mark: symbol): boolean {
  return typeof value === 'object' && value !== null && mark in value;
}

function mark(value: object, symbol: symbol): void {
  Object.defineProperty(value, symbol, { value: true });
}

/** Shipped text that is not the model's answer (a fixed message, another model's answer). */
export class Fallback {
  constructor(readonly text: unknown) {
    mark(this, FALLBACK_MARK);
  }
}

/**
 * Marks the shipped text as a fallback (data-model §Another Model's Answer). A value that is not
 * text is kept as given and makes the trial adapter error A14.
 */
export function fallback(text: string): Fallback {
  return new Fallback(text);
}

/**
 * The fields of a `Result` (helper-api §`Result`). Values are checked when the trial is decided
 * (helper-api §Checking `Result` and `ModelCallError` Values); `null` and `undefined` count as not
 * given, except an explicit `final: null`.
 */
export interface ResultFields {
  readonly final?: string | null;
  readonly kind?: 'model' | 'fallback' | 'discarded' | null;
  readonly discardReason?: string | null;
  readonly stages?: readonly { readonly name: string; readonly text: string }[] | null;
  readonly raw?: string | null;
  readonly answers?: number | null;
  readonly finishReason?: FinishReason | null;
  readonly stoppedEarly?: boolean | null;
  readonly usage?: Usage | null;
  readonly model?: string | null;
  readonly modelSnapshot?: string | null;
}

const RESULT_FIELDS: ReadonlySet<string> = new Set([
  'final',
  'kind',
  'discardReason',
  'stages',
  'raw',
  'answers',
  'finishReason',
  'stoppedEarly',
  'usage',
  'model',
  'modelSnapshot',
]);

/** Refuses a field name the value does not have, as a `TypeError` when the value is created. */
function knownFields(fields: object, names: ReadonlySet<string>, what: string): void {
  const unknown = Object.keys(fields).filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new TypeError(`${what} has no field ${unknown.map((name) => `\`${name}\``).join(', ')}`);
  }
}

/** A target function's result built with `result()`; its values are checked when decided. */
export class Result {
  readonly fields: Readonly<Record<string, unknown>>;

  constructor(fields: ResultFields) {
    knownFields(fields, RESULT_FIELDS, 'result()');
    this.fields = Object.freeze({ ...fields });
    mark(this, RESULT_MARK);
  }
}

/** Builds a `Result` (helper-api §Return Values). */
export function result(fields: ResultFields): Result {
  return new Result(fields);
}

/** The fields of a `ModelCallError` (helper-api §`ModelCallError`). */
export interface ModelCallErrorFields {
  readonly message?: string | null;
  readonly status?: number | null;
  readonly type?: string | null;
  readonly code?: string | null;
  readonly kind?: TransportKind | null;
  readonly retryAfterMs?: number | null;
  readonly model?: string | null;
  readonly usage?: Usage | null;
  readonly call?: Call | null;
}

const MODEL_CALL_ERROR_FIELDS: ReadonlySet<string> = new Set([
  'message',
  'status',
  'type',
  'code',
  'kind',
  'retryAfterMs',
  'model',
  'usage',
  'call',
]);

/**
 * A model call failure the target function reports (helper-api §`ModelCallError`). Its values
 * are checked when the trial is decided (A12, A13).
 */
export class ModelCallError extends Error {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly status: unknown;
  readonly type: unknown;
  readonly code: unknown;
  readonly kind: unknown;
  readonly retryAfterMs: unknown;
  readonly model: unknown;
  readonly usage: unknown;
  readonly call: unknown;

  constructor(fields: ModelCallErrorFields = {}) {
    knownFields(fields, MODEL_CALL_ERROR_FIELDS, 'ModelCallError');
    super(typeof fields.message === 'string' ? fields.message : '');
    this.name = 'ModelCallError';
    this.fields = Object.freeze({ ...fields });
    this.status = fields.status;
    this.type = fields.type;
    this.code = fields.code;
    this.kind = fields.kind;
    this.retryAfterMs = fields.retryAfterMs;
    this.model = fields.model;
    this.usage = fields.usage;
    this.call = fields.call;
    mark(this, MODEL_CALL_ERROR_MARK);
  }
}

export function isFallback(value: unknown): value is Fallback {
  return marked(value, FALLBACK_MARK);
}

export function isResult(value: unknown): value is Result {
  return marked(value, RESULT_MARK);
}

export function isModelCallError(value: unknown): value is ModelCallError {
  return marked(value, MODEL_CALL_ERROR_MARK);
}

export type DiscardOn =
  readonly (abstract new (...args: never[]) => unknown)[] | ((error: unknown) => unknown);

/** The value a target function or a render function receives and returns. */
export type TargetFunction = (c: Case, variant: Variant, calls: readonly Call[]) => unknown;
export type RenderFunction = (c: Case, variant: Variant) => unknown;

/** One target with the options of helper-api §Target Options. */
export interface Target {
  readonly name: string;
  readonly generate: TargetFunction;
  readonly languages: readonly string[] | undefined;
  readonly inputSchema: JsonValue;
  readonly render: boolean | RenderFunction;
  readonly discardOn: DiscardOn;
  readonly replyCall: ((call: Call) => unknown) | undefined;
  readonly answerTool: readonly [string, string] | undefined;
  readonly postprocess: boolean;
}

/**
 * Whether the exception is one the service raises when it discards an answer. `discardOn` is
 * never consulted for a `ModelCallError`, which the caller keeps apart.
 */
function discards(target: Target, error: unknown): boolean {
  const rule = target.discardOn;
  if (typeof rule === 'function') {
    return Boolean(rule(error));
  }
  return rule.some((type) => error instanceof type);
}

// --- Calls as received (data-model §When a Call Ended, §Unread Response) ---------------------

type CallState = 'ok' | 'unread' | 'failed' | 'unfinished' | 'cut';

/**
 * A call as it stood at one moment: when the function returned, which decides the outcome, or
 * after the wait for unfinished calls, which gives their records.
 */
export interface Seen {
  readonly call: CapturedCall;
  readonly state: CallState;
  readonly endedAt: number | undefined;
  readonly failure: Failure | undefined;
  readonly parsed: Parsed | undefined;
  readonly sse: boolean;
  readonly background: boolean;
  readonly generationEnd: boolean;
  readonly streamToolEnd: boolean;
  readonly streamOutput: readonly JsonValue[] | undefined;
  readonly responseId: string | undefined;
  readonly hadHeaders: boolean;
  /** When the service last read the body, else when the headers arrived. */
  readonly readAt: number | undefined;
  readonly error: ErrorObject;
}

/** The failure's error kind (helper-api §Error Classification). */
export function kindOf(seen: Seen): ErrorKind | undefined {
  return seen.failure === undefined ? undefined : failureKind(seen.failure, seen.error);
}

/** data-model §Call Outcome. */
export function outcomeOf(seen: Seen): 'ok' | 'failed' | 'unanswered' {
  if (seen.state === 'cut' || (seen.state === 'unfinished' && !seen.hadHeaders)) {
    return 'unanswered';
  }
  if (seen.state !== 'failed' || seen.failure === undefined) {
    return 'ok';
  }
  return failureOutcome(seen.failure, seen.failure.usage);
}

function endedInToolCall(seen: Seen): boolean {
  const first = seen.parsed?.choices[0];
  if (seen.state === 'ok' && first !== undefined) {
    return first.toolEnd;
  }
  return seen.sse && seen.state === 'unread' && seen.streamToolEnd;
}

function outputItems(seen: Seen): readonly JsonValue[] | undefined {
  return seen.parsed !== undefined ? seen.parsed.outputItems : seen.streamOutput;
}

function successful(seen: Seen): boolean {
  return seen.state === 'ok' || seen.state === 'unread';
}

export function freeze(call: CapturedCall): Seen {
  let state: CallState;
  let background = false;
  if (call.cut) {
    state = 'cut';
  } else if (call.failure !== undefined) {
    state = 'failed';
  } else if (call.inFlight()) {
    state = 'unfinished';
  } else if (call.sse || call.parsed === undefined) {
    state = 'unread';
  } else if (call.parsed.status === 'queued' || call.parsed.status === 'in_progress') {
    state = 'unread';
    background = true;
  } else {
    state = 'ok';
  }
  const endedAt =
    state === 'unread' ? (call.generationEndAt ?? call.lastReadAt ?? call.headersAt) : call.endedAt;
  const marks = call.reader?.marks;
  return {
    call,
    state,
    endedAt,
    failure: call.failure,
    parsed: state === 'ok' || state === 'unread' ? call.parsed : undefined,
    sse: call.sse,
    background,
    generationEnd: call.generationEndAt !== undefined,
    streamToolEnd: marks?.toolEnd ?? false,
    streamOutput: marks?.outputItems,
    responseId: call.parsed?.responseId ?? marks?.responseId,
    hadHeaders: call.headersAt !== undefined,
    readAt: call.lastReadAt ?? call.headersAt,
    error: errorObjectOf(call.errorObject()),
  };
}

/** floor(x + 0.5) of a non-negative duration in ms. */
export function milliseconds(duration: number): number {
  return Math.floor(Math.max(duration, 0) + 0.5);
}

/**
 * The protocol call record (001 data-model §Trial). A call that had not ended when the function
 * returned has no `latencyMs` (data-model §When a Call Ended).
 */
export function callRecord(
  seen: Seen,
  branch: 'answer' | 'side' | undefined,
  endedByReturn = true,
): Record<string, JsonValue> {
  const call = seen.call;
  const record: Record<string, JsonValue> = { model: call.model, outcome: outcomeOf(seen) };
  if (seen.parsed !== undefined) {
    if (seen.parsed.responseModel) {
      record['responseModel'] = seen.parsed.responseModel;
    }
    if (seen.parsed.usage !== undefined && !seen.background) {
      record['usage'] = seen.parsed.usage;
    }
    const finish = seen.parsed.choices.at(-1)?.finishRaw;
    if (finish !== undefined && !seen.background) {
      record['finishReason'] = finish;
    }
  }
  if (seen.state === 'failed' && seen.failure !== undefined) {
    const kind = kindOf(seen) ?? 'transient';
    record['errorKind'] = kind;
    // `retryAfterMs` belongs only to a `transient` call (helper-api §`retryAfterMs`).
    if (seen.failure.retryAfterMs !== undefined && kind === 'transient') {
      record['retryAfterMs'] = seen.failure.retryAfterMs;
    }
    if (seen.failure.usage !== undefined) {
      record['usage'] = seen.failure.usage;
    }
  }
  if (branch !== undefined) {
    record['branch'] = branch;
  }
  if (
    endedByReturn &&
    seen.endedAt !== undefined &&
    seen.state !== 'unfinished' &&
    seen.state !== 'cut'
  ) {
    record['latencyMs'] = milliseconds(seen.endedAt - call.sentAt);
  }
  return record;
}

/** A failed call's `error` under `ModelCallError`'s names (helper-api §Target Function). */
function callError(seen: Seen): CallError | undefined {
  const failure = seen.failure;
  if (seen.state !== 'failed' || failure === undefined) {
    return undefined;
  }
  const retry = failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs };
  if (failure.status === undefined) {
    return { kind: failure.transport ?? 'disconnect', ...retry };
  }
  return {
    status: failure.status,
    ...(seen.error.type === undefined ? {} : { type: seen.error.type }),
    ...(seen.error.code === undefined ? {} : { code: seen.error.code }),
    ...retry,
  };
}

/** A call's view without response fields: an unfinished call, or a render request. */
export function requestView(call: CapturedCall): Call {
  const view = new Call(call.model, call.messages, toolNamesOf(call.body));
  SOURCES.set(view, call);
  return view;
}

/** The `Call` of a seen call; an unfinished call has no response fields. */
export function callView(seen: Seen, retriedValue: boolean): Call {
  const call = seen.call;
  if (seen.state === 'unfinished') {
    return requestView(call);
  }
  const first = seen.parsed?.choices[0];
  const usage = seen.failure?.usage ?? seen.parsed?.usage;
  const error = callError(seen);
  const view = new Call(call.model, call.messages, toolNamesOf(call.body), {
    ...(first !== undefined && seen.state === 'ok'
      ? { text: first.text, toolCalls: [...first.toolCalls] }
      : {}),
    ...(first?.finishRaw === undefined ? {} : { finishReason: first.finishRaw }),
    ...(usage === undefined ? {} : { usage }),
    outcome: outcomeOf(seen),
    ...(error === undefined ? {} : { error }),
    ...(seen.state === 'failed' ? { retried: retriedValue } : {}),
  });
  SOURCES.set(view, call);
  return view;
}

export function inSendOrder(calls: readonly CapturedCall[]): CapturedCall[] {
  return [...calls].sort((a, b) => a.sentAt - b.sentAt);
}

/** A request was sent in the failed call's branch after the failure ended. */
export function retried(seens: readonly Seen[], roots: readonly number[], index: number): boolean {
  const failure = seens[index]?.failure;
  if (failure === undefined) {
    return false;
  }
  return seens.some(
    (other, otherIndex) =>
      roots[otherIndex] === roots[index] && other.call.sentAt > failure.endedAt,
  );
}

/** The views of a trial's calls captured so far, in send order. */
export function trialViews(trial: Trial): Call[] {
  const seens = inSendOrder(trial.calls).map(freeze);
  const roots = branchRoots(seens);
  return seens.map((seen, index) => callView(seen, retried(seens, roots, index)));
}

// --- Call branches (data-model §Call Branches) -----------------------------------------------

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** For each call, the index of the first call of its branch. */
export function branchRoots(seens: readonly Seen[]): number[] {
  const roots: number[] = [];
  seens.forEach((later, index) => {
    roots.push(index);
    const conversation =
      later.call.api === 'responses' ? later.call.body['conversation'] : undefined;
    for (let earlierIndex = index - 1; earlierIndex >= 0; earlierIndex -= 1) {
      const earlier = seens[earlierIndex];
      if (earlier === undefined) {
        continue;
      }
      if (earlier.call.key === later.call.key) {
        roots[index] = roots[earlierIndex] ?? earlierIndex;
        break;
      }
      const sameConversation =
        earlier.call.api === 'responses' &&
        sameJson(earlier.call.body['conversation'], conversation);
      if (conversation !== undefined && conversation !== null && !sameConversation) {
        continue;
      }
      if (toolLoopStep(later, earlier)) {
        roots[index] = roots[earlierIndex] ?? earlierIndex;
        break;
      }
      if (conversation !== undefined && conversation !== null) {
        break;
      }
    }
  });
  return roots;
}

/** The later request continues the earlier response's tool call. */
function toolLoopStep(later: Seen, earlier: Seen): boolean {
  const api = later.call.api;
  if (api !== earlier.call.api || !endedInToolCall(earlier)) {
    return false;
  }
  if (canonicalJson(later.call.system) !== canonicalJson(earlier.call.system)) {
    return false;
  }
  if (!sameJson(later.call.tools, earlier.call.tools)) {
    return false;
  }
  const body = later.call.body;
  const previous = body['previous_response_id'];
  const conversation = body['conversation'];
  const chained =
    (previous !== undefined && previous !== null) ||
    (conversation !== undefined && conversation !== null);
  if (api === 'responses' && chained) {
    if (previous !== undefined && previous !== null && previous !== earlier.responseId) {
      return false;
    }
    const items = responsesInput(body);
    return items.length > 0 && items.every((item) => isToolResult(api, item));
  }
  const before = conversationItems(api, earlier.call.body);
  const after = conversationItems(api, body);
  if (after.length <= before.length) {
    return false;
  }
  if (before.some((item, position) => !sameJson(item, after[position]))) {
    return false;
  }
  return copiesAndResults(api, after.slice(before.length), outputItems(earlier));
}

function isToolResult(api: string, value: JsonValue): boolean {
  const item = asDict(value);
  if (api === 'chat-completions') {
    return item['role'] === 'tool' || item['role'] === 'function';
  }
  if (api === 'responses') {
    const type = item['type'];
    return typeof type === 'string' && RESULT_ITEM_TYPES.has(type);
  }
  const blocks = asList(item['content']);
  return (
    item['role'] === 'user' &&
    blocks.length > 0 &&
    blocks.every((block) => asDict(block)['type'] === 'tool_result')
  );
}

/**
 * What follows the earlier messages is only copies of the earlier response's output items and
 * tool results. A stream's output items are not read, so its copies are not compared.
 */
function copiesAndResults(
  api: string,
  extra: readonly JsonValue[],
  outputs: readonly JsonValue[] | undefined,
): boolean {
  const copies = extra.filter((item) => !isToolResult(api, item));
  let copied: string[];
  let known: string[] | undefined;
  if (api === 'responses') {
    copied = copies.map(outputKey);
    known = outputs?.map(outputKey);
  } else {
    if (copies.some((item) => asDict(item)['role'] !== 'assistant')) {
      return false;
    }
    if (api === 'chat-completions') {
      copied = copies.map(chatKey);
      known = outputs?.map(chatKey);
    } else {
      copied = copies.flatMap((item) => contentBlocks(item).map(blockKey));
      known = outputs?.map(blockKey);
    }
  }
  return known === undefined || isSubsequence(copied, known);
}

function isSubsequence(items: readonly string[], within: readonly string[]): boolean {
  let position = 0;
  return items.every((item) => {
    while (position < within.length) {
      position += 1;
      if (within[position - 1] === item) {
        return true;
      }
    }
    return false;
  });
}

function field(item: JsonObject, name: string): JsonValue {
  return Object.hasOwn(item, name) ? (item[name] ?? null) : null;
}

function chatKey(value: JsonValue): string {
  const item = asDict(value);
  const calls = asList(item['tool_calls']).map((entry) => {
    const call = asDict(entry);
    const fn = asDict(call['function']);
    return [field(call, 'id'), field(fn, 'name'), field(fn, 'arguments')];
  });
  return canonicalJson(['assistant', partsText(item['content']), calls]);
}

/** An output item by kind, text, tool-call ID, name, arguments and reasoning fields. */
function outputKey(value: JsonValue): string {
  const item = asDict(value);
  const type = item['type'];
  const kind: JsonValue =
    type !== undefined && type !== null && type !== '' && type !== false && type !== 0
      ? type
      : Object.hasOwn(item, 'role')
        ? 'message'
        : null;
  const text = kind === 'message' ? partsText(item['content']) : null;
  const arguments_ = Object.hasOwn(item, 'arguments')
    ? field(item, 'arguments')
    : field(item, 'input');
  const hasCallId =
    typeof kind === 'string' && (Object.hasOwn(RESULT_ITEMS, kind) || kind === 'tool_search_call');
  return canonicalJson([
    kind,
    text,
    hasCallId ? callIdOf(item) : null,
    field(item, 'name'),
    arguments_,
    field(item, 'encrypted_content'),
    field(item, 'signature'),
  ]);
}

function contentBlocks(value: JsonValue): readonly JsonValue[] {
  const content = asDict(value)['content'];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return asList(content);
}

function blockKey(value: JsonValue): string {
  const block = asDict(value);
  const text = Object.hasOwn(block, 'text') ? field(block, 'text') : field(block, 'thinking');
  return canonicalJson([
    field(block, 'type'),
    text,
    field(block, 'id'),
    field(block, 'name'),
    field(block, 'input'),
    field(block, 'signature'),
    field(block, 'data'),
  ]);
}

// --- Checking given values (helper-api §Checking `Result` and `ModelCallError` Values) -------

const FINAL_KINDS = ['model', 'fallback', 'discarded'] as const;
const FINISH_REASONS = ['stop', 'length', 'content_filter', 'other'] as const;
const USAGE_BUCKETS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;
const TRANSPORT_KINDS = ['connect', 'tls', 'disconnect', 'timeout'] as const;
const DISCARD_REASON_LIMIT = 200;

/** Stands for a `final` the `Result` left out, apart from an explicit `final: null`. */
const OMITTED = Symbol('omitted');

/**
 * An integer (helper-api §Shared Conventions): a number that is not a boolean, has no fractional
 * part and is at most 2^53 - 1 in absolute value.
 */
function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function oneOf<T extends string>(value: unknown, names: readonly T[]): value is T {
  return typeof value === 'string' && (names as readonly string[]).includes(value);
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Token buckets: keys among the five bucket names, values non-negative integers. */
function isUsage(value: unknown): value is Usage {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([name, count]) => oneOf(name, USAGE_BUCKETS) && wholeNumber(count) && count >= 0,
    )
  );
}

/** The given usage, or undefined when it breaks the rules of `isUsage`. */
function reportedUsage(value: unknown): Usage | undefined {
  return isUsage(value) ? { ...value } : undefined;
}

function isStages(value: unknown): value is readonly { name: string; text: string }[] {
  return (
    Array.isArray(value) &&
    Array.from(value as unknown[]).every(
      (stage) =>
        isPlainObject(stage) &&
        typeof stage['name'] === 'string' &&
        typeof stage['text'] === 'string',
    )
  );
}

/** A `Result`'s values: `null` and `undefined` are not given, except an explicit `final: null`. */
interface Given {
  readonly final: unknown;
  readonly kind: unknown;
  readonly discardReason: unknown;
  readonly stages: unknown;
  readonly raw: unknown;
  readonly answers: unknown;
  readonly finishReason: unknown;
  readonly stoppedEarly: unknown;
  readonly usage: unknown;
  readonly model: unknown;
  readonly modelSnapshot: unknown;
}

function givenField(fields: Readonly<Record<string, unknown>>, name: string): unknown {
  const value = fields[name];
  return value === null ? undefined : value;
}

function givenOf(value: Result): Given {
  const fields = (value as { fields?: Readonly<Record<string, unknown>> }).fields ?? {};
  const final = fields['final'];
  return {
    final: final === undefined ? OMITTED : final,
    kind: givenField(fields, 'kind'),
    discardReason: givenField(fields, 'discardReason'),
    stages: givenField(fields, 'stages'),
    raw: givenField(fields, 'raw'),
    answers: givenField(fields, 'answers'),
    finishReason: givenField(fields, 'finishReason'),
    stoppedEarly: givenField(fields, 'stoppedEarly'),
    usage: givenField(fields, 'usage'),
    model: givenField(fields, 'model'),
    modelSnapshot: givenField(fields, 'modelSnapshot'),
  };
}

function kindOfGiven(given: Given): unknown {
  return given.kind ?? 'model';
}

/**
 * A `Result` the helper can use; any other is adapter error A14. A `final` with kind `discarded`
 * is ignored.
 */
function validResult(given: Given): boolean {
  const kind = kindOfGiven(given);
  if (!oneOf(kind, FINAL_KINDS)) {
    return false;
  }
  if (kind !== 'discarded' && given.final !== OMITTED && typeof given.final !== 'string') {
    return false;
  }
  const texts = [given.raw, given.discardReason, given.model, given.modelSnapshot];
  if (texts.some((text) => text !== undefined && typeof text !== 'string')) {
    return false;
  }
  if (given.model === '' || given.modelSnapshot === '') {
    return false;
  }
  if (given.answers === 0 && kind === 'model') {
    return false;
  }
  const checks: [unknown, (value: unknown) => boolean][] = [
    [given.answers, (value) => wholeNumber(value) && value >= 0],
    [given.finishReason, (value) => oneOf(value, FINISH_REASONS)],
    [given.stoppedEarly, (value) => typeof value === 'boolean'],
    [given.usage, isUsage],
    [given.stages, isStages],
  ];
  return checks.every(([value, check]) => value === undefined || check(value));
}

/** `ModelCallError({ status })`: an integer from 100 to 599, else not given. */
function reportedStatus(value: unknown): number | undefined {
  return wholeNumber(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * `ModelCallError({ retryAfterMs })`: a number that is not a boolean, converted as a header's
 * wait is; not given otherwise.
 */
function reportedWait(value: unknown): number | undefined {
  return typeof value === 'number' ? waitMs(value) : undefined;
}

/** data-model §Matching Reported Failures: the `outcome` of a corrected or added call. */
function reportedOutcome(
  usage: Usage | undefined,
  corrected: boolean,
  status: number | undefined,
  kind: TransportKind | undefined,
): 'failed' | 'unanswered' {
  if (usage !== undefined) {
    return 'failed';
  }
  if (corrected || status === 200 || kind === 'disconnect' || kind === 'timeout') {
    return 'unanswered';
  }
  return 'failed';
}

// --- Outcome (data-model §Answers, §Outcome Decision, §Raw Cannot Be Determined, §Derived
// Result Fields; helper-api §Trial Warnings) ------------------------------------------------

const DATED_SUFFIX = /^-(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{8})$/;
const NO_ANSWER_TEXT = "No answer within the service's time limit.";

/** data-model §Variant Model Call: the variant model, or it followed only by a date. */
export function isVariantModel(model: string, variant: string): boolean {
  if (model === variant) {
    return true;
  }
  return model.startsWith(variant) && DATED_SUFFIX.test(model.slice(variant.length));
}

/** One answer: a `choices` item, a text response or an `answerTool` call. */
interface Answer {
  readonly index: number;
  readonly text: string;
  readonly finish: FinishReason;
}

/** How the target function ended. */
export interface FunctionEnd {
  readonly value?: string;
  readonly isFallback?: boolean;
  /** The thrown value, wrapped so that a thrown `undefined` still counts. */
  readonly error?: { readonly thrown: unknown };
  /** A return value that is not text, `fallback(text)` or `Result` (adapter error A14). */
  readonly notText?: boolean;
  /** The `Result` the function returned. */
  readonly result?: Result;
  /** The `ModelCallError` the function threw. */
  readonly thrown?: ModelCallError;
}

/** data-model §Answer, `answerTool` item 2. */
function toolAnswerText(args: string, key: string): string {
  const value = asDict(readJson(args))[key];
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** The trial's calls as the service had received them when the function returned. */
class Analysis {
  readonly target: Target;
  readonly variantModel: string;
  readonly isVariant: boolean[];
  readonly roots: number[];
  readonly chosen: boolean[] | undefined;
  readonly candidates: number[];
  readonly answerRoots: Set<number>;
  readonly answers: Answer[];

  constructor(
    readonly trial: Trial,
    readonly seens: readonly Seen[],
    readonly finals: readonly Seen[],
  ) {
    this.target = trial.target;
    this.variantModel = trial.variant.model;
    this.isVariant = seens.map((seen) => isVariantModel(seen.call.model, this.variantModel));
    this.roots = branchRoots(seens);
    const replyCall = this.target.replyCall;
    if (replyCall !== undefined) {
      const views = seens.map((seen, index) => callView(seen, retried(seens, this.roots, index)));
      this.chosen = views.map((view) => Boolean(replyCall(view)));
    }
    this.candidates = seens
      .map((_, index) => index)
      .filter((index) => this.isVariant[index] === true && (this.chosen?.[index] ?? true));
    this.answerRoots = new Set(this.candidates.map((index) => this.root(index)));
    this.answers = this.findAnswers();
  }

  seen(index: number): Seen {
    const seen = this.seens[index];
    if (seen === undefined) {
      throw new RangeError(`no call ${String(index)}`);
    }
    return seen;
  }

  root(index: number): number {
    return this.roots[index] ?? index;
  }

  // Answers

  private findAnswers(): Answer[] {
    const answers: Answer[] = [];
    const toolAnswered = new Set<number>();
    for (const index of this.candidates) {
      if (this.continuesToolAnswer(index, toolAnswered)) {
        continue;
      }
      answers.push(...this.answersOf(index));
      if (this.callsAnswerTool(index)) {
        toolAnswered.add(index);
      }
    }
    return answers;
  }

  answersOf(index: number): Answer[] {
    const seen = this.seen(index);
    if (seen.state !== 'ok' || seen.parsed === undefined || seen.background) {
      return [];
    }
    const found: Answer[] = [];
    const tool = this.target.answerTool;
    for (const choice of seen.parsed.choices) {
      const toolCall =
        tool === undefined ? undefined : choice.toolCalls.find((call) => call.name === tool[0]);
      const finish = protocolFinish(choice.finishRaw);
      if (tool !== undefined && toolCall !== undefined) {
        const limited = finish === 'length' || finish === 'content_filter';
        found.push({
          index,
          text: toolAnswerText(toolCall.arguments, tool[1]),
          finish: limited ? finish : 'stop',
        });
      } else if (!choice.toolEnd) {
        found.push({ index, text: choice.text, finish });
      }
    }
    return found;
  }

  private callsAnswerTool(index: number): boolean {
    const tool = this.target.answerTool;
    const parsed = this.seen(index).parsed;
    if (tool === undefined || parsed === undefined) {
      return false;
    }
    return parsed.choices.some((choice) => choice.toolCalls.some((call) => call.name === tool[0]));
  }

  /**
   * A response continued after the service sent a tool result for an `answerTool` call is not an
   * answer (data-model §Answer, item 4).
   */
  private continuesToolAnswer(index: number, answered: Set<number>): boolean {
    const later = this.seen(index);
    for (const earlier of [...answered].sort((a, b) => b - a)) {
      if (this.root(earlier) === this.root(index) && toolLoopStep(later, this.seen(earlier))) {
        answered.add(index);
        return true;
      }
    }
    return false;
  }

  /**
   * data-model §Outcome Row 6 Details: an SSE response that received its generation-end marker
   * counts as an answer, unless it ended in a tool call.
   */
  streamAnswer(index: number): boolean {
    const seen = this.seen(index);
    if (!seen.sse || !seen.generationEnd) {
      return false;
    }
    return this.target.answerTool !== undefined || !seen.streamToolEnd;
  }

  // Failures

  /**
   * data-model §Successful Calls and Unrecovered Failures. `strict`: for the matching-failure
   * candidate and the `call` check, an SSE response that ended before a generation-end marker is
   * not a successful call.
   */
  unrecovered(strict = false): number[] {
    const found: number[] = [];
    this.seens.forEach((seen, index) => {
      if (seen.state !== 'failed') {
        return;
      }
      const recovered = this.seens.some((candidate, other) => {
        if (other === index || this.root(other) !== this.root(index)) {
          return false;
        }
        if (candidate.state === 'unfinished' && other > index) {
          return true;
        }
        const cut = strict && candidate.sse && !candidate.generationEnd;
        return (
          successful(candidate) &&
          !cut &&
          (other > index || (candidate.endedAt ?? 0) > seen.call.sentAt)
        );
      });
      if (!recovered) {
        found.push(index);
      }
    });
    return found;
  }

  /** A captured call of the trial was sent after this failure ended. */
  followed(index: number): boolean {
    const ended = this.seen(index).endedAt ?? 0;
    return this.seens.some((seen) => seen.call.sentAt > ended);
  }

  latest(indices: readonly number[]): number {
    return latestBy(indices, (index) => this.seen(index).endedAt ?? 0);
  }

  /** The latest-ended failure of the answer branch when there is one, else of all. */
  decidingFailure(indices: readonly number[]): number {
    const inAnswer = indices.filter((index) => this.answerRoots.has(this.root(index)));
    return this.latest(inAnswer.length > 0 ? inAnswer : indices);
  }

  // Answer candidate calls

  /** data-model Outcome row 5: why the answer candidate calls cannot be determined. */
  row5Cause(): 'A3-a' | 'A3-b' | 'A3-c' | 'A3-d' | undefined {
    if (this.chosen !== undefined && this.candidates.length === 0) {
      return this.chosen.some(Boolean) ? 'A3-a' : 'A3-b';
    }
    if (this.chosen === undefined && this.answerRoots.size >= 2) {
      return 'A3-c';
    }
    const roots = new Set(this.answers.map((answer) => this.root(answer.index)));
    const systems = new Set([...roots].map((root) => canonicalJson(this.seen(root).call.system)));
    return systems.size > 1 ? 'A3-d' : undefined;
  }

  chosenModels(): string[] {
    return (this.chosen ?? []).flatMap((flag, index) =>
      flag ? [this.seen(index).call.model] : [],
    );
  }

  branchOf(index: number, decided: boolean, allSide: boolean): 'answer' | 'side' | undefined {
    if (allSide) {
      return 'side';
    }
    if (!decided) {
      return undefined;
    }
    return this.answerRoots.has(this.root(index)) ? 'answer' : 'side';
  }

  branchDecided(): boolean {
    return this.isVariant.some(Boolean) && this.row5Cause() === undefined;
  }

  // Raw Cannot Be Determined

  /** data-model §Raw Cannot Be Determined rows 2 and 3. */
  undeterminable(): 'A5' | 'A6' | undefined {
    for (const index of this.candidates) {
      const seen = this.seen(index);
      if (seen.background) {
        return 'A6';
      }
      if (unparsed(seen)) {
        return 'A5';
      }
    }
    return undefined;
  }
}

/** The index whose key is largest; with equal keys, the largest index. */
function latestBy(indices: readonly number[], key: (index: number) => number): number {
  let best = indices[0] ?? 0;
  for (const index of indices) {
    const ended = key(index);
    const bestEnded = key(best);
    if (ended > bestEnded || (ended === bestEnded && index > best)) {
      best = index;
    }
  }
  return best;
}

/**
 * A stream response or a body that was not fully read. SSE responses that failed before the
 * generation-end marker through a provider error event or a drop are not.
 */
function unparsed(seen: Seen): boolean {
  if (seen.state === 'unread' || seen.state === 'unfinished') {
    return seen.hadHeaders;
  }
  if (seen.state === 'failed' && seen.sse && seen.failure !== undefined) {
    return seen.generationEnd || seen.failure.transport === 'timeout';
  }
  return false;
}

/** The `generate` response: a result, or an adapter error's message and data. */
export type Decided =
  | { readonly kind: 'result'; readonly result: JsonObject }
  | { readonly kind: 'error'; readonly message: string; readonly data: JsonObject };

type CallRecord = Record<string, JsonValue>;

export function failureMessage(seen: Seen): string {
  const failure = seen.failure;
  if (failure?.status !== undefined && failure.status !== 200) {
    const detail = seen.error.message;
    return `HTTP ${String(failure.status)}${detail ? `: ${detail}` : ''}`;
  }
  return seen.error.message || failure?.text || 'The model call failed.';
}

/** The values a result is built from (data-model §Derived Result Fields). */
interface ResultSources {
  readonly records: CallRecord[] | undefined;
  readonly snapshot: number | undefined;
  readonly usageIndex: number | undefined;
  readonly request: CapturedCall | undefined;
  readonly w2System: readonly string[] | undefined;
  readonly w2TextOnly: boolean;
  readonly hasAnswer: boolean;
}

class Decision {
  /** [ID number, sentence]: helper-api §Trial Warnings lists them in ascending ID order. */
  private readonly warnings: [number, string][] = [];
  /** The `Result` the function returned, its values not yet checked. */
  readonly given: Given | undefined;
  value: string | undefined;
  isFallback: boolean;
  /** A `Result` without `final` and with kind `model` ships the raw answer. */
  finalIsRaw = false;

  constructor(
    readonly a: Analysis,
    private readonly end: FunctionEnd,
    public discarded: boolean,
    private readonly latencyMs: number,
  ) {
    this.given = end.result === undefined ? undefined : givenOf(end.result);
    this.value = end.value;
    this.isFallback = end.isFallback === true;
  }

  /** It raised an exception that is not in `discardOn`. */
  private get raised(): boolean {
    return this.end.error !== undefined && !this.discarded;
  }

  /** The message, in its form naming the exception when the function raised one. */
  private withException(id: MessageId, placeholders: Record<string, string> = {}): string {
    if (this.raised && this.end.error !== undefined) {
      const exception = exceptionText(this.end.error.thrown);
      return message(`${id}-raised` as MessageId, { exception, ...placeholders });
    }
    return message(id, placeholders);
  }

  /**
   * Ends the function as its valid `Result` says (data-model §Derived Result Fields, `final`):
   * kind `discarded` counts as a `discard_on` exception.
   */
  private takeResult(given: Given): void {
    const kind = kindOfGiven(given);
    this.isFallback = kind === 'fallback';
    this.discarded = kind === 'discarded';
    if (typeof given.final === 'string' && kind !== 'discarded') {
      this.value = given.final;
    }
    this.finalIsRaw = given.final === OMITTED && kind === 'model';
  }

  /** `discardReason`: the given reason or the exception's, cut to 200 code points. */
  private discardText(): string | undefined {
    if (this.given !== undefined) {
      const reason = this.given.discardReason;
      return typeof reason === 'string'
        ? Array.from(reason).slice(0, DISCARD_REASON_LIMIT).join('')
        : undefined;
    }
    return this.end.error === undefined ? undefined : discardReason(this.end.error.thrown);
  }

  // Records and shared fields

  records(allSide = false): CallRecord[] {
    const decided = this.a.branchDecided();
    return this.a.finals.map((final, index) =>
      callRecord(
        final,
        this.a.branchOf(index, decided, allSide),
        this.a.seen(index).state !== 'unfinished',
      ),
    );
  }

  private cost(allSide = false): Record<string, JsonValue> {
    const fields: Record<string, JsonValue> = {};
    if (this.a.finals.length > 0) {
      fields['calls'] = this.records(allSide);
    }
    const usage = sumUsage(this.a.finals.map((final) => callRecord(final, undefined)));
    if (usage !== undefined) {
      fields['usage'] = usage;
    }
    return fields;
  }

  adapterError(text: string, capturedRaw?: string): Decided {
    const data = this.cost();
    if (capturedRaw !== undefined) {
      data['capturedRaw'] = capturedRaw;
    }
    return { kind: 'error', message: text, data };
  }

  /**
   * A failure result; `retryAfterMs` only for a `transient` one (helper-api §`retryAfterMs`).
   * `cost` replaces the calls' own `calls` and `usage`.
   */
  failure(
    kind: ErrorKind,
    text: string,
    retryAfter: number | undefined,
    cost?: Record<string, JsonValue>,
  ): Decided {
    const error: Record<string, JsonValue> = { kind, message: text };
    if (retryAfter !== undefined && kind === 'transient') {
      error['retryAfterMs'] = retryAfter;
    }
    const result: Record<string, JsonValue> = {
      error,
      latencyMs: this.latencyMs,
      ...(cost ?? this.cost()),
    };
    this.addUsageWarning();
    if (this.warnings.length > 0) {
      result['warnings'] = this.orderedWarnings();
    }
    return { kind: 'result', result };
  }

  callFailure(seen: Seen): Decided {
    return this.failure(
      kindOf(seen) ?? 'transient',
      failureMessage(seen),
      seen.failure?.retryAfterMs,
    );
  }

  // The decision

  decide(): Decided {
    const { a, end } = this;
    if (a.trial.outsideContext) {
      return this.adapterError(message('A10'));
    }
    const config = configFailure(a.finals);
    if (config !== undefined) {
      return this.callFailure(config);
    }
    if (end.thrown !== undefined) {
      return this.decideThrown(end.thrown);
    }
    const given = this.given;
    if (end.notText === true || (given !== undefined && !validResult(given))) {
      return this.adapterError(message('A14'), this.capturedRaw());
    }
    if (given !== undefined) {
      this.takeResult(given);
      if (typeof given.raw === 'string') {
        return new RawDecision(this, given, given.raw).decide();
      }
      if (given.stoppedEarly === true) {
        this.warn('W7');
      }
    }
    if (a.seens.length === 0) {
      return { kind: 'error', message: this.withException('A1'), data: {} };
    }
    const unrecovered = a.unrecovered();
    if (unrecovered.length > 0 && (this.raised || a.candidates.length === 0)) {
      const pool = this.raised ? unrecovered : unrecovered.filter((index) => !a.followed(index));
      if (pool.length > 0) {
        return this.callFailure(a.seen(a.decidingFailure(pool)));
      }
    }
    if (!a.isVariant.some(Boolean)) {
      const models = modelList(a.seens.map((seen) => seen.call.model));
      return this.adapterError(this.withException('A2', { model: a.variantModel, models }));
    }
    const cause = a.row5Cause();
    if (cause !== undefined) {
      if ((cause === 'A3-a' || cause === 'A3-b') && (this.isFallback || this.discarded)) {
        return this.answered('', 0, 'other', undefined, true);
      }
      const models = cause === 'A3-a' ? modelList(a.chosenModels()) : '';
      return this.adapterError(
        models === '' ? this.withException(cause) : this.withException(cause, { models }),
      );
    }
    const row6 = this.row6(unrecovered);
    if (row6 !== undefined) {
      return row6;
    }
    if (this.raised && end.error !== undefined) {
      return this.adapterError(
        message('row9', { exception: exceptionText(end.error.thrown) }),
        this.capturedRaw(),
      );
    }
    const undeterminable = a.undeterminable();
    if (undeterminable !== undefined) {
      return this.adapterError(message(undeterminable));
    }
    if (a.answers.length === 0) {
      if (!(this.isFallback || this.discarded)) {
        return this.adapterError(message('A4'));
      }
      return this.answered(this.lastCandidateText(), 0, 'other');
    }
    return this.answeredFromAnswers();
  }

  // A thrown `ModelCallError` (data-model §Matching Reported Failures)

  /**
   * After Outcome row 1: A12 unless exactly one of `status`, `kind` and `call` is given and a
   * given `status` or `kind` is one of its values, A13 for a `call` that is not a failure of
   * this trial the service received, else the trial is the failure of the matched or added call.
   */
  private decideThrown(thrown: ModelCallError): Decided {
    const a = this.a;
    const fields = (thrown as { fields?: Readonly<Record<string, unknown>> }).fields ?? {};
    const field = (name: string): unknown => givenField(fields, name);
    const status = reportedStatus(field('status'));
    const thrownKind = field('kind');
    const kind = oneOf(thrownKind, TRANSPORT_KINDS) ? thrownKind : undefined;
    const given = ['status', 'kind', 'call'].map((name) => field(name) !== undefined);
    if (
      given.filter(Boolean).length !== 1 ||
      (given[0] === true && status === undefined) ||
      (given[1] === true && kind === undefined)
    ) {
      return this.adapterError(message('A12'));
    }
    const call = field('call');
    if (call !== undefined) {
      const source =
        typeof call === 'object' && call !== null ? SOURCES.get(call as Call) : undefined;
      const index = a.seens.findIndex((seen) => seen.call === source);
      if (source === undefined || index === -1 || !this.receivedFailure(index)) {
        return this.adapterError(message('A13'));
      }
      return this.matchedFailure(index, undefined);
    }
    const thrownMessage = field('message');
    let text = typeof thrownMessage === 'string' ? trimText(thrownMessage) : '';
    if (text === '') {
      text = status === undefined ? String(kind) : `HTTP ${String(status)}`;
    }
    const usage = reportedUsage(field('usage'));
    const wait = reportedWait(field('retryAfterMs'));
    const type = textOrUndefined(field('type'));
    const code = textOrUndefined(field('code'));
    const errorMessage = textOrUndefined(thrownMessage);
    const error: ErrorObject = {
      ...(type === undefined ? {} : { type }),
      ...(code === undefined ? {} : { code }),
      ...(errorMessage === undefined ? {} : { message: errorMessage }),
    };
    const decidedKind = classify(status, error, kind);
    // An empty `model` counts as not given (helper-api §`ModelCallError`).
    const model = textOrUndefined(field('model')) || a.variantModel;
    const searched = this.callsTo(model, a.chosen);
    const candidates: [number, 'started' | 'failure' | 'unfinished'][] = [];
    if (status === 200 || kind === 'disconnect' || kind === 'timeout') {
      const started = searched.filter((index) => startedResponse(a.seen(index)));
      const last = started.at(-1);
      if (last !== undefined) {
        candidates.push([last, 'started']);
      }
    }
    const unrecovered = new Set(a.unrecovered(true));
    const failures = searched.filter(
      (index) => unrecovered.has(index) && matches(a.seen(index), status, kind),
    );
    const lastFailure = failures.at(-1);
    if (lastFailure !== undefined) {
      candidates.push([lastFailure, 'failure']);
    }
    if (kind === 'timeout') {
      const unfinished = searched.filter((index) => a.seen(index).state === 'unfinished');
      const last = unfinished.at(-1);
      if (last !== undefined) {
        candidates.push([last, 'unfinished']);
      }
    }
    let index = -1;
    let how: 'started' | 'failure' | 'unfinished' | 'none' = 'none';
    for (const [candidate, candidateHow] of candidates) {
      if (candidate > index) {
        index = candidate;
        how = candidateHow;
      }
    }
    if (how === 'failure') {
      return this.matchedFailure(index, decidedKind);
    }
    if (how === 'none') {
      this.w10(model, status, kind);
    }
    const records = this.records();
    let record: CallRecord = { model, errorKind: decidedKind };
    if (how === 'started') {
      record = records[index] ?? record;
      record['errorKind'] = decidedKind;
      delete record['finishReason'];
    }
    if (how === 'started' || how === 'none') {
      record['outcome'] = reportedOutcome(usage, how === 'started', status, kind);
      if (wait !== undefined && decidedKind === 'transient') {
        record['retryAfterMs'] = wait;
      }
      if (usage !== undefined) {
        record['usage'] = usage;
      }
    }
    if (how === 'none' && a.seens.length > 0) {
      records.push(record);
    }
    const cost: Record<string, JsonValue> =
      a.seens.length === 0 ? (usage === undefined ? {} : { usage }) : recordsCost(records);
    return this.failure(decidedKind, text, wait, cost);
  }

  /**
   * helper-api §The `call` Check: an unrecovered failure, not resent, and with `replyCall` one it
   * is true for.
   */
  private receivedFailure(index: number): boolean {
    const a = this.a;
    if (!a.unrecovered(true).includes(index)) {
      return false;
    }
    if (retried(a.seens, a.roots, index)) {
      return false;
    }
    return a.chosen === undefined || a.chosen[index] === true;
  }

  /**
   * The matching-failure candidate decides by its own kind and `retryAfterMs`, unless the thrown
   * value classifies as `config`, which makes the trial and the call `config`.
   */
  private matchedFailure(index: number, thrownKind: ErrorKind | undefined): Decided {
    const seen = this.a.seen(index);
    if (thrownKind === 'config') {
      const records = this.records();
      const record = records[index];
      if (record !== undefined) {
        record['errorKind'] = 'config';
        delete record['retryAfterMs'];
      }
      return this.failure('config', failureMessage(seen), undefined, recordsCost(records));
    }
    return this.failure(
      kindOf(seen) ?? 'transient',
      failureMessage(seen),
      seen.failure?.retryAfterMs,
    );
  }

  /**
   * The calls a thrown failure of `model` is matched among: to the variant model, only those
   * `replyCall` is true for (when `chosen` is given).
   */
  private callsTo(model: string, chosen: readonly boolean[] | undefined): number[] {
    const a = this.a;
    if (model === a.variantModel) {
      return a.seens.flatMap((_, index) =>
        a.isVariant[index] === true && (chosen === undefined || chosen[index] === true)
          ? [index]
          : [],
      );
    }
    return a.seens.flatMap((seen, index) => (seen.call.model === model ? [index] : []));
  }

  /**
   * W10: no candidate, and every captured failure of that model matching a thrown `status` or a
   * `kind` other than `timeout` was resent.
   */
  private w10(model: string, status: number | undefined, kind: TransportKind | undefined): void {
    const a = this.a;
    if (status === undefined && kind === 'timeout') {
      return;
    }
    if (model === a.variantModel && a.chosen !== undefined && !a.chosen.some(Boolean)) {
      return;
    }
    const matching = this.callsTo(model, undefined).filter((index) =>
      matches(a.seen(index), status, kind),
    );
    if (matching.length > 0 && matching.every((index) => retried(a.seens, a.roots, index))) {
      this.warn('W10');
    }
  }

  private row6(unrecovered: readonly number[]): Decided | undefined {
    const a = this.a;
    const answered = a.answers.length > 0 || a.candidates.some((index) => a.streamAnswer(index));
    if (answered) {
      return undefined;
    }
    const inAnswer = unrecovered.filter((index) => a.answerRoots.has(a.root(index)));
    const unfinished = a.seens.flatMap((seen, index) =>
      seen.state === 'unfinished' && a.answerRoots.has(a.root(index)) ? [index] : [],
    );
    if (unfinished.length > 0 && (inAnswer.length > 0 || !this.raised)) {
      return this.failure('timeout', NO_ANSWER_TEXT, undefined);
    }
    if (inAnswer.length > 0) {
      return this.callFailure(a.seen(a.latest(inAnswer)));
    }
    return undefined;
  }

  /** Outcome row 9: the first answer, else the text of the last successful response. */
  private capturedRaw(): string | undefined {
    const first = this.a.answers[0];
    if (first !== undefined) {
      return first.text;
    }
    const texts = this.a.seens.flatMap((seen) => {
      const choice = seen.state === 'ok' ? seen.parsed?.choices[0] : undefined;
      return choice === undefined ? [] : [choice.text];
    });
    return texts.at(-1);
  }

  private lastCandidateText(): string {
    const texts = this.a.candidates.flatMap((index) => {
      const seen = this.a.seen(index);
      const choice = seen.state === 'ok' ? seen.parsed?.choices[0] : undefined;
      return choice === undefined ? [] : [choice.text];
    });
    return texts.at(-1) ?? '';
  }

  // Results with an answer (Outcome rows 7 and 8)

  private answeredFromAnswers(): Decided {
    const answers = this.a.answers;
    const first = answers[0];
    const last = answers.at(-1);
    if (first === undefined || last === undefined) {
      throw new RangeError('no answer');
    }
    if (
      this.given?.finishReason === undefined &&
      last.finish !== 'stop' &&
      this.earlierStop(last)
    ) {
      this.warn('W3');
    }
    return this.answered(first.text, answers.length, last.finish, first.index);
  }

  /**
   * W3: an earlier answer of the same request (an earlier `choices` item, an answer of a request
   * with the same body) ended with `stop`.
   */
  earlierStop(last: Answer, answers: readonly Answer[] = this.a.answers): boolean {
    const key = this.a.seen(last.index).call.key;
    return answers
      .slice(0, -1)
      .some((answer) => answer.finish === 'stop' && this.a.seen(answer.index).call.key === key);
  }

  private answered(
    raw: string,
    answers: number,
    finish: FinishReason,
    rawIndex?: number,
    allSide = false,
  ): Decided {
    const a = this.a;
    const [snapshot, request] = this.rawSources(rawIndex);
    const first = a.answers[0];
    return this.resultOf(raw, answers, finish, {
      records: a.finals.length > 0 ? this.records(allSide) : undefined,
      snapshot,
      usageIndex: snapshot,
      request: request === undefined ? undefined : a.seen(request).call,
      w2System: first === undefined ? undefined : a.seen(a.root(first.index)).call.system,
      w2TextOnly: false,
      hasAnswer: answers > 0,
    });
  }

  /**
   * A result with the shipped text, the values a `Result` gives over the helper's (data-model
   * §Derived Result Fields) and the trial warnings.
   */
  resultOf(raw: string, answers: number, finish: string, sources: ResultSources): Decided {
    const given = this.given;
    const finalKind = this.discarded ? 'discarded' : this.isFallback ? 'fallback' : 'model';
    const result: Record<string, JsonValue> = {
      raw,
      answers,
      finalKind,
      latencyMs: this.latencyMs,
      finishReason: finish,
    };
    if (this.discarded) {
      const reason = this.discardText();
      if (reason !== undefined) {
        result['discardReason'] = reason;
      }
    } else if (this.value !== undefined) {
      result['final'] = this.value;
    } else {
      result['final'] = this.finalIsRaw ? raw : '';
    }
    if (sources.snapshot !== undefined) {
      const model = this.a.seen(sources.snapshot).parsed?.responseModel;
      if (model) {
        result['modelSnapshot'] = model;
      }
    }
    if (sources.request !== undefined) {
      result['fingerprint'] = renderFingerprint(sources.request.messages, sources.request.tools);
    }
    let usage: Usage | undefined;
    if (given !== undefined) {
      if (wholeNumber(given.answers)) {
        result['answers'] = given.answers;
      }
      if (typeof given.finishReason === 'string') {
        result['finishReason'] = given.finishReason;
      }
      if (typeof given.modelSnapshot === 'string') {
        result['modelSnapshot'] = given.modelSnapshot;
      }
      if (isStages(given.stages)) {
        result['stages'] = given.stages.map((stage) => ({ name: stage.name, text: stage.text }));
      }
      usage = reportedUsage(given.usage);
    }
    const records = sources.records;
    if (records !== undefined) {
      const index = sources.usageIndex;
      const record = index === undefined ? undefined : records[index];
      if (usage !== undefined && index !== undefined && record !== undefined) {
        record['usage'] = usage;
        if (index < this.a.seens.length && this.a.seen(index).state === 'failed') {
          record['outcome'] = 'failed';
        }
      }
      Object.assign(result, recordsCost(records));
    } else if (usage !== undefined) {
      result['usage'] = usage;
    }
    if (sources.hasAnswer && (finalKind === 'fallback' || finalKind === 'discarded')) {
      this.w1();
    }
    if (finalKind === 'model' && (sources.w2System !== undefined || sources.w2TextOnly)) {
      this.w2(typeof result['final'] === 'string' ? result['final'] : '', sources.w2System);
    }
    this.addUsageWarning();
    result['warnings'] = this.orderedWarnings();
    return { kind: 'result', result };
  }

  /**
   * The call whose response model is `modelSnapshot` and the call whose request gives the
   * fingerprint (data-model §Derived Result Fields): with an answer, the first answer's call and
   * the first request of its branch; with none, the last successful answer candidate call and the
   * first answer candidate request.
   */
  private rawSources(rawIndex: number | undefined): [number | undefined, number | undefined] {
    if (rawIndex !== undefined) {
      return [rawIndex, this.a.root(rawIndex)];
    }
    const candidates = this.a.candidates;
    const succeeded = candidates.filter((index) => successful(this.a.seen(index)));
    return [succeeded.at(-1), candidates[0]];
  }

  // Warnings

  warn(id: MessageId, placeholders: Record<string, string> = {}): void {
    const number = Number(id.slice(1).split('-')[0]);
    this.warnings.push([number, message(id, placeholders)]);
  }

  private orderedWarnings(): string[] {
    return [...this.warnings].sort((x, y) => x[0] - y[0]).map(([, text]) => text);
  }

  private addUsageWarning(): void {
    if (this.a.finals.some((final) => final.parsed?.negativeInput === true)) {
      this.warn('W9');
    }
  }

  private w1(): void {
    const a = this.a;
    const transient = a
      .unrecovered()
      .filter((index) => kindOf(a.seen(index)) === 'transient' && !a.followed(index));
    if (transient.length === 0) {
      return;
    }
    const index = a.latest(transient);
    if (a.isVariant[index] === true) {
      this.warn('W1-variant');
    } else {
      this.warn('W1', { model: a.seen(index).call.model });
    }
  }

  /**
   * W2: another model's answer with the shipped text, or from a branch whose first request has
   * the answer branch's system (`system` undefined: the text only).
   */
  private w2(shipped: string, system: readonly string[] | undefined): void {
    const a = this.a;
    const answerSystem = system === undefined ? undefined : canonicalJson([...system]);
    for (const [index, seen] of a.seens.entries()) {
      if (a.isVariant[index] === true || seen.state !== 'ok') {
        continue;
      }
      for (const answer of a.answersOf(index)) {
        const sameText = trimText(answer.text) === trimText(shipped);
        const sameSystem =
          answerSystem !== undefined &&
          canonicalJson(a.seen(a.root(index)).call.system) === answerSystem;
        if (sameText || sameSystem) {
          this.warn('W2', { model: seen.call.model });
          return;
        }
      }
    }
  }
}

/** An unread response; an SSE one only without a generation-end marker. */
function startedResponse(seen: Seen): boolean {
  return seen.state === 'unread' && !(seen.sse && seen.generationEnd);
}

/**
 * A failure that matches the thrown value: an error response of that status, or with `kind` a
 * failure without an error response.
 */
function matches(seen: Seen, status: number | undefined, kind: TransportKind | undefined): boolean {
  if (seen.state !== 'failed' || seen.failure === undefined) {
    return false;
  }
  if (status !== undefined) {
    return seen.failure.status === status;
  }
  return kind !== undefined && seen.failure.status === undefined;
}

// --- When the adapter gives raw (data-model §When the Adapter Gives Raw) ---------------------

type RawSource = 'matched' | 'unread';

/**
 * The trial of a valid `Result` with `raw`, after Outcome row 1. Cut streams are taken by the view
 * the given values choose (data-model §Cut Streams).
 */
class RawDecision {
  private readonly a: Analysis;
  private readonly kind: string;
  private readonly empty: boolean;
  private readonly fallback: boolean;
  private readonly stopped: boolean;
  private readonly honoured: boolean;
  private readonly view: 1 | 2 | 3 | 5;
  private readonly searched: number[];
  private readonly ignored: Set<number>;
  private readonly live: number[];
  private readonly cut: Set<number>;
  /** Cut streams taken as `timeout` failures (view 1, and view 3 apart from unread ones). */
  private readonly cutFailures: Set<number>;
  /** Unread responses after the failure check. */
  private readonly unread: Set<number>;
  private readonly answers: Answer[];
  private readonly failureEnds: Map<number, number>;
  private readonly unrecovered: number[];
  private readonly unfinished: number[];

  constructor(
    private readonly d: Decision,
    private readonly given: Given,
    private readonly raw: string,
  ) {
    const a = d.a;
    this.a = a;
    this.kind = String(kindOfGiven(given));
    this.empty = isEmptyText(raw);
    this.fallback = this.kind === 'fallback' || this.kind === 'discarded';
    this.stopped = given.stoppedEarly === true;
    this.honoured = this.stopped && !this.empty && this.kind === 'model';
    const zero = given.answers === 0;
    if (this.empty && zero && this.fallback) {
      this.view = 5;
    } else if (!this.empty && this.fallback) {
      this.view = 2;
    } else {
      this.view = this.honoured ? 3 : 1;
    }
    this.searched = [...a.candidates];
    this.ignored = this.view === 5 ? this.view5Ignored() : new Set();
    this.live = this.searched.filter((index) => !this.ignored.has(index));
    this.cut = new Set(this.live.filter((index) => isCut(a.seen(index))));
    this.cutFailures = new Set(
      [...this.cut].filter(
        (index) => this.view === 1 || (this.view === 3 && a.seen(index).state !== 'unread'),
      ),
    );
    this.unread = new Set([
      ...this.live.filter((index) => a.seen(index).state === 'unread'),
      ...this.cut,
    ]);
    if (this.kind === 'model') {
      for (const index of this.live) {
        if (failedAfterMarker(a.seen(index))) {
          this.unread.add(index);
        }
      }
    }
    this.answers = a.answers.filter((answer) => !this.ignored.has(answer.index));
    this.failureEnds = new Map(
      this.live
        .filter(
          (index) =>
            (a.seen(index).state === 'failed' && !this.unread.has(index)) ||
            this.cutFailures.has(index),
        )
        .map((index) => [index, this.ended(index)]),
    );
    this.unrecovered = this.unrecoveredOf(
      this.failureEnds,
      new Set([...this.cutFailures, ...this.ignored]),
    );
    this.unfinished = this.live.filter(
      (index) => a.seen(index).state === 'unfinished' && !this.cut.has(index),
    );
  }

  // Calls under the chosen view

  /** When the call ended; a cut stream still being read, when the service last read it. */
  private ended(index: number): number {
    const seen = this.a.seen(index);
    return seen.endedAt ?? seen.readAt ?? this.a.trial.functionEndedAt ?? performance.now();
  }

  /**
   * View 5: cut streams, calls that failed with `timeout`, unfinished calls, and a failure
   * followed by another searched call sent after it ended.
   */
  private view5Ignored(): Set<number> {
    const a = this.a;
    const ignored = new Set(
      this.searched.filter((index) => {
        const seen = a.seen(index);
        return isCut(seen) || kindOf(seen) === 'timeout' || seen.state === 'unfinished';
      }),
    );
    for (const index of this.searched) {
      if (
        a.seen(index).state === 'failed' &&
        this.searched.some((other) => a.seen(other).call.sentAt > this.ended(index))
      ) {
        ignored.add(index);
      }
    }
    return ignored;
  }

  /**
   * data-model §Successful Calls and Unrecovered Failures over `failures`, where the calls in
   * `unsuccessful` are not successful calls.
   */
  private unrecoveredOf(failures: Map<number, number>, unsuccessful: Set<number>): number[] {
    const a = this.a;
    const found: number[] = [];
    for (const index of [...failures.keys()].sort((x, y) => x - y)) {
      const sent = a.seen(index).call.sentAt;
      const recovered = a.seens.some((seen, other) => {
        if (other === index || a.root(other) !== a.root(index)) {
          return false;
        }
        if (failures.has(other) || unsuccessful.has(other)) {
          return false;
        }
        if (seen.state === 'unfinished' && other > index) {
          return true;
        }
        return (
          (successful(seen) || this.unread.has(other)) &&
          (other > index || (seen.endedAt ?? 0) > sent)
        );
      });
      if (!recovered) {
        found.push(index);
      }
    }
    return found;
  }

  /**
   * An answer, or a stream that received a generation-end marker (one that ended in a tool call
   * only with `answerTool`).
   */
  private received(index: number): boolean {
    if (this.answers.some((answer) => answer.index === index)) {
      return true;
    }
    const seen = this.a.seen(index);
    const tool = this.a.target.answerTool;
    return seen.sse && seen.generationEnd && (tool !== undefined || !seen.streamToolEnd);
  }

  // The order of checks

  decide(): Decided {
    const { d, a, given } = this;
    if (this.stopped && !this.honoured) {
      d.warn('W7');
    }
    if (given.answers === 0 && this.live.some((index) => this.received(index))) {
      return d.adapterError(message('A8'));
    }
    const decided = this.live.length > 0 ? this.failureCheck() : this.noSearchedCalls();
    if (decided !== undefined) {
      return decided;
    }
    const matching = this.answers.find((answer) => trimText(answer.text) === trimText(this.raw));
    if (matching !== undefined) {
      return this.checked(matching.index, 'matched');
    }
    if (this.unread.size > 0) {
      return this.checked(Math.max(...this.unread), 'unread');
    }
    const exception =
      given.model === undefined &&
      this.empty &&
      this.fallback &&
      a.isVariant.some(Boolean) &&
      this.answers.length === 0;
    if (given.model === undefined && !exception) {
      const models = modelList(a.seens.map((seen) => seen.call.model));
      return d.adapterError(message('A7', { model: a.variantModel, models }));
    }
    if (!this.resultModelIsVariant()) {
      return this.wrongResultModel();
    }
    return this.uncaptured(exception);
  }

  private resultModelIsVariant(): boolean {
    const model = textOrUndefined(this.given.model);
    return model === undefined || isVariantModel(model, this.a.variantModel);
  }

  /** Outcome row 4 applied to `Result(model=)`. */
  private wrongResultModel(): Decided {
    const models = modelList([textOrUndefined(this.given.model) ?? '']);
    const text = message('A2-result-model', { model: this.a.variantModel, models });
    return this.noBranchError(text);
  }

  /** An adapter error of Outcome row 4 or 5, whose calls carry no `branch`. */
  private noBranchError(text: string): Decided {
    const a = this.a;
    const records = a.finals.map((final, index) =>
      callRecord(final, undefined, a.seen(index).state !== 'unfinished'),
    );
    return { kind: 'error', message: text, data: records.length > 0 ? recordsCost(records) : {} };
  }

  /**
   * data-model §Failure Check: an unrecovered failure or an unfinished call among the searched
   * calls, no unread response, and no answer the given raw can stand for.
   */
  private failureCheck(): Decided | undefined {
    if (this.unrecovered.length === 0 && this.unfinished.length === 0) {
      return undefined;
    }
    const tool = this.a.target.answerTool;
    for (const index of this.unread) {
      if (this.cutFailures.has(index)) {
        continue;
      }
      const seen = this.a.seen(index);
      if (tool !== undefined || !(seen.sse && seen.streamToolEnd)) {
        return undefined;
      }
    }
    if (
      this.answers.length > 0 &&
      !(this.empty && !this.answers.some((answer) => isEmptyText(answer.text)))
    ) {
      return undefined;
    }
    return this.failed(false);
  }

  /**
   * data-model §No Searched Calls: an empty raw without `Result(model=)` is the unrecovered
   * failure Outcome row 3 would take.
   */
  private noSearchedCalls(): Decided | undefined {
    const a = this.a;
    if (!this.empty || this.given.model !== undefined) {
      return undefined;
    }
    const failures = new Map(
      a.seens.flatMap((seen, index) =>
        seen.state === 'failed' && !this.ignored.has(index)
          ? [[index, this.ended(index)] as const]
          : [],
      ),
    );
    const pool = this.unrecoveredOf(failures, this.ignored).filter((index) => !a.followed(index));
    if (pool.length === 0) {
      return undefined;
    }
    return this.d.callFailure(a.seen(a.decidingFailure(pool)));
  }

  /**
   * The trial decided like Outcome row 6: `timeout` when an unfinished call exists, else the
   * latest-ended unrecovered failure, a cut stream being a `timeout` one; W6 when a cut stream or
   * an unfinished call decides, else W5.
   */
  private failed(cutLastAnswer: boolean): Decided {
    const { d, a } = this;
    let suffix = cutLastAnswer ? '-cut-last-answer' : '';
    let index: number | undefined;
    if (this.unfinished.length === 0 && this.unrecovered.length > 0) {
      index = latestBy(this.unrecovered, (i) => this.failureEnds.get(i) ?? 0);
    }
    if (index === undefined || this.cutFailures.has(index)) {
      if (this.honoured) {
        suffix += '-stopped-early-honoured';
      } else if (this.stopped) {
        suffix += '-stopped-early-ignored';
      }
      d.warn(`W6${suffix}` as MessageId);
    } else {
      d.warn(`W5${suffix}` as MessageId);
    }
    const seen = index === undefined ? undefined : a.seen(index);
    if (seen?.state !== 'failed') {
      return d.failure('timeout', NO_ANSWER_TEXT, undefined);
    }
    return d.callFailure(seen);
  }

  // A captured raw call

  /**
   * Outcome row 4 and row 5 when raw is given, §Cut Last Answer, the finish-reason check, then the
   * result.
   */
  private checked(rawIndex: number, source: RawSource): Decided {
    const { a, given } = this;
    if (!this.resultModelIsVariant()) {
      return this.wrongResultModel();
    }
    let accepted: Set<number>;
    if (a.chosen !== undefined) {
      accepted = new Set([...this.searched, rawIndex]);
    } else {
      const rawBranches = new Set([
        a.root(rawIndex),
        ...[...this.unread].filter((index) => index < rawIndex).map((index) => a.root(index)),
      ]);
      accepted = new Set(
        a.seens.flatMap((_, index) => (rawBranches.has(a.root(index)) ? [index] : [])),
      );
    }
    const branches = new Set([...accepted].map((index) => a.root(index)));
    const both = given.finishReason !== undefined && given.answers !== undefined;
    const rawSystem = canonicalJson(a.seen(a.root(rawIndex)).call.system);
    if (a.chosen === undefined) {
      const systems = new Set([...branches].map((root) => canonicalJson(a.seen(root).call.system)));
      if (systems.size > 1) {
        return this.noBranchError(message('A3-raw-unread-systems'));
      }
      if (!both && this.answers.some((answer) => a.root(answer.index) !== a.root(rawIndex))) {
        return this.noBranchError(message('A3-raw-other-answer'));
      }
    }
    const cutLastAnswer = this.cutLastAnswer(rawIndex, source);
    if (source === 'matched') {
      const unrecovered = new Set(this.unrecovered);
      const later = [...this.unread].filter(
        (index) => index > rawIndex && !(this.cutFailures.has(index) && !unrecovered.has(index)),
      );
      if (later.length > 0) {
        const differs = later.some(
          (index) =>
            this.cut.has(index) && canonicalJson(a.seen(a.root(index)).call.system) !== rawSystem,
        );
        if (a.chosen === undefined && differs) {
          return this.noBranchError(message('A3-raw-unread-systems'));
        }
        if (!cutLastAnswer && !both) {
          return this.noBranchError(message('A3-raw-unread-follows'));
        }
      }
    }
    if (cutLastAnswer) {
      return this.failed(true);
    }
    return this.capturedResult(rawIndex, source, accepted, branches);
  }

  /**
   * data-model §Cut Last Answer: the last call cut without `Result(answers=)`, or the raw call cut
   * with `Result(answers=1)`; only cut streams that stay unrecovered `timeout` failures.
   */
  private cutLastAnswer(rawIndex: number, source: RawSource): boolean {
    const { a, given } = this;
    const cuts = new Set(this.unrecovered.filter((index) => this.cutFailures.has(index)));
    if (cuts.size === 0) {
      return false;
    }
    const answered = new Set([...this.answers.map((answer) => answer.index), ...this.unread]);
    if (given.answers === undefined && answered.size > 0 && cuts.has(Math.max(...answered))) {
      return true;
    }
    if (source !== 'unread' || !cuts.has(rawIndex) || given.answers !== 1) {
      return false;
    }
    if (a.chosen === undefined) {
      return true;
    }
    const sent = a.seen(rawIndex).call.sentAt;
    return !this.live.some(
      (index) => index !== rawIndex && this.received(index) && this.ended(index) > sent,
    );
  }

  /**
   * data-model §Answer Candidate Calls When Raw Is Given: `answers`, the finish reason,
   * `fingerprint` and `branch`, with `Result(usage=)` on the raw call.
   */
  private capturedResult(
    rawIndex: number,
    source: RawSource,
    accepted: Set<number>,
    branches: Set<number>,
  ): Decided {
    const { d, a, given } = this;
    const answers = this.answers.filter((answer) => accepted.has(answer.index));
    let count = answers.length;
    let fromRaw = false;
    const rawSeen = a.seen(rawIndex);
    const toolEnd = rawSeen.sse && rawSeen.streamToolEnd;
    if (source === 'unread') {
      const counts = !(toolEnd && a.target.answerTool === undefined && this.fallback);
      count += counts ? 1 : 0;
      const last = answers.at(-1);
      fromRaw = counts && (last === undefined || rawIndex > last.index);
    }
    let finish = typeof given.finishReason === 'string' ? given.finishReason : undefined;
    if (finish === undefined) {
      const last = answers.at(-1);
      if (fromRaw && !toolEnd) {
        return d.adapterError(message('A9'));
      }
      if (fromRaw || last === undefined) {
        finish = this.kind === 'model' && toolEnd ? 'stop' : 'other';
      } else {
        finish = last.finish;
        if (last.finish !== 'stop' && d.earlierStop(last, answers)) {
          d.warn('W3');
        }
      }
    }
    const first = Math.min(...[...this.unread].filter((index) => index < rawIndex), rawIndex);
    const records = a.finals.map((final, index) =>
      callRecord(
        final,
        branches.has(a.root(index)) ? 'answer' : 'side',
        a.seen(index).state !== 'unfinished',
      ),
    );
    return d.resultOf(this.raw, count, finish, {
      records,
      snapshot: source === 'matched' ? rawIndex : undefined,
      usageIndex: rawIndex,
      request: a.seen(a.root(first)).call,
      w2System: a.seen(a.root(rawIndex)).call.system,
      w2TextOnly: false,
      hasAnswer: given.answers !== 0,
    });
  }

  // The uncaptured call

  /**
   * data-model §Raw Call, the uncaptured call: added to `calls` with `Result(model=)`; under the
   * uncaptured-call exception nothing is added and `answers` is 0.
   */
  private uncaptured(exception: boolean): Decided {
    const { d, a, given } = this;
    const records = a.finals.map((final, index) =>
      callRecord(final, undefined, a.seen(index).state !== 'unfinished'),
    );
    const hasCalls = a.finals.length > 0;
    const finish = typeof given.finishReason === 'string' ? given.finishReason : undefined;
    if (exception) {
      return d.resultOf(this.raw, 0, finish ?? 'other', {
        records: hasCalls ? records : undefined,
        snapshot: undefined,
        usageIndex: undefined,
        request: undefined,
        w2System: undefined,
        w2TextOnly: false,
        hasAnswer: false,
      });
    }
    if (finish === undefined) {
      return d.adapterError(message('A9'));
    }
    if (this.answers.length > 0) {
      d.warn('W4');
    }
    this.w8();
    if (hasCalls) {
      const added: CallRecord = { model: textOrUndefined(given.model) ?? '', outcome: 'ok' };
      if (typeof given.modelSnapshot === 'string') {
        added['responseModel'] = given.modelSnapshot;
      }
      records.push(added);
    }
    return d.resultOf(this.raw, 1, finish, {
      records: hasCalls ? records : undefined,
      snapshot: undefined,
      usageIndex: hasCalls ? records.length - 1 : undefined,
      request: undefined,
      w2System: undefined,
      w2TextOnly: true,
      hasAnswer: given.answers !== 0,
    });
  }

  /** W8: a captured call to another model looks like the source of the raw answer. */
  private w8(): void {
    const a = this.a;
    const raw = trimText(this.raw);
    const rawLength = Array.from(raw).length;
    for (const [index, seen] of a.seens.entries()) {
      if (a.isVariant[index] === true || (a.chosen !== undefined && a.chosen[index] !== true)) {
        continue;
      }
      let looks =
        seen.state === 'unread' ||
        seen.state === 'unfinished' ||
        (seen.state === 'failed' &&
          seen.sse &&
          !seen.generationEnd &&
          seen.failure?.transport === 'timeout');
      if (!looks && raw !== '') {
        looks = a
          .answersOf(index)
          .map((answer) => trimText(answer.text))
          .some((text) => text.includes(raw) && 2 * rawLength >= Array.from(text).length);
      }
      if (looks) {
        this.d.warn('W8', { model: seen.call.model });
        return;
      }
    }
  }
}

/**
 * A searched SSE call that ended before its generation-end marker: failed with `timeout`, left
 * unread, or unfinished when the function returned.
 */
function isCut(seen: Seen): boolean {
  if (!seen.sse || seen.generationEnd) {
    return false;
  }
  if (seen.state === 'unread' || seen.state === 'unfinished') {
    return true;
  }
  return seen.state === 'failed' && seen.failure?.transport === 'timeout';
}

/** An SSE call that failed by a drop or time-out after its generation-end marker. */
function failedAfterMarker(seen: Seen): boolean {
  return (
    seen.state === 'failed' &&
    seen.sse &&
    seen.generationEnd &&
    seen.failure !== undefined &&
    seen.failure.status === undefined
  );
}

/** Nothing remains after trimming White_Space from both ends (data-model §Comparing Text). */
function isEmptyText(text: string): boolean {
  return trimText(text) === '';
}

function sumUsage(records: readonly CallRecord[]): Usage | undefined {
  const total: Usage = {};
  for (const record of records) {
    for (const [name, value] of Object.entries(asDict(record['usage']))) {
      if (typeof value === 'number') {
        total[name] = (total[name] ?? 0) + value;
      }
    }
  }
  return Object.keys(total).length > 0 ? total : undefined;
}

/** `calls` and the `usage` summed over them. */
function recordsCost(records: CallRecord[]): Record<string, JsonValue> {
  const usage = sumUsage(records);
  return { calls: records, ...(usage === undefined ? {} : { usage }) };
}

/** Outcome row 1: the latest-ended `config` failure among the calls. */
function configFailure(finals: readonly Seen[]): Seen | undefined {
  let found: Seen | undefined;
  for (const seen of finals) {
    if (seen.state === 'failed' && kindOf(seen) === 'config') {
      if (found === undefined || (seen.endedAt ?? 0) > (found.endedAt ?? 0)) {
        found = seen;
      }
    }
  }
  return found;
}

/**
 * The `generate` response of a trial whose function ended: `seens` as the calls were when it
 * returned, `finals` after the wait for unfinished calls. `discardOn` is consulted only for an
 * exception that is not a `ModelCallError`.
 */
export function decide(
  trial: Trial,
  end: FunctionEnd,
  seens: readonly Seen[],
  finals: readonly Seen[],
  latencyMs: number,
): Decided {
  const discarded = end.error !== undefined && discards(trial.target, end.error.thrown);
  const analysis = new Analysis(trial, seens, finals);
  return new Decision(analysis, end, discarded, latencyMs).decide();
}

/**
 * Outcome row 1 from the calls alone, without `replyCall`: the failure result of the latest-ended
 * `config` failure, or undefined. A classification that raises counts as none.
 */
export function configResult(
  finals: readonly Seen[],
  returned: readonly Seen[] | undefined,
  latencyMs: number,
): JsonObject | undefined {
  let config: Seen | undefined;
  try {
    config = configFailure(finals);
  } catch {
    return undefined;
  }
  if (config === undefined) {
    return undefined;
  }
  const failure: Record<string, JsonValue> = { kind: 'config', message: failureMessage(config) };
  return { error: failure, latencyMs, ...costOf(finals, returned) };
}

/**
 * `calls` and `usage` of a trial's records when no decision gives them. `returned` holds the calls
 * as they were when the function returned, for their `latencyMs`.
 */
export function costOf(
  finals: readonly Seen[],
  returned?: readonly Seen[],
): Record<string, JsonValue> {
  if (finals.length === 0) {
    return {};
  }
  const records = finals.map((final, index) =>
    callRecord(final, undefined, returned === undefined || returned[index]?.state !== 'unfinished'),
  );
  return recordsCost(records);
}
