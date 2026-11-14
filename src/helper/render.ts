import { isJsonArray, type JsonObject, type JsonValue } from '../adapter/json-types.js';
import {
  asCount,
  asDict,
  asList,
  type CapturedCall,
  chatMessage,
  type RenderMessage,
  renderFingerprint,
} from './capture.js';
import type { Trial } from './context.js';
import { exceptionText, message } from './messages.js';
import { type Decided, inSendOrder, isVariantModel, requestView } from './outcome.js';

// helper-api §Render Mode: the render result of the render target request, or of a render
// function, and the adapter errors of §When Render Fails.

const OUTPUT_LIMITS = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];

/**
 * The answer to a `render` once the service function has ended: A10 when an out-of-context
 * request met two trials in progress, A16 when `replyCall` raised, the render result of the
 * render target, A19 when that request has no message, else A11.
 */
export function renderDecision(trial: Trial): Decided {
  if (trial.outsideContext) {
    return failed(message('A10'));
  }
  const replyCall = trial.target.replyCall;
  try {
    for (const call of inSendOrder(trial.calls)) {
      if (!isVariantModel(call.model, trial.variant.model)) {
        continue;
      }
      if (replyCall === undefined || Boolean(replyCall(requestView(call)))) {
        if (!renderable(call)) {
          return failed(message('A19'));
        }
        return { kind: 'result', result: renderedRequest(call) };
      }
    }
  } catch (error) {
    return failed(message('A16', { exception: exceptionText(error) }));
  }
  return failed(message('A11'));
}

/**
 * The answer to a `render` whose render function ended: A10 as above, A17 when it raised, A18
 * when its value is not a render result, else that value normalised.
 */
export function renderFunctionDecision(
  trial: Trial,
  ended: { readonly value: unknown } | { readonly thrown: unknown },
): Decided {
  if ('thrown' in ended) {
    return failed(message('A17', { exception: exceptionText(ended.thrown) }));
  }
  if (trial.outsideContext) {
    return failed(message('A10'));
  }
  if (!isRenderResult(ended.value)) {
    return failed(message('A18'));
  }
  return { kind: 'result', result: normalisedRender(withoutUndefined(ended.value)) };
}

function failed(text: string): Decided {
  return { kind: 'error', message: text, data: {} };
}

/**
 * Whether the render target request gives a render result: at least one message, every message
 * with a role (an item without `role` and `type` has none), and `tools` absent or a list.
 */
function renderable(call: CapturedCall): boolean {
  const messages = call.messages;
  if (messages.length === 0 || messages.some((item) => item.role === '')) {
    return false;
  }
  return call.tools === undefined || call.tools === null || isJsonArray(call.tools);
}

/** The render result of the render target request. */
function renderedRequest(call: CapturedCall): JsonObject {
  const limit = OUTPUT_LIMITS.map((name) => asCount(call.body[name])).find(
    (value) => value !== undefined && value > 0,
  );
  return renderResult(call.messages, call.tools, limit);
}

/**
 * helper-api §Render Mode, render function: an object whose `messages` is a non-empty list of
 * objects with a non-empty string `role`, whose `tools`, when given, is a list and whose
 * `maxOutputTokens`, when given, is a positive integer; and all of it JSON.
 */
function isRenderResult(value: unknown): value is JsonObject {
  if (!isPlainObject(value)) {
    return false;
  }
  const messages = value['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  for (const item of messages) {
    if (!isPlainObject(item) || typeof item['role'] !== 'string' || item['role'] === '') {
      return false;
    }
  }
  const tools = value['tools'];
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
    return false;
  }
  const limit = value['maxOutputTokens'];
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      return false;
    }
  }
  return isJson(messages) && (tools === undefined || isJson(tools));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A value JSON can carry: no object of another class, NaN, infinity or `undefined` list element;
 * an object member that is `undefined` counts as absent.
 */
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    // `Array.from` reads a hole as `undefined`, which is not JSON; `every` would skip it.
    return Array.from(value as unknown[]).every(isJson);
  }
  return (
    isPlainObject(value) &&
    Object.values(value).every((member) => member === undefined || isJson(member))
  );
}

/** The value with object members that are `undefined` left out, as JSON writes it. */
function withoutUndefined(value: JsonObject): JsonObject {
  const copy = (item: unknown): JsonValue => {
    if (Array.isArray(item)) {
      return item.map(copy);
    }
    if (isPlainObject(item)) {
      return Object.fromEntries(
        Object.entries(item).flatMap(([key, member]) =>
          member === undefined ? [] : [[key, copy(member)]],
        ),
      );
    }
    return item as JsonValue;
  };
  return copy(value) as JsonObject;
}

/** A render function's result, its `messages` read as Chat Completions messages. */
function normalisedRender(value: JsonObject): JsonObject {
  const messages = asList(value['messages']).map((item) => chatMessage(asDict(item)));
  const tools = value['tools'];
  return renderResult(
    messages,
    isJsonArray(tools) ? tools : undefined,
    asCount(value['maxOutputTokens']),
  );
}

function renderResult(
  messages: readonly RenderMessage[],
  tools: JsonValue | undefined,
  limit: number | undefined,
): JsonObject {
  const result: Record<string, JsonValue> = {
    messages: [...messages],
    fingerprint: renderFingerprint(messages, tools),
  };
  if (tools !== undefined && tools !== null) {
    result['tools'] = tools;
  }
  if (limit !== undefined) {
    result['maxOutputTokens'] = limit;
  }
  return result;
}
