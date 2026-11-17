// helper-api §Messages: every sentence, one entry per variant, under the IDs of
// test/fixtures/helper/messages.json. Placeholders are written <name>.

const MESSAGES = {
  A1: 'No model request was captured. Import the helper before the service (in Node, before any SDK client is created), and let the SDK send through httpx or httpx2 (Python) or the global `fetch` (Node). If the service calls the model through another transport (Bedrock, Vertex AI, a child process such as the Claude Agent SDK), give the answer as `Result(raw=, final=, finish_reason=, usage=, model=)` and throw failures as `ModelCallError`. If the case takes a path that calls no model (an input block, a fixed message), remove the case or change its input.',
  'A1-raised':
    'The target function raised <exception>. No model request was captured. Import the helper before the service (in Node, before any SDK client is created), and let the SDK send through httpx or httpx2 (Python) or the global `fetch` (Node). If the service calls the model through another transport (Bedrock, Vertex AI, a child process such as the Claude Agent SDK), give the answer as `Result(raw=, final=, finish_reason=, usage=, model=)` and throw failures as `ModelCallError`. If the case takes a path that calls no model (an input block, a fixed message), remove the case or change its input.',
  A2: "No request went to the variant model `<model>` (captured: <models>). Check that the adapter passes the variant model to the service. If the answer came through an uncaptured transport (Bedrock and similar), give `Result(raw=, final=, finish_reason=, usage=, model=)`. If a call before the answer failed or timed out and the service never requested the answer, throw that failure as `ModelCallError` with that call's `model`; if it refused, remove the case or change its input.",
  'A2-raised':
    "No request went to the variant model `<model>` (captured: <models>). Check that the adapter passes the variant model to the service. If the answer came through an uncaptured transport (Bedrock and similar), give `Result(raw=, final=, finish_reason=, usage=, model=)`. If a call before the answer failed or timed out and the service never requested the answer, throw that failure as `ModelCallError` with that call's `model`; if it refused, remove the case or change its input. The target function raised <exception>.",
  'A2-result-model':
    '`Result(model=)` gives <models>, not the variant model `<model>`. Give the model the service called; if the service did not call the variant model, check that the adapter passes it to the service.',
  'A3-a':
    "Cannot choose the answer call (`reply_call` is true only for calls to <models>). Make `reply_call` true for the variant model's answer calls.",
  'A3-a-raised':
    "Cannot choose the answer call (`reply_call` is true only for calls to <models>). Make `reply_call` true for the variant model's answer calls. The target function raised <exception>.",
  'A3-b':
    'Cannot choose the answer call (no call is true for `reply_call`). Make `reply_call` true for the answer calls; if the service shipped a fixed message without requesting the answer, wrap it with `fallback`.',
  'A3-b-raised':
    'Cannot choose the answer call (no call is true for `reply_call`). Make `reply_call` true for the answer calls; if the service shipped a fixed message without requesting the answer, wrap it with `fallback`. The target function raised <exception>.',
  'A3-c':
    'Cannot choose the answer call (the variant model got requests that are neither resends nor tool-loop steps of one another, such as a classification or a memory write besides the answer). Set `reply_call` to select the answer calls.',
  'A3-c-raised':
    'Cannot choose the answer call (the variant model got requests that are neither resends nor tool-loop steps of one another, such as a classification or a memory write besides the answer). Set `reply_call` to select the answer calls. The target function raised <exception>.',
  'A3-d':
    'Cannot choose the answer call (the answers came from requests with different system prompts). If the service regenerates with a changed system prompt, give the first answer as `Result(raw=)`; otherwise make `reply_call` false for side calls.',
  'A3-d-raised':
    'Cannot choose the answer call (the answers came from requests with different system prompts). If the service regenerates with a changed system prompt, give the first answer as `Result(raw=)`; otherwise make `reply_call` false for side calls. The target function raised <exception>.',
  'A3-raw-unread-systems':
    'Cannot choose the answer call (unread responses have different system prompts). Set `reply_call`.',
  'A3-raw-other-answer':
    "Cannot choose the answer call (another variant model request, not a resend or tool-loop step of the raw answer's request, also got an answer). If it is a side call, exclude it with `reply_call`; if it is a regenerated answer, give `Result(finish_reason=, answers=)`.",
  'A3-raw-unread-follows':
    'Cannot choose the answer call (an unread response follows the raw answer). If it is a side call, exclude it with `reply_call`; if it is a regenerated answer, give `Result(finish_reason=, answers=)`.',
  A4: 'Every answer call ended in a tool call. If the service takes its final answer as a tool call, set `answer_tool`.',
  A5: 'Streaming responses are not parsed yet. Give the raw answer and finish reason the service received as `Result(raw=, finish_reason=)`.',
  A6: 'Responses background mode is not parsed. Give the final output and finish reason the service received later as `Result(raw=, finish_reason=)`.',
  A7: 'Cannot find the call that produced the raw answer: no answer of the variant model `<model>` has its text (captured: <models>). If you changed a captured answer, give it unchanged. If the answer came through an uncaptured transport, give `Result(model=)` with `finish_reason=` and `usage=`. If a same-model call before the answer refused and the answer was never requested, give `Result(raw="", kind="fallback", finish_reason="other")`; exclude that call with `reply_call` when it was captured, and add `model=` and `answers=0` when it was not. If the captured calls went only to other models, check that the adapter passes the variant model to the service, or remove cases where another model\'s call before the answer keeps the service from calling it.',
  A8: '`answers=0` was given but a fully received answer exists. If the answer was fully received before the check blocked, give the first answer as `Result(raw=, kind="fallback")`, adding `finish_reason="other"` when an answer came as a stream, two or more answers were received or a stream was cut after it, and in the last two cases the received count as `answers=`, not counting the stream the check cut (`kind="discarded"` for a discard). If it is the answer of a same-model check, exclude that call with `reply_call`. For a streaming tool loop with `answer_tool`, do not give `answers=0`.',
  A9: '`Result(finish_reason=)` is required: the answer that decides the finish reason is an unread response or an uncaptured call.',
  A10: 'A model request was made outside any trial context (run with `--concurrency 1`, or have the service pass the context).',
  A11: 'Could not reach the render target request.',
  A12: '`ModelCallError` takes exactly one of `status` (an HTTP status code), `kind` (`connect`, `tls`, `disconnect` or `timeout`) and `call` (a call of this trial).',
  A13: '`call` takes only a failure the service received, and with `reply_call` only a failure of an answer call.',
  A14: 'The target function returned a value that is not text, `fallback(text)` or a valid `Result`. Return the shipped text; a missing `return` gives None, and only a discarded `Result` may have `final=None`.',
  A15: 'This target has no render mode. Set `render` on it, or move targets without render mode to a separate adapter, which then does not declare `render`.',
  A16: "Deciding the trial's outcome failed: <exception>. If `reply_call` or `discard_on` raised it, fix that function; otherwise report it as a helper defect.",
  A17: 'The render function raised <exception>.',
  A18: 'The render function returned a value that is not a render result. Return `{messages, tools?, maxOutputTokens?}` with `messages` a non-empty list of message objects, `tools` a list and `maxOutputTokens` a positive integer.',
  A19: 'The render target request cannot be rendered: it has no message (a Responses request continuing a conversation stored on the server), a message without a role, or `tools` that is not a list. Return the assembled messages with `@adapter.render`.',
  F1: 'The response body is not a JSON object.',
  F2: 'The tool cancelled the trial.',
  F3: 'The request URL does not start with http:// or https://; check base_url.',
  row9: 'The target function raised <exception>. If the service raises it when it discards an answer, add it to `discard_on` (a target function that gives raw catches it and returns `Result(raw=, kind="discarded", discard_reason=)`); if the service\'s time limit raised it, catch it and throw `ModelCallError(kind="timeout")`.',
  W1: 'In a trial that received an answer, a call to `<model>` failed transiently and the trial ended in a fallback or discard. If it was the regeneration request, this is correct. If the service shipped a message or discarded the answer because of that failure, throw the failure. If it was an unrelated call the service swallows and moves past (memory writes and similar), leave it.',
  'W1-variant':
    'In a trial that received an answer, a call to the variant model failed transiently and the trial ended in a fallback or discard. If it was the regeneration request, this is correct. If the service shipped a message or discarded the answer because of that failure, throw the failure. If it was an unrelated call the service swallows and moves past (memory writes and similar), leave it.',
  W2: "The shipped text may be another model's answer (`<model>`). If the service shipped it, wrap it with `fallback`.",
  W3: 'The last answer did not end with `stop`, but an earlier answer of the same request did. If the service picked an answer, give its finish reason as `Result(finish_reason=)`.',
  W4: "No captured answer has the raw answer's text, so it was added as an uncaptured call and its cost may be counted twice. Give a captured answer unchanged; if the captured answer belongs to a side call, exclude it with `reply_call`.",
  W5: "Decided by a captured call's failure instead of the given raw answer. If the answer request failed (a provider error, a rate limit, a dropped connection, also mid-stream after some text arrived), this is correct. If the failed call is a same-model side call, exclude it with `reply_call`.",
  'W5-cut-last-answer':
    'Decided by a captured call\'s failure instead of the given raw answer. If the service cut a regeneration after it fully received an earlier answer, give `answers=` (counting the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut text, a fixed message or another model\'s answer (`kind="discarded"` for a discard). If the answer request failed (a provider error, a rate limit, a dropped connection, also mid-stream after some text arrived), this is correct. If the failed call is a same-model side call, exclude it with `reply_call`.',
  W6: 'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a configured stop string, `stopped_early=True`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event.',
  'W6-cut-last-answer':
    'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service cut a regeneration after it fully received an earlier answer, give `answers=` (counting the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut text, a fixed message or another model\'s answer (`kind="discarded"` for a discard). If it sent a modified request alongside and shipped the answer that came first, select both requests with `reply_call` and give `Result(finish_reason=, answers=1)`. If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a configured stop string, `stopped_early=True`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event.',
  'W6-stopped-early-ignored':
    'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event.',
  'W6-stopped-early-honoured':
    'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event. `stopped_early` was given, but the stream was cut during an awaited read or was still being read when the function returned, which looks like a time limit; stop with `break` from the SDK\'s plain stream iterator, or call `abort()` in a Node stream helper\'s event handler before any `await`.',
  'W6-cut-last-answer-stopped-early-ignored':
    'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service cut a regeneration after it fully received an earlier answer, give `answers=` (counting the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut text, a fixed message or another model\'s answer (`kind="discarded"` for a discard). If it sent a modified request alongside and shipped the answer that came first, select both requests with `reply_call` and give `Result(finish_reason=, answers=1)`. If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event.',
  'W6-cut-last-answer-stopped-early-honoured':
    'Decided as a time-out instead of the given raw answer (the service stopped receiving before the model\'s answer was complete). If the service cut a regeneration after it fully received an earlier answer, give `answers=` (counting the cut answer) and `finish_reason=`, with `kind="fallback"` if it shipped the cut text, a fixed message or another model\'s answer (`kind="discarded"` for a discard). If it sent a modified request alongside and shipped the answer that came first, select both requests with `reply_call` and give `Result(finish_reason=, answers=1)`. If the service\'s time limit cut it, this is correct. Otherwise, by cause: a content cut, give `kind="fallback"` and `finish_reason="other"` (`kind="discarded"` for a discard); an input check sent with the answer that blocked it, `Result(raw="", kind="fallback", answers=0)`; a cut same-model side call, exclude it with `reply_call`; another call\'s failure that left the service no answer to ship, throw that failure; returning on an event saying the text ended, read the stream to its end event. `stopped_early` was given, but the stream was cut during an awaited read or was still being read when the function returned, which looks like a time limit; stop with `break` from the SDK\'s plain stream iterator, or call `abort()` in a Node stream helper\'s event handler before any `await`.',
  W7: '`stopped_early` is honoured only with a non-empty raw answer and kind `model`.',
  W8: 'The raw answer may come from a response of `<model>`, not the variant model. Check that the adapter passes the variant model to the service.',
  W9: 'Input tokens minus cache hits and cache writes was negative and was set to 0. The provider may have changed what the usage fields mean.',
  W10: 'The thrown failure may belong to an earlier attempt that was resent. Throw the failure the service received.',
  L1: 'Service version not reported: <reason>.',
  L2: 'Unhandled exception in background work: <exception>.',
  L3: 'A request of an abandoned trial was cut or blocked: <exception>.',
} as const;

export type MessageId = keyof typeof MESSAGES;

/**
 * The sentence of `id` with its placeholders filled. A '.' right after a placeholder is left
 * out when the value already ends with '.', '!' or '?'.
 */
export function message(
  id: MessageId,
  placeholders: Readonly<Record<string, string>> = {},
): string {
  let text: string = MESSAGES[id];
  for (const [name, value] of Object.entries(placeholders)) {
    const marker = `<${name}>`;
    // split and join, because a replacement string would read `$&` and similar in the value.
    if (/[.!?]$/.test(value)) {
      text = text.split(`${marker}.`).join(value);
    }
    text = text.split(marker).join(value);
  }
  return text;
}

// The 25 Unicode White_Space code points of data-model §Comparing Text, which is exactly the set
// \p{White_Space} matches.
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** The text without White_Space at either end. */
export function trimText(text: string): string {
  return text.replace(EDGE_WHITE_SPACE, '');
}

/**
 * `<exception>`: `Class: message` with the message trimmed of White_Space, or the class name
 * alone when nothing remains; `String(e)`, trimmed, for a value that is not an `Error`.
 */
export function exceptionText(error: unknown): string {
  if (!(error instanceof Error)) {
    return trimText(plainText(error));
  }
  const name = error.constructor.name;
  const text = trimText(plainText(error.message));
  return text === '' ? name : `${name}: ${text}`;
}

/**
 * `String(value)`, or the default object tag when that throws (an object without a prototype, a
 * `toString` that raises).
 */
function plainText(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** `<models>`: distinct names in the order given, each in backticks, joined with ', '. */
export function modelList(models: readonly string[]): string {
  const distinct = [...new Set(models)];
  return distinct.length === 0 ? 'none' : distinct.map((model) => `\`${model}\``).join(', ');
}

const DISCARD_REASON_LIMIT = 200;

/** data-model Outcome row 8: the exception's `<exception>` text cut to its first 200 code points. */
export function discardReason(error: unknown): string {
  return Array.from(exceptionText(error)).slice(0, DISCARD_REASON_LIMIT).join('');
}
