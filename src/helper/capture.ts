import { performance } from 'node:perf_hooks';

import { canonicalJson, parseJsonText, sha256OfText } from '../adapter/canonical-json.js';
import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../adapter/json-types.js';
import { HUB, type Trial } from './context.js';
import {
  eventErrorObject,
  isAbortError,
  retryAfterMs,
  type TransportKind,
  transportKind,
} from './errors.js';
import { exceptionText, message } from './messages.js';

// helper-api §Captured Requests, §Reading Response Bodies and §End Events: the `globalThis.fetch`
// wrapper, installed when this module is evaluated, and what it records of each captured call.

/** Token buckets keyed by the protocol bucket names (data-model §Usage Buckets). */
export type Usage = Record<string, number>;

export type Api = 'chat-completions' | 'responses' | 'messages';

// --- JSON values read from bodies -------------------------------------------------------------

export function asDict(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function asList(value: JsonValue | undefined): readonly JsonValue[] {
  return isJsonArray(value) ? value : [];
}

export function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * An integer read from a body: a number without a fractional part and at most 2^53-1 in size.
 */
export function asCount(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * A field read as text: a string as it is, any other JSON value as its canonical JSON (`1.0` is
 * `1`, `null` is `null`), and `absent` when the field is missing.
 */
function textOf(value: JsonValue | undefined, absent = ''): string {
  if (value === undefined) {
    return absent;
  }
  return typeof value === 'string' ? value : canonicalJson(value);
}

/**
 * A message's role (or a Responses item's type standing for it): missing or null is the empty
 * string, which render reports as A19.
 */
function roleOf(value: JsonValue | undefined): string {
  return value === null ? '' : textOf(value);
}

/** The JSON value of the text by the reading rules, or undefined when it is not JSON. */
export function readJson(text: string): JsonValue | undefined {
  const parsed = parseJsonText(text);
  return parsed.ok ? parsed.value : undefined;
}

/** The object's member, read as `dict.get` reads it: undefined when absent. */
function member(object: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

// --- Requests (helper-api §Which Requests, §Render Mode; data-model §System Prompt) ----------

const API_SUFFIXES: readonly (readonly [string, Api])[] = [
  ['/chat/completions', 'chat-completions'],
  ['/responses', 'responses'],
  ['/messages', 'messages'],
];

const PART_KINDS: Readonly<Record<string, string>> = {
  image_url: 'image',
  input_image: 'image',
  image: 'image',
  file: 'file',
  input_file: 'file',
  document: 'file',
  input_audio: 'audio',
  audio: 'audio',
};

// Reasoning blocks written as one canonical JSON line each, like every block whose type ends in
// `tool_use` or `tool_result`.
const REASONING_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);
const SYSTEM_ROLES: ReadonlySet<string> = new Set(['system', 'developer']);

export type RenderMessage = { readonly role: string; readonly content: string };

export function apiOfPath(path: string): Api | undefined {
  return API_SUFFIXES.find(([suffix]) => path.endsWith(suffix))?.[1];
}

/**
 * A message's `content` as one string: text parts joined with newlines, other parts as their kind
 * or, for tool and reasoning parts, a line of canonical JSON.
 */
export function partsText(parts: JsonValue | undefined): string {
  if (typeof parts === 'string') {
    return parts;
  }
  if (parts === undefined || parts === null) {
    return '';
  }
  return asList(parts)
    .map((part) => partLine(asDict(part)))
    .join('\n');
}

/** One part's line, by the first matching row of helper-api §Render Mode's part table. */
function partLine(part: JsonObject): string {
  const kind = asStr(member(part, 'type')) ?? '';
  if (kind.endsWith('tool_use') || kind.endsWith('tool_result') || REASONING_BLOCKS.has(kind)) {
    return canonicalJson(part);
  }
  const text = member(part, 'text');
  if (typeof text === 'string') {
    return text;
  }
  const refusal = member(part, 'refusal');
  if (kind === 'refusal' && typeof refusal === 'string') {
    return refusal;
  }
  return `[${PART_KINDS[kind] ?? kind}]`;
}

/** A Chat Completions message in the render shape. */
export function chatMessage(item: JsonObject): RenderMessage {
  const content = member(item, 'content');
  const empty =
    content === undefined ||
    content === null ||
    content === '' ||
    (isJsonArray(content) && content.length === 0);
  const lines = empty ? [] : [partsText(content)];
  lines.push(...asList(member(item, 'tool_calls')).map((call) => canonicalJson(call)));
  const functionCall = member(item, 'function_call');
  if (isJsonObject(functionCall)) {
    lines.push(canonicalJson(functionCall));
  }
  return { role: roleOf(member(item, 'role')), content: lines.join('\n') };
}

/** The Responses `input` as items; a string is one user message. */
export function responsesInput(body: JsonObject): readonly JsonValue[] {
  const value = member(body, 'input');
  if (typeof value === 'string') {
    return [{ role: 'user', content: value }];
  }
  return asList(value);
}

/**
 * A Responses input item: a message by its role, else, with the role missing or null, the item
 * under its `type` as role. A missing or null type is no type: the empty string, which render
 * reports as A19.
 */
function responsesItem(item: JsonObject): RenderMessage {
  const type = member(item, 'type');
  const role = member(item, 'role');
  const message = type === undefined || type === null || type === 'message';
  if (role !== undefined && role !== null && message) {
    return { role: textOf(role), content: partsText(member(item, 'content')) };
  }
  return { role: roleOf(type), content: canonicalJson(item) };
}

/** The request's messages in the render shape of helper-api §Render Mode. */
export function renderMessages(api: Api, body: JsonObject): RenderMessage[] {
  if (api === 'chat-completions') {
    return asList(member(body, 'messages')).map((item) => chatMessage(asDict(item)));
  }
  if (api === 'responses') {
    const messages = responsesInput(body).map((item) => responsesItem(asDict(item)));
    const instructions = member(body, 'instructions');
    if (typeof instructions === 'string') {
      messages.unshift({ role: 'system', content: instructions });
    }
    const prompt = member(body, 'prompt');
    if (prompt !== undefined) {
      messages.splice(leadingSystemCount(messages), 0, {
        role: 'prompt',
        content: canonicalJson(prompt),
      });
    }
    return messages;
  }
  const messages: RenderMessage[] = [];
  const system = member(body, 'system');
  if (system !== undefined && system !== null) {
    const texts = asList(system)
      .map((block) => member(asDict(block), 'text'))
      .filter((text): text is string => typeof text === 'string');
    messages.push({
      role: 'system',
      content: typeof system === 'string' ? system : texts.join('\n'),
    });
  }
  for (const item of asList(member(body, 'messages'))) {
    const message = asDict(item);
    messages.push({
      role: roleOf(member(message, 'role')),
      content: partsText(member(message, 'content')),
    });
  }
  return messages;
}

function leadingSystemCount(messages: readonly RenderMessage[]): number {
  let count = 0;
  while (count < messages.length && SYSTEM_ROLES.has(messages[count]?.role ?? '')) {
    count += 1;
  }
  return count;
}

/** data-model §System Prompt: the leading `system` and `developer` messages, in order. */
export function systemOf(messages: readonly RenderMessage[]): string[] {
  return messages.slice(0, leadingSystemCount(messages)).map((item) => item.content);
}

export function toolNamesOf(body: JsonObject): string[] {
  const names: string[] = [];
  for (const tool of asList(member(body, 'tools'))) {
    const definition = asDict(tool);
    const name =
      asStr(member(definition, 'name')) ||
      asStr(member(asDict(member(definition, 'function')), 'name'));
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * The render fingerprint of `{messages, tools}`, `tools` null when absent (001 data-model
 * §Identifiers and Hashing).
 */
export function renderFingerprint(
  messages: readonly RenderMessage[],
  tools: JsonValue | undefined,
): string {
  return sha256OfText(canonicalJson({ messages, tools: tools ?? null }));
}

/** data-model §Call Branches, resend: the body without `stream` and `stream_options`. */
function requestKey(body: JsonObject): string {
  const { stream: _stream, stream_options: _options, ...rest } = body;
  return canonicalJson(rest);
}

/** The message list a tool-loop step extends (data-model §Call Branches). */
export function conversationItems(api: Api, body: JsonObject): readonly JsonValue[] {
  return api === 'responses' ? responsesInput(body) : asList(member(body, 'messages'));
}

// --- Responses (data-model §Usage Buckets, §Finish Reasons, §Derived Result Fields) ----------

/** Responses tool-call items and the result items that point back to them. */
export const RESULT_ITEMS: Readonly<Record<string, readonly [string, string]>> = {
  function_call: ['function_call_output', 'call_id'],
  custom_tool_call: ['custom_tool_call_output', 'call_id'],
  computer_call: ['computer_call_output', 'call_id'],
  local_shell_call: ['local_shell_call_output', 'id'],
  shell_call: ['shell_call_output', 'call_id'],
  apply_patch_call: ['apply_patch_call_output', 'call_id'],
  mcp_approval_request: ['mcp_approval_response', 'approval_request_id'],
};

export const RESULT_ITEM_TYPES: ReadonlySet<string> = new Set([
  ...Object.values(RESULT_ITEMS).map(([result]) => result),
  'tool_search_output',
]);

const LENGTH_REASONS = new Set([
  'length',
  'max_tokens',
  'model_context_window_exceeded',
  'max_output_tokens',
]);
const FILTER_REASONS = new Set(['content_filter', 'refusal']);
const STOP_REASONS = new Set(['stop', 'completed', 'end_turn', 'stop_sequence']);

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other';

/** A provider finish reason on the protocol scale. */
export function protocolFinish(raw: string | undefined): FinishReason {
  if (raw === undefined) {
    return 'other';
  }
  if (STOP_REASONS.has(raw)) {
    return 'stop';
  }
  if (LENGTH_REASONS.has(raw)) {
    return 'length';
  }
  return FILTER_REASONS.has(raw) ? 'content_filter' : 'other';
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** One answer slot of a response: a `choices` item, or the whole response. */
export interface Choice {
  readonly text: string;
  readonly finishRaw: string | undefined;
  readonly toolCalls: readonly ToolCall[];
  /** Ended in a tool call, or Anthropic `pause_turn` (data-model §Finish Reasons). */
  readonly toolEnd: boolean;
}

/** What a fully received JSON response body says. */
export interface Parsed {
  readonly choices: readonly Choice[];
  readonly usage: Usage | undefined;
  readonly negativeInput: boolean;
  readonly responseModel: string | undefined;
  readonly responseId: string | undefined;
  readonly status: string | undefined;
  readonly outputItems: readonly JsonValue[];
  readonly error: JsonObject | undefined;
}

/**
 * The ID a Responses tool call is known by: `call_id` (`id` for `mcp_approval_request`); when that
 * is missing, null or empty, the item's `id` (data-model §Finish Reasons, §Call Branches).
 */
export function callIdOf(item: JsonObject): string {
  return idOf(item, member(item, 'type') === 'mcp_approval_request' ? 'id' : 'call_id');
}

/** The field as text, the item's `id` when the field is missing, null or empty, else ''. */
function idOf(item: JsonObject, field: string): string {
  const own = member(item, field);
  const value = isNoId(own) ? member(item, 'id') : own;
  return isNoId(value) ? '' : textOf(value);
}

/** An ID that is missing, null or empty; any other value, `0` and `false` included, is one. */
function isNoId(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The output items that are tool calls the service must answer (data-model §Finish Reasons,
 * Responses tool-call items).
 */
export function responsesToolItems(output: readonly JsonValue[]): JsonObject[] {
  const items = output.map(asDict);
  const calls: JsonObject[] = [];
  for (const item of items) {
    const kind = member(item, 'type');
    if (kind === 'tool_search_call') {
      if (member(item, 'execution') === 'client') {
        calls.push(item);
      }
      continue;
    }
    const result = typeof kind === 'string' ? RESULT_ITEMS[kind] : undefined;
    if (result === undefined) {
      continue;
    }
    const [resultType, pointer] = result;
    const target = callIdOf(item);
    const answered = items.some((other) => {
      if (member(other, 'type') !== resultType) {
        return false;
      }
      // Only the call's own ID falls back to its `id`. A result whose pointer is missing, null or
      // empty points to no call, and a call without an ID has no result.
      const pointed = member(other, pointer);
      return target !== '' && !isNoId(pointed) && textOf(pointed) === target;
    });
    if (!answered) {
      calls.push(item);
    }
  }
  return calls;
}

/** Python truthiness of a JSON value, for the fields the helpers read with `or`. */
function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return false;
  }
  if (isJsonArray(value)) {
    return value.length > 0;
  }
  return isJsonObject(value) ? Object.keys(value).length > 0 : true;
}

function toolArguments(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : canonicalJson(value ?? {});
}

function firstPresent(item: JsonObject, names: readonly string[]): JsonValue | undefined {
  for (const name of names) {
    if (Object.hasOwn(item, name)) {
      return item[name];
    }
  }
  return undefined;
}

function responsesToolCall(item: JsonObject): ToolCall {
  const name = member(item, 'name');
  return {
    id: callIdOf(item),
    name: pythonTruthy(name) ? textOf(name) : textOf(member(item, 'type') ?? null),
    arguments: toolArguments(firstPresent(item, ['arguments', 'input', 'action'])),
  };
}

function isLimited(finish: string | undefined): boolean {
  const reason = protocolFinish(finish);
  return reason === 'length' || reason === 'content_filter';
}

/** One `Choice` per `choices` item; an empty or missing list is one empty answer. */
function parseChat(body: JsonObject): Choice[] {
  const choices: Choice[] = [];
  for (const entry of asList(member(body, 'choices'))) {
    const item = asDict(entry);
    const messageBody = asDict(member(item, 'message'));
    const calls: ToolCall[] = [];
    for (const callEntry of asList(member(messageBody, 'tool_calls'))) {
      const call = asDict(callEntry);
      const functionField = member(call, 'function');
      const fn = asDict(pythonTruthy(functionField) ? functionField : member(call, 'custom'));
      calls.push({
        id: textOf(member(call, 'id')),
        name: textOf(member(fn, 'name')),
        arguments: toolArguments(firstPresent(fn, ['arguments', 'input'])),
      });
    }
    const legacy = asDict(member(messageBody, 'function_call'));
    if (Object.keys(legacy).length > 0) {
      calls.push({
        id: '',
        name: textOf(member(legacy, 'name')),
        arguments: toolArguments(member(legacy, 'arguments')),
      });
    }
    const finish = asStr(member(item, 'finish_reason'));
    const text = member(messageBody, 'content');
    choices.push({
      text: typeof text === 'string' ? text : '',
      finishRaw: finish,
      toolCalls: calls,
      toolEnd: calls.length > 0 && !isLimited(finish),
    });
  }
  return choices.length > 0
    ? choices
    : [{ text: '', finishRaw: undefined, toolCalls: [], toolEnd: false }];
}

function parseResponses(body: JsonObject): Choice[] {
  const output = asList(member(body, 'output'));
  const texts: string[] = [];
  for (const item of output.map(asDict)) {
    if (member(item, 'type') !== 'message') {
      continue;
    }
    for (const part of asList(member(item, 'content')).map(asDict)) {
      if (member(part, 'type') === 'output_text') {
        texts.push(textOf(member(part, 'text')));
      }
    }
  }
  const status = asStr(member(body, 'status'));
  let finish = status;
  if (status === 'incomplete') {
    finish = asStr(member(asDict(member(body, 'incomplete_details')), 'reason')) || status;
  }
  const calls = responsesToolItems(output).map(responsesToolCall);
  return [
    {
      text: texts.join(''),
      finishRaw: finish,
      toolCalls: calls,
      toolEnd: calls.length > 0 && !isLimited(finish),
    },
  ];
}

function parseMessages(body: JsonObject): Choice[] {
  const blocks = asList(member(body, 'content')).map(asDict);
  const text = blocks
    .filter((block) => member(block, 'type') === 'text')
    .map((block) => textOf(member(block, 'text')))
    .join('');
  const calls = blocks
    .filter((block) => member(block, 'type') === 'tool_use')
    .map((block) => ({
      id: textOf(member(block, 'id')),
      name: textOf(member(block, 'name')),
      arguments: canonicalJson(Object.hasOwn(block, 'input') ? (block['input'] ?? null) : {}),
    }));
  const finish = asStr(member(body, 'stop_reason'));
  const toolEnd = (calls.length > 0 || finish === 'pause_turn') && !isLimited(finish);
  return [{ text, finishRaw: finish, toolCalls: calls, toolEnd }];
}

const USAGE_FIELDS: Readonly<Record<'chat-completions' | 'responses', readonly string[]>> = {
  'chat-completions': [
    'prompt_tokens',
    'prompt_tokens_details',
    'completion_tokens',
    'completion_tokens_details',
  ],
  responses: ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details'],
};

/**
 * The protocol buckets of a response's usage, and whether input came out negative (data-model
 * §Usage Buckets).
 */
export function usageOf(
  api: Api,
  body: JsonObject,
): { usage: Usage | undefined; negative: boolean } {
  const usage = member(body, 'usage');
  if (!isJsonObject(usage)) {
    return { usage: undefined, negative: false };
  }
  const buckets: Usage = {};
  const put = (name: string, value: number | undefined): void => {
    if (value !== undefined) {
      buckets[name] = value;
    }
  };
  if (api === 'messages') {
    put('input', asCount(member(usage, 'input_tokens')));
    put('cachedInput', asCount(member(usage, 'cache_read_input_tokens')));
    put('cacheWrite', asCount(member(usage, 'cache_creation_input_tokens')));
    put('output', asCount(member(usage, 'output_tokens')));
    put(
      'reasoning',
      asCount(member(asDict(member(usage, 'output_tokens_details')), 'thinking_tokens')),
    );
    return { usage: buckets, negative: false };
  }
  const [totalName = '', inputDetails = '', outputName = '', outputDetails = ''] =
    USAGE_FIELDS[api];
  const details = asDict(member(usage, inputDetails));
  const cached = asCount(member(details, 'cached_tokens'));
  const written = asCount(member(details, 'cache_write_tokens'));
  const total = asCount(member(usage, totalName));
  let negative = false;
  if (total !== undefined) {
    const uncached = total - (cached ?? 0) - (written ?? 0);
    negative = uncached < 0;
    buckets['input'] = Math.max(uncached, 0);
  }
  put('cachedInput', cached);
  put('cacheWrite', written);
  put('output', asCount(member(usage, outputName)));
  put('reasoning', asCount(member(asDict(member(usage, outputDetails)), 'reasoning_tokens')));
  return { usage: buckets, negative };
}

const PARSERS: Readonly<Record<Api, (body: JsonObject) => Choice[]>> = {
  'chat-completions': parseChat,
  responses: parseResponses,
  messages: parseMessages,
};

export function parseBody(api: Api, body: JsonObject): Parsed {
  const { usage, negative } = usageOf(api, body);
  let output: readonly JsonValue[];
  if (api === 'chat-completions') {
    const first = asDict(asList(member(body, 'choices'))[0]);
    output = Object.keys(first).length > 0 ? [member(first, 'message') ?? null] : [];
  } else if (api === 'responses') {
    output = asList(member(body, 'output'));
  } else {
    output = asList(member(body, 'content'));
  }
  const status = api === 'responses' ? asStr(member(body, 'status')) : undefined;
  const error = asDict(member(body, 'error'));
  return {
    choices: PARSERS[api](body),
    usage,
    negativeInput: negative,
    responseModel: asStr(member(body, 'model')),
    responseId: asStr(member(body, 'id')),
    status,
    outputItems: output,
    error: status === 'failed' && Object.keys(error).length > 0 ? error : undefined,
  };
}

// --- SSE copies (helper-api §Reading Response Bodies, §End Events) ---------------------------

/** What the end markers of an SSE copy said. Only end markers are read, never content. */
export interface StreamMarks {
  endEvent: 'normal' | 'failure' | undefined;
  generationEnd: boolean;
  toolEnd: boolean;
  failureError: JsonObject | undefined;
  responseId: string | undefined;
  outputItems: readonly JsonValue[] | undefined;
}

function emptyMarks(): StreamMarks {
  return {
    endEvent: undefined,
    generationEnd: false,
    toolEnd: false,
    failureError: undefined,
    responseId: undefined,
    outputItems: undefined,
  };
}

/**
 * Splits an SSE copy into events by the HTML standard's event-stream rules and reads the markers
 * of helper-api §End Events.
 */
export class SseReader {
  readonly marks: StreamMarks = emptyMarks();
  private readonly choices: number;
  private buffer = '';
  private pendingCr = false;
  private event = '';
  private data: string[] = [];
  private readonly finished = new Map<number, string>();
  /** Removes one U+FEFF at the start of the body (helper-api §Reading Response Bodies). */
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly api: Api,
    choices: number,
  ) {
    this.choices = Math.max(choices, 1);
  }

  feed(data: Uint8Array): void {
    this.buffer += this.decoder.decode(data, { stream: true });
    for (const line of this.completeLines()) {
      this.line(line);
    }
  }

  /**
   * The body ended without a read error: the last line without a line end counts, and a last
   * event without a trailing empty line counts when its `data` is complete.
   */
  finish(): void {
    this.buffer += this.decoder.decode();
    for (const line of this.completeLines()) {
      this.line(line);
    }
    if (this.buffer !== '') {
      this.line(this.buffer);
      this.buffer = '';
    }
    if (this.data.length > 0) {
      const data = this.data.join('\n');
      if (data === '[DONE]' || (readJson(data) ?? null) !== null) {
        this.dispatch();
      }
      this.event = '';
      this.data = [];
    }
  }

  private completeLines(): string[] {
    let text = this.buffer;
    if (this.pendingCr && text.startsWith('\n')) {
      text = text.slice(1);
    }
    this.pendingCr = false;
    const lines: string[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\r' || char === '\n') {
        lines.push(text.slice(start, index));
        if (char === '\r') {
          if (index + 1 === text.length) {
            this.pendingCr = true;
          } else if (text[index + 1] === '\n') {
            index += 1;
          }
        }
        start = index + 1;
      }
    }
    this.buffer = text.slice(start);
    return lines;
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        this.dispatch();
      }
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) {
      return;
    }
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (name === 'event') {
      this.event = value;
    } else if (name === 'data') {
      this.data.push(value);
    }
  }

  private dispatch(): void {
    if (this.marks.endEvent !== undefined) {
      return;
    }
    const data = this.data.join('\n');
    if (this.api === 'chat-completions' && data === '[DONE]') {
      this.end('normal');
      return;
    }
    const payload = readJson(data);
    if (!isJsonObject(payload)) {
      return;
    }
    if (this.api === 'chat-completions') {
      this.chatEvent(payload);
    } else if (this.api === 'responses') {
      this.responsesEvent(payload);
    } else {
      this.messagesEvent(payload);
    }
  }

  private end(kind: 'normal' | 'failure', error?: JsonObject): void {
    this.marks.endEvent = kind;
    if (kind === 'normal') {
      this.marks.generationEnd = true;
    } else {
      this.marks.failureError = error;
    }
  }

  private chatEvent(payload: JsonObject): void {
    if (this.event === 'error') {
      this.end('failure', eventErrorObject(payload));
      return;
    }
    const error = member(payload, 'error');
    if (error !== undefined && error !== null) {
      this.end('failure', asDict(error));
      return;
    }
    for (const choice of asList(member(payload, 'choices')).map(asDict)) {
      const reason = asStr(member(choice, 'finish_reason'));
      const index = asCount(member(choice, 'index'));
      if (reason !== undefined) {
        this.finished.set(index ?? 0, reason);
      }
    }
    if (this.finished.size >= this.choices && !this.marks.generationEnd) {
      this.marks.generationEnd = true;
      this.marks.toolEnd = [...this.finished.values()].every(
        (reason) => reason === 'tool_calls' || reason === 'function_call',
      );
    }
  }

  private responsesEvent(payload: JsonObject): void {
    const kind = member(payload, 'type');
    if (kind === 'response.completed' || kind === 'response.incomplete') {
      const response = asDict(member(payload, 'response'));
      const output = asList(member(response, 'output'));
      this.marks.responseId = asStr(member(response, 'id'));
      this.marks.outputItems = output;
      this.marks.toolEnd = kind === 'response.completed' && responsesToolItems(output).length > 0;
      this.end('normal');
    } else if (kind === 'response.failed') {
      this.end('failure', asDict(member(asDict(member(payload, 'response')), 'error')));
    } else if (kind === 'error' || this.event === 'error') {
      this.end('failure', eventErrorObject(payload));
    }
  }

  private messagesEvent(payload: JsonObject): void {
    const kind = member(payload, 'type');
    if (kind === 'message_stop') {
      this.end('normal');
    } else if (kind === 'message_delta') {
      const reason = asStr(member(asDict(member(payload, 'delta')), 'stop_reason'));
      if (reason !== undefined && !this.marks.generationEnd) {
        this.marks.generationEnd = true;
        this.marks.toolEnd = reason === 'tool_use' || reason === 'pause_turn';
      }
    } else if (kind === 'error' || this.event === 'error') {
      this.end('failure', eventErrorObject(payload));
    }
  }
}

// --- Captured calls (data-model §Captured Call, §When a Call Ended, §Call Outcome) -----------

/**
 * How a call failed: an error response (`status`, 200 for a response that ended in failure) or a
 * failure without a status code (`transport`). Times are `performance.now()` milliseconds.
 */
export interface Failure {
  readonly endedAt: number;
  readonly status?: number;
  readonly transport?: TransportKind;
  readonly error?: JsonObject;
  readonly retryAfterMs?: number;
  readonly usage?: Usage;
  readonly text: string;
  /** A non-stream 2xx body read to the end that is not a JSON object. */
  readonly notJson?: boolean;
  /** A request URL without an http or https scheme, never sent. */
  readonly badScheme?: boolean;
}

const CANCELLED_TEXT = 'The request was cancelled.';

function failureText(error: JsonObject): string {
  return asStr(member(error, 'message')) || 'The response ended in failure.';
}

/** One captured request and what the service read of its response. */
export class CapturedCall {
  readonly model: string;
  readonly tools: JsonValue | undefined;
  trial: Trial | undefined;
  notify = false;
  headersAt: number | undefined;
  status: number | undefined;
  headers: Headers | undefined;
  sse = false;
  private readonly copy: Uint8Array[] = [];
  reader: SseReader | undefined;
  bodyDone = false;
  private bodyClosed = false;
  private closedDuringRead = false;
  private reading = 0;
  private readsAfterClose = 0;
  lastReadAt: number | undefined;
  generationEndAt: number | undefined;
  parsed: Parsed | undefined;
  failure: Failure | undefined;
  cut = false;
  endedAt: number | undefined;
  recordSent = false;
  /** Answered with the render-mode 400 instead of being sent. */
  renderOnly = false;
  /** Aborts the request when the helper cuts it on the tool's `cancel`. */
  readonly cutter = new AbortController();
  private signal: AbortSignal | undefined;
  private cachedMessages: RenderMessage[] | undefined;
  private cachedKey: string | undefined;

  constructor(
    readonly api: Api,
    readonly body: JsonObject,
    readonly sentAt: number,
  ) {
    this.model = asStr(member(body, 'model')) ?? '';
    this.tools = member(body, 'tools');
  }

  // Request side

  get messages(): RenderMessage[] {
    this.cachedMessages ??= renderMessages(this.api, this.body);
    return this.cachedMessages;
  }

  get system(): string[] {
    return systemOf(this.messages);
  }

  get key(): string {
    this.cachedKey ??= requestKey(this.body);
    return this.cachedKey;
  }

  failedBeforeHeaders(error: unknown, aborted: boolean): void {
    if (this.ended()) {
      return;
    }
    const now = performance.now();
    const kind = transportKind(error, { aborted, stream: false });
    const text = aborted || isAbortError(error) ? CANCELLED_TEXT : exceptionText(error);
    this.fail({ endedAt: now, transport: kind, text });
  }

  gotHeaders(response: Response, signal: AbortSignal | undefined): void {
    const now = performance.now();
    this.headersAt = now;
    this.status = response.status;
    this.headers = response.headers;
    this.signal = signal;
    const contentType = response.headers.get('content-type') ?? '';
    this.sse = (contentType.split(';')[0] ?? '').trim().toLowerCase() === 'text/event-stream';
    if (this.sse) {
      this.reader = new SseReader(this.api, asCount(member(this.body, 'n')) || 1);
    }
    if (this.status >= 400 && !this.ended()) {
      const retry = retryAfterMs(response.headers);
      this.fail({
        endedAt: now,
        status: this.status,
        text: '',
        ...(retry === undefined ? {} : { retryAfterMs: retry }),
      });
    }
  }

  // Body side

  readStarted(): void {
    if (this.bodyClosed) {
      this.readsAfterClose += 1;
    }
    this.reading += 1;
  }

  /** Ends one read; whether it started after the body was closed. */
  private readReturned(): boolean {
    this.reading -= 1;
    if (this.readsAfterClose > 0 && this.bodyClosed) {
      this.readsAfterClose -= 1;
      return true;
    }
    return false;
  }

  received(chunk: Uint8Array): void {
    this.readReturned();
    const now = performance.now();
    this.lastReadAt = now;
    if (!this.copying()) {
      return;
    }
    this.copy.push(chunk);
    if (this.reader !== undefined && !this.errorStatus()) {
      this.reader.feed(chunk);
      this.marksRead(now);
    }
  }

  /**
   * Whether a chunk still belongs in the copy: error bodies are kept for classification;
   * otherwise nothing after the call ended counts.
   */
  private copying(): boolean {
    if (this.cut || this.bodyDone) {
      return false;
    }
    if (this.errorStatus()) {
      return true;
    }
    if (this.failure !== undefined) {
      return false;
    }
    return this.reader?.marks.endEvent === undefined;
  }

  private errorStatus(): boolean {
    return this.status !== undefined && this.status >= 400;
  }

  /** Applies the end markers the SSE copy holds so far (helper-api §End Events). */
  private marksRead(now: number): void {
    const marks = this.reader?.marks;
    if (marks === undefined) {
      return;
    }
    if (marks.generationEnd && this.generationEndAt === undefined) {
      this.generationEndAt = now;
      HUB.callChanged(this);
    }
    if (marks.endEvent === 'failure' && this.failure === undefined) {
      const error = marks.failureError ?? {};
      this.fail({ endedAt: now, status: 200, error, text: failureText(error) });
    }
  }

  /** The body was read to its end without a read error. */
  readFinished(): void {
    // A read started after the body was closed or cancelled is not an awaited read however it
    // ends, so reaching the end through it neither completes the body nor counts as a drop.
    const afterClose = this.readReturned();
    if (afterClose || this.cut || this.bodyDone) {
      return;
    }
    this.bodyDone = true;
    const now = performance.now();
    if (this.errorStatus() || this.failure !== undefined) {
      return;
    }
    if (this.reader === undefined) {
      this.bodyComplete(now);
      return;
    }
    if (!this.endEventSeen()) {
      this.reader.finish();
      this.marksRead(now);
      if (!this.endEventSeen() && !this.ended()) {
        const text = 'The stream ended without an end event.';
        this.fail({ endedAt: now, transport: 'disconnect', text });
      }
    }
    HUB.callChanged(this);
  }

  private endEventSeen(): boolean {
    return this.reader?.marks.endEvent !== undefined;
  }

  private copyText(): string {
    // One U+FEFF at the start of the body is removed (helper-api §Reading Response Bodies).
    return new TextDecoder('utf-8').decode(Buffer.concat(this.copy));
  }

  private bodyComplete(now: number): void {
    this.endedAt = now;
    const body = readJson(this.copyText());
    if (!isJsonObject(body)) {
      // helper-api §Reading Response Bodies, item 4: not an API response at all.
      this.fail({ endedAt: now, status: 200, notJson: true, text: message('F1') });
      return;
    }
    const topError = member(body, 'error');
    if (topError !== undefined && topError !== null) {
      // helper-api §Reading Response Bodies item 4: a top-level `error` ends the response in
      // failure, classified by that error object.
      const error = asDict(topError);
      const { usage } = usageOf(this.api, body);
      this.fail({
        endedAt: now,
        status: 200,
        error,
        text: failureText(error),
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    this.parsed = parseBody(this.api, body);
    if (this.parsed.status === 'failed') {
      const error = this.parsed.error ?? {};
      const usage = this.parsed.usage;
      this.fail({
        endedAt: now,
        status: 200,
        error,
        text: failureText(error),
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    HUB.callChanged(this);
  }

  /** The error object of the failure: its own, or the body of an error response read to its end. */
  errorObject(): JsonObject | undefined {
    if (this.failure?.error !== undefined) {
      return this.failure.error;
    }
    if (!this.errorStatus() || !this.bodyDone) {
      return undefined;
    }
    const body = asDict(readJson(this.copyText()));
    const nested = asDict(member(body, 'error'));
    if (Object.keys(nested).length > 0) {
      return nested;
    }
    return Object.keys(body).length > 0 ? body : undefined;
  }

  readFailed(error: unknown): void {
    const afterClose = this.readReturned();
    if (afterClose || this.endedByBody()) {
      return;
    }
    const now = performance.now();
    const cancelled = this.closedDuringRead || this.signal?.aborted === true || isAbortError(error);
    if (cancelled) {
      if (this.generationEndAt === undefined) {
        this.fail({ endedAt: now, transport: 'timeout', text: CANCELLED_TEXT });
      }
      return;
    }
    const kind = transportKind(error, { aborted: false, stream: this.sse });
    this.fail({
      endedAt: now,
      transport: kind === 'timeout' ? 'timeout' : 'disconnect',
      text: exceptionText(error),
    });
  }

  /** The body was closed or cancelled: a read waiting then was awaited. */
  closing(): void {
    this.bodyClosed = true;
    if (this.awaitedReads() > 0) {
      this.closedDuringRead = true;
    }
  }

  /**
   * Reads in progress that started before the body was closed or cancelled. A read started after
   * that is not an awaited read, however it ends (helper-api §Reading Response Bodies), such as the
   * one some SDKs make after `abort()` when a `for await` loop is left.
   */
  private awaitedReads(): number {
    return this.reading - this.readsAfterClose;
  }

  /** Whether the body was closed while a read waited. */
  get cancelledDuringRead(): boolean {
    return this.closedDuringRead;
  }

  // State

  fail(failure: Failure): void {
    this.failure = failure;
    this.endedAt = failure.endedAt;
    HUB.callChanged(this);
  }

  ended(): boolean {
    return this.cut || this.failure !== undefined;
  }

  /**
   * No later chunk or error changes the call: it failed, was cut, its body was read to the end,
   * or its SSE copy received an end event.
   */
  endedByBody(): boolean {
    if (this.cut || this.failure !== undefined || this.bodyDone) {
      return true;
    }
    return this.reader?.marks.endEvent !== undefined;
  }

  /** A request without a response, or a body with a waiting reader. */
  inFlight(): boolean {
    if (this.ended()) {
      return false;
    }
    if (this.headersAt === undefined) {
      return true;
    }
    if (this.sse && this.generationEndAt !== undefined) {
      return false;
    }
    return this.awaitedReads() > 0 && !this.endedByBody();
  }

  /**
   * Ended for a `calls` notification: failed, cut, read to its end, or an SSE copy with its
   * generation-end marker.
   */
  finished(): boolean {
    return this.ended() || this.bodyDone || this.generationEndAt !== undefined;
  }

  /**
   * Cuts the call on the tool's `cancel`: it ends now and its request is aborted. The abort
   * reason is a transport error marked like a blocked request, so the SDK passes it on as the
   * cause of the error it raises and background work that hit it is logged as L3.
   */
  cutNow(): void {
    this.cut = true;
    this.endedAt = performance.now();
    this.cutter.abort(notSent(CUT_TEXT, true));
  }
}

// --- The fetch wrapper (helper-api §Captured Requests, §Reading Response Bodies) -------------

const RENDER_ONLY_TEXT = 'Render mode sends no model request.';
const BLOCKED_TEXT = 'The tool cancelled this trial, so the request was not sent.';
const CUT_TEXT = 'The tool cancelled this trial, so the request was cut.';
/** Marks the error of a request cut or blocked after `cancel`, for log warning L3. */
const BLOCKED = Symbol('model-eval.blocked');
const NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Whether the error, or one in its `cause` chain, comes from a request cut or blocked after
 * `cancel`.
 */
export function isBlocked(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if (BLOCKED in current) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/**
 * helper-api §Render Mode: the provider-shaped HTTP 400 `render_only` a captured request gets
 * instead of being sent. It has no `x-should-retry` header, and the SDKs do not resend 400.
 */
function renderOnlyResponse(api: Api): Response {
  const error = { type: 'render_only', message: RENDER_ONLY_TEXT };
  const body: JsonObject =
    api === 'messages'
      ? { type: 'error', error }
      : { error: { ...error, param: null, code: null } };
  return new Response(canonicalJson(body), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

/** The transport error `fetch` raises for a request that never left: a `TypeError` with a cause. */
function notSent(text: string, blocked = false): TypeError {
  const cause = new Error(text);
  if (blocked) {
    Object.defineProperty(cause, BLOCKED, { value: true });
  }
  return new TypeError('fetch failed', { cause });
}

/**
 * Runs the helper's own bookkeeping of a request; a failure in it is printed to stderr and never
 * reaches the service, whose SDK must see what it sees without the helper.
 */
function quietly(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(error);
  }
}

interface FoundRequest {
  readonly api: Api;
  readonly body: JsonObject;
  readonly httpScheme: boolean;
}

async function bodyText(body: unknown): Promise<string | undefined> {
  if (typeof body === 'string') {
    return body;
  }
  // A leading BOM stays in a request body, so such a body is not JSON and passes through; only
  // response bodies drop one (helper-api §Reading Response Bodies).
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  if (body instanceof ArrayBuffer) {
    return decoder.decode(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    return decoder.decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (body instanceof Blob) {
    return decoder.decode(await body.arrayBuffer());
  }
  return undefined;
}

/** The API and JSON body of a request the helper captures, or undefined to pass it through. */
async function capturedRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<FoundRequest | undefined> {
  const request = input instanceof Request ? input : undefined;
  const method = init?.method ?? request?.method ?? 'GET';
  if (method.toUpperCase() !== 'POST') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
  } catch {
    return undefined;
  }
  const api = apiOfPath(url.pathname);
  if (api === undefined) {
    return undefined;
  }
  let text: string | undefined;
  try {
    if (init?.body !== undefined && init.body !== null) {
      text = await bodyText(init.body);
    } else if (request?.body) {
      text = await bodyText(await request.clone().arrayBuffer());
    }
  } catch {
    return undefined;
  }
  const body = text === undefined ? undefined : readJson(text);
  if (!isJsonObject(body)) {
    return undefined;
  }
  const model = member(body, 'model');
  if (typeof model !== 'string' || model === '') {
    return undefined;
  }
  const httpScheme = url.protocol === 'http:' || url.protocol === 'https:';
  return { api, body, httpScheme };
}

/**
 * The response the SDK receives: the original status, headers and `url`, with a body stream that
 * reads the original only when the SDK reads, never ahead (highWaterMark 0), copying each chunk
 * after the markers were read and before it is handed on.
 */
function copyingResponse(response: Response, call: CapturedCall, signal: AbortSignal): Response {
  if (response.status < 200 || response.status > 599) {
    // `Response` cannot be built with such a status; the SDK gets the original, uncopied.
    return response;
  }
  const init = { status: response.status, statusText: response.statusText };
  if (NO_BODY_STATUSES.has(response.status) || response.body === null) {
    return withUrl(new Response(null, { ...init, headers: response.headers }), response.url);
  }
  const original: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const onAbort = (): void => {
    quietly(() => {
      call.closing();
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const detach = (): void => {
    signal.removeEventListener('abort', onAbort);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        quietly(() => {
          call.readStarted();
        });
        let chunk: Awaited<ReturnType<typeof original.read>>;
        try {
          chunk = await original.read();
        } catch (error) {
          detach();
          quietly(() => {
            call.readFailed(error);
          });
          controller.error(error);
          return;
        }
        if (chunk.done) {
          detach();
          // A read the SDK's own cancel ended reports the end of the original as well.
          quietly(() => {
            if (call.cancelledDuringRead) {
              call.readFailed(new DOMException(CANCELLED_TEXT, 'AbortError'));
            } else {
              call.readFinished();
            }
          });
          try {
            controller.close();
          } catch {
            // The copy stream was cancelled meanwhile.
          }
          return;
        }
        quietly(() => {
          call.received(chunk.value);
        });
        try {
          controller.enqueue(chunk.value);
        } catch {
          // The copy stream was cancelled meanwhile.
        }
      },
      async cancel(reason) {
        quietly(() => {
          call.closing();
        });
        detach();
        await original.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return withUrl(new Response(body, { ...init, headers: response.headers }), response.url);
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

const originalFetch = globalThis.fetch;

async function capturedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const sentAt = performance.now();
  const found = await capturedRequest(input, init);
  if (found === undefined) {
    return originalFetch(input, init);
  }
  const call = new CapturedCall(found.api, found.body, sentAt);
  if (!HUB.start(call)) {
    throw notSent(BLOCKED_TEXT, true);
  }
  if (call.renderOnly) {
    return renderOnlyResponse(call.api);
  }
  if (!found.httpScheme) {
    // helper-api §Transport Exceptions, URL scheme: the request is not sent, the call fails as
    // never arrived (`config`, not billed), and the SDK gets the transport's own error.
    const text = message('F3');
    call.fail({ endedAt: performance.now(), transport: 'connect', badScheme: true, text });
    throw notSent(text);
  }
  const given = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = given ? AbortSignal.any([given, call.cutter.signal]) : call.cutter.signal;
  let response: Response;
  try {
    response = await originalFetch(input, { ...init, signal });
  } catch (error) {
    quietly(() => {
      call.failedBeforeHeaders(error, given?.aborted === true);
    });
    throw error;
  }
  quietly(() => {
    call.gotHeaders(response, given);
  });
  return copyingResponse(response, call, signal);
}

globalThis.fetch = capturedFetch;
