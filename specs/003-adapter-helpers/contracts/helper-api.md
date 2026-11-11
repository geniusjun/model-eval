# Adapter Helper API Contract

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

The helpers handle the messages of [adapter protocol v1](../../001-swap-check/contracts/adapter-protocol.md) for the adapter author. They capture the model API requests the service code sends at the HTTP layer and fill in the raw answer, tokens, finish reason and error kind. The adapter author writes two things: one target function that calls the service function with the case input and returns the shipped text, and the exceptions the service raises when it discards an answer.

| Job | What the helper does |
|---|---|
| Protocol | Reads and writes messages; answers `initialize`, `render`, `generate`, `cancel` and `shutdown`; runs concurrent requests and matches responses |
| Capture | Records the model API requests the service sends, and their responses, at the HTTP client layer (§Captured Requests) |
| Outcome | Derives the trial result from the captured calls and the service function's result ([data-model §Outcome Decision](../data-model.md#outcome-decision)) |
| Errors | Decides `transient`, `timeout`, `permanent` or `config` from HTTP status and error codes (§Error Classification) |
| Render | Runs the service function in render mode, captures the answer request and sends no captured model request to the network (§Render Mode; uncaptured transports in §Not Captured) |
| stdout | Keeps protocol output on its own channel and sends the service's standard output to stderr (§stdout Protection) |
| Service version | Reports `version`, `dirty` and `treeHash` of `service_dir` ([data-model §Service Version](../data-model.md#service-version)) |

## Python (`model_eval_adapter.py`)

```python
from model_eval_adapter import Adapter, fallback        # import before the service (§Captured Requests, §stdout Protection)
from my_service import reply, EmptyReply

adapter = Adapter(name="my-chat", version="0.1.0", service_dir="../my-service", max_concurrency=4)

@adapter.target("chat", languages=["ko", "en", "ja"],
                input_schema={"type": "object", "required": ["user"]},
                render=True,                         # render mode (§Render Mode)
                discard_on=(EmptyReply,))            # raised when the service discards an answer (data-model Outcome row 8)
async def chat(case, variant):
    r = await reply(case.input["user"], lang=case.lang, model=variant.model)
    return fallback(r.text) if r.is_fallback else r.text

if __name__ == "__main__":
    adapter.run()
```

- Synchronous target functions are accepted. They run through `asyncio.to_thread` and, on `cancel`, run to the end: requests in flight complete, and later requests are not sent (§Cancel). Asynchronous functions are cancelled on `cancel`.
- Distribution: `init --adapter python` copies this one file next to the adapter (§Distribution).

## TypeScript (`model-eval/adapter`)

```ts
import { defineAdapter, fallback } from "model-eval/adapter";   // import before the service (§Captured Requests, §stdout Protection)
import { reply, EmptyReply } from "./service.js";

defineAdapter({
  name: "my-chat",
  version: "0.1.0",
  serviceDir: "../my-service",
  maxConcurrency: 4,
  targets: {
    chat: {
      languages: ["ko", "en"],
      inputSchema: { type: "object", required: ["user"] },
      render: true,
      discardOn: [EmptyReply],
      async generate(c, variant) {
        const r = await reply(c.input.user, { lang: c.lang, model: variant.model });
        return r.isFallback ? fallback(r.text) : r.text;
      },
    },
  },
}).listen();
```

- The helper is a subpath of the tool package, so installing the tool as a development dependency in the adapter folder brings it along.
- On `cancel` it aborts the trial's `fetch` calls in flight and sends no later `fetch` (§Cancel).
- However many copies of an SDK the service loads, their requests are captured as long as they go through the global `fetch`.

## Shared Conventions

- Names follow each language's convention (Python snake_case, TypeScript camelCase); meanings are the same.
- Values that both languages must produce identically (the values of [spec FR-024](../spec.md#functional-requirements)) are written as the same bytes. Both helpers write canonical JSON per [001 data-model §Canonical JSON](../../001-swap-check/data-model.md#canonical-json), and read JSON text (request and response bodies, `answer_tool` arguments) with its reading rules.

### Adapter Options

| Python | TypeScript | Meaning |
|---|---|---|
| `name`, `version` | `name`, `version` | Reported as `adapter` in `initialize`. Adapter code outside `service_dir` is known only by this version, so bump it on changes (001 data-model §Resume and Locking) |
| `service_dir` | `serviceDir` | Folder whose version is reported. Relative paths resolve from `adapter.cwd`; without it nothing is reported ([data-model §Service Version](../data-model.md#service-version)) |
| `max_concurrency` | `maxConcurrency` | Reported as `capabilities.maxConcurrency` |

The helper also reports `adapter.helper` with its language and version ([001 adapter-protocol §`initialize`](../../001-swap-check/contracts/adapter-protocol.md#initialize-tool--adapter-required)), and `capabilities.stages` and `capabilities.cancel` as true. Declaring `cancel` makes the tool send `cancel` for trials it abandons, and the helper then cuts and blocks that trial's requests (§Cancel). A `Result` without `stages` means the trial has no stage record.

### Target Options

Python `@adapter.target(...)`, TypeScript `targets.<name>`:

| Python | TypeScript | Meaning |
|---|---|---|
| `languages` | `languages` | The target's languages |
| `input_schema` | `inputSchema` | JSON Schema of a case's input |
| `render` | `render` | True: render mode (§Render Mode). A function: it receives `(case, variant)` and returns the render result `{messages, tools?, maxOutputTokens?}` itself (a dict with the same keys in Python). Python also accepts it as a decorator that takes the target name, `@adapter.render("chat")` |
| `discard_on` | `discardOn` | Exceptions the service raises when it discards an answer: a list of exception classes, or a function that receives the exception and returns true or false |
| `reply_call` | `replyCall` | Chooses the answer calls ([data-model §Answers](../data-model.md#answers)). Receives one call and returns true or false. Render mode has no responses, so write it to decide from request fields only (`model`, `messages`, `tool_names`) |
| `answer_tool` | `answerTool` | For services that receive the final answer as a tool call: the tool name and the argument key that holds the text, for example `("reply", "text")` (TypeScript `["reply", "text"]`). A response that calls that tool is an answer |
| `postprocess` | `postprocess` | False when the service has no post-processing. Default true; reported as `capabilities.postprocess` (constitution I) |

### Target Function

The target function receives `(case, variant)`; when it accepts a third argument, that argument is the list of calls captured in this trial so far.

- `case`: `id`, `lang`, `input`, `repeat`, `seed`, `rendering` (true in render mode, where `repeat` is 0).
- `variant`: `id`, `model`, `params`.

Fields of a call (an element of the third argument and the argument of `reply_call`):

| Python | TypeScript | Meaning |
|---|---|---|
| `model` | `model` | The request's model |
| `messages` | `messages` | The request's messages, in the shape of the render result's `messages` (§Render Mode) |
| `tool_names` | `toolNames` | Names of the tools in the request |
| `text` | `text` | Response text |
| `tool_calls` | `toolCalls` | The response's tool calls |
| `tool_args(name)` | `toolArgs(name)` | Arguments of the tool call with that name |
| `finish_reason` | `finishReason` | The provider's finish reason, unmapped |
| `usage` | `usage` | Token buckets |
| `outcome` | `outcome` | `ok`, `failed` or `unanswered` (001 data-model §Trial, call record). Absent for calls that have not ended ([data-model §When a Call Ended](../data-model.md#when-a-call-ended); an SSE response with a generation-end marker ends when the marker was read) and in render mode. `reply_call` never receives it for unfinished calls |
| `error` | `error` | The failure of a failed call, under the same names as `ModelCallError`. For an error response: `status` (200 when it started with 200 and ended in failure), `type` when the error object was read, and `code` when present, equal to `ModelCallError`'s fields of the same name. For a failure without a status code, mid-body failures included: `kind` (`connect`, `tls`, `disconnect`, `timeout`). `retry_after_ms` (`retryAfterMs`) when the response said how long to wait. Absent for calls that did not fail or have not ended, and in render mode. Pass it as is to throw a captured failure the service swallowed: Python `ModelCallError(message=…, model=c.model, **c.error)`, TypeScript `new ModelCallError({ message, model: c.model, ...c.error })` |
| `retried` | `retried` | For a failed call: true when a request was sent in the same branch ([data-model §Call Branches](../data-model.md#call-branches)) after the failure ended, by an SDK or service resend or a request continued with a corrected tool result; else false. The service sent again after that failure, so that failure did not stop it (§Trials Stopped by Another Call's Failure). Only branches are checked, so in a service that sent the same request in parallel it is also true when the other copy was resent afterwards. Absent for calls that did not fail or have not ended, and in render mode |

### Return Values

The target function returns the shipped text, `fallback(text)` or a `Result`. TypeScript builds a result with `result({ final, raw, … })`, from the same module as `fallback`. Values given in a `Result` override the defaults of [data-model §Outcome Decision](../data-model.md#outcome-decision).

#### `Result`

| Python | TypeScript | Meaning |
|---|---|---|
| `final` | `final` | The shipped text |
| `kind` | `kind` | `model`, `fallback` or `discarded`. Default `model` |
| `discard_reason` | `discardReason` | Why it was discarded. A `Result` with `kind="discarded"` is treated like a `discard_on` exception in the outcome decision (data-model Outcome row 8, the Outcome row 5 exception, data-model §Raw Cannot Be Determined). A service that gives raw and ends with a `discard_on` exception has the target function catch it and return `Result(raw=, kind="discarded", discard_reason=)`, with the reason in Outcome row 8's format |
| `stages` | `stages` | Text after each post-processing stage, reported as protocol `stages` ([001 adapter-protocol §`generate`](../../001-swap-check/contracts/adapter-protocol.md#generate-required)) |
| `raw` | `raw` | The raw answer (the model's first answer). When given, the helper does not pick one ([data-model §When the Adapter Gives Raw](../data-model.md#when-the-adapter-gives-raw)). Rules for when to give it: §When to Give `raw` |
| `answers` | `answers` | Number of answers the service received, counted per [001 adapter-protocol §Answers](../../001-swap-check/contracts/adapter-protocol.md#answers). Overrides the helper's count. For services the helper cannot count (regenerating with streams, receiving again after a content cut), and for trials whose raw call is a stream cut late (a modified request sent in parallel, or a refined re-received answer: give 1); the helper counts a cut stream only when it is the raw call. In trials with a cut answer, this value tells whether the service received a full answer (data-model §Cut Last Answer) |
| `finish_reason` | `finishReason` | Finish reason on the protocol scale. Required when the answer that decides it is an unread response or an uncaptured call (data-model §Answer Candidate Calls When Raw Is Given, finish-reason check) |
| `stopped_early` | `stoppedEarly` | True for a trial where a configured string (a client-side stop string) appeared and the service stopped reading the stream on purpose, before the model finished, and answered with the received text. Honoured only with a non-empty raw answer and kind `model`, and then only a stream stopped without an awaited read escapes the time-out (data-model §Cut Streams, view 3; K8 and K9 of [data-model §Known Limits](../data-model.md#known-limits)). Otherwise it is ignored and warning W7 is attached. Never give it for trials cut by a content check or a time limit; such trials would pass as complete |
| `usage` | `usage` | Token buckets of the call that produced the raw answer; the helper puts them into the raw call's `usage`, replacing any value. When raw came through an uncaptured transport, it goes with that call into `calls` (data-model §Raw Call). With captured calls, give that one call's value, not the trial total; a total counts the other captured calls' tokens twice. With no captured call, give the sum over all of the trial's calls; it becomes the trial's `usage` |
| `model` | `model` | Model name of the call that produced the raw answer. Given when raw came through an uncaptured transport; required when the raw call is the uncaptured call (data-model §Raw Call). The helper trusts it and checks only that it is the variant model (data-model Outcome row 4). The helper cannot verify that the service really called it, so take it from the response the service received or the setting the service used |
| `model_snapshot` | `modelSnapshot` | Model (snapshot) of the response that produced raw; overrides the helper's value. Give it when the helper did not see that response (uncaptured transport, unread response) and the service knows the response's model. Without it the trial takes no part in the response-model warnings (`response-model-changed`, `same-response-model`; 001 FR-010) |

#### When to Give `raw`

1. Give it when the service changes the system to regenerate, or receives the answer as a stream or through an uncaptured transport.
2. Do not give it for trials where the service got no model answer (it swallowed a call failure and shipped a fixed message). Two exceptions give an empty `raw=""` (§What the Target Function Reports): trials cut by a parallel check's refusal, and streaming services that use the same message for other causes and cannot tell them apart.
3. When the service cut the answer stream at its time limit with neither a fully received answer nor content-cut text, do not give the received text; throw the last failure that finished. When it cut late or stopped waiting, resent, and shipped the answer it received again, give the first answer, usually the re-received one (§Services That Stopped Waiting).
4. Wherever this contract says to give the pre-cut text or the re-received answer as raw, that holds only when no answer was secured before it (a fully received answer, or text cut for content; [001 adapter-protocol §Answers](../../001-swap-check/contracts/adapter-protocol.md#answers)). With a secured answer, raw is the first answer, and `answers=` and `finish_reason=` are given with it.
5. Give text received in a cut stream as raw together with `kind="fallback"` or `kind="discarded"` only for content cuts; late-cut text is not graded (data-model §Cut Streams, view 2).

### `ModelCallError`

The target function may throw `ModelCallError` in a trial that ended in a model call failure. TypeScript: `throw new ModelCallError({ status: 429, message, usage: { input: 0, output: 0 } })`, from the same module as `fallback`; `usage` 0 is for unbilled failures in services without captured calls (below). This lets calls whose failure the helper cannot see count as call failures instead of adapter errors:

- calls through transports outside §Captured Requests;
- captured calls whose response stayed unread ([data-model §Unread Response](../data-model.md#unread-response)); a background response can end later as `failed`.

Failure end events of streams (for example Anthropic `overloaded_error`) are captured by the helper (§End Events). Calls the helper already captured as failures need not be thrown again. When one is thrown with the error response's status code, or with `kind` for a failure without an error response, it is not counted twice ([data-model §Matching Reported Failures](../data-model.md#matching-reported-failures)). Trials where the service hit its own time limit, or did not answer because of another call's failure, are reported per §Services That Stopped Waiting and §Trials Stopped by Another Call's Failure.

| Python | TypeScript | Meaning |
|---|---|---|
| `message` | `message` | Error message |
| `status` | `status` | HTTP status the provider returned. 200 when the response was 200 but the body or stream reported failure (Responses `status: failed`, a failure end event) |
| `type` | `type` | `type` of the provider's error object (§Error Classification), for example `insufficient_quota`, `billing_error`, `overloaded_error` |
| `code` | `code` | Code of that error object (OpenAI `code`, Anthropic `details.error_code`), for example `insufficient_quota`, `enforced_spend_limit_reached`. Kept apart from `type` ([research R9](../research.md#r9-classify-errors-by-status-and-code-at-the-http-layer)) |
| `kind` | `kind` | A failure without a status code. `connect`: the request never arrived (no connection, connection-pool wait time-out, request not fully sent). `tls`: TLS certificate verification failed. `disconnect`: the connection dropped after sending, or a read time-out while receiving a non-stream body. `timeout`: a time limit before the response headers, a time limit waiting for the next stream event, or the service cancelled the request or stopped waiting before the full response |
| `retry_after_ms` | `retryAfterMs` | Wait before retry that the provider gave, in ms. Converted to a non-negative integer as in §`retryAfterMs`; dropped when negative or not finite |
| `model` | `model` | Model of the failed call. Default: the variant model |
| `usage` | `usage` | Same meaning as `Result(usage=)`. With no captured call, the sum over all calls of the trial; without it the tool charges the attempt reservation. With captured calls, the value of the failed call (usually absent) |
| `call` | `call` | The captured call (an element of the third argument) whose failure the service swallowed, given to report it as the trial's failure. It is used as the matching-failure candidate of [data-model §Matching Reported Failures](../data-model.md#matching-reported-failures) without searching, and `model` is that call's model (a `model` given with it is ignored). Adapter error A13 when that call is not an unrecovered failure (a successful call, an unfinished call, a recovered failure, a failure while a resent request was awaited), when its `retried` is true, or when `reply_call` exists and is not true for it (§The `call` Check) |

- Exactly one of `status`, `kind` and `call` is given. With two or more, or none, the helper decides adapter error A12 without consulting `discard_on` ([research R14](../research.md#r14-outcome-decision-trade-offs)).
- The error kind comes from §Error Classification. `status`, `type`, `code` and `message` take the places of the response's status, error type, code and message; providers are not distinguished, because the table's type and code names do not collide across providers. `kind` `connect` and `disconnect` map to the connection row, `tls` to the certificate row and `timeout` to the time-limit row. A thrown failure is thus classified on the same terms as a captured call.
- In a service without captured calls, when one unbilled failure ended the trial (an error response with a non-200 `status`, `connect`, `tls`), give `usage` 0 (`{"input": 0, "output": 0}`). Otherwise every trial of a candidate rejected every time piles up a reservation and the run stops on the cap instead of blocking ([001 adapter-protocol §Reporting Model Failures](../../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures)).

## Captured Requests

### Where

Requests are captured at the HTTP client layer: Python wraps `Client.send` and `AsyncClient.send` of both `httpx2` and `httpx` at class level; Node wraps `globalThis.fetch`. These are the default transports of the official OpenAI and Anthropic SDKs (§Supported SDKs). The helpers themselves use only the standard library (Node built-in modules).

### When

- Python: the helper never imports `httpx` or `httpx2` itself ([research R3](../research.md#r3-which-transports-to-wrap-and-when)).
  - Modules already loaded when the helper is imported are wrapped at once; modules loaded later are wrapped right after loading through an import hook. A service that imports the SDK late inside a function is still captured.
  - When `alias_httpx()` makes both names point to the same classes, they are wrapped once.
- Node: the wrap must happen before the service creates its SDK client (research R3). Put the helper import at the top of the adapter file; ESM evaluates modules in import order. When the structure loads service modules earlier than that, preload with `node --import model-eval/adapter adapter.mjs`.
- In both languages the helper is also imported before the service for §stdout Protection.

### Which Requests

POST requests whose path ends with a value below and whose JSON body has `model`. Matching by path suffix also captures proxies and mock servers behind a changed `base_url`. Every other request passes through untouched.

| API | Path suffix |
|---|---|
| OpenAI Chat Completions | `/chat/completions` |
| OpenAI Responses | `/responses` |
| Anthropic Messages | `/messages` |

### Trial Context

Calls are kept per trial in a context (Python `contextvars`, Node `AsyncLocalStorage`) so concurrent trials do not mix. Python synchronous functions run through `asyncio.to_thread`, which carries the context. Requests without a context, and requests after the service function returned, follow [data-model §Outside the Trial Context](../data-model.md#outside-the-trial-context) and [data-model §After the Function Returned](../data-model.md#after-the-function-returned).

## Reading Response Bodies

### Python

- The SDKs read non-stream bodies completely inside `send`. Bodies read later (SSE streams, the SDK's `with_streaming_response`) are not read ahead by the helper ([research R4](../research.md#r4-read-response-bodies-only-as-the-sdk-reads-them)): it wraps the response's byte stream, collects a copy as the SDK reads, and watches whether reading finished or failed.
- Header arrival: the helper always calls the original `send` with `stream=True` and takes its return as the time the headers arrived. When the caller asked for `stream=False`, the helper reads the whole body itself before returning, and closes the response when reading fails, as httpx's `send` does.

### Node

- The helper hands the SDK a response whose body is replaced by a stream that reads the original body only when the SDK reads, and collects a copy of what the SDK reads.
  - The stream does not read ahead (highWaterMark 0) and passes cancellation to the original.
  - Status and headers are the original's; `url` is set to the original value, which the SDK uses in logs and errors; statuses without a body (204, 205, 304) are built without one.
  - The request's `signal` is passed through, so the SDK's time-outs and cancels work unchanged.
- `clone()` is not used to read a separate copy (research R4).
- Header arrival is when the `fetch` promise resolves.

### Both Languages

- The copy is handled as bytes after removing `Content-Encoding`. Node's `fetch` already decodes the body. The byte stream the Python helper wraps is still compressed, so the helper decodes it with a new decoder of the same kind the response object uses; the decoder attached to the response belongs to the SDK, and sharing it would give the SDK an empty body. httpx and httpx2 advertise br and zstd when their decoder modules are installed, and the standard library alone cannot decode br, or zstd on Python 3.13 and earlier (research R4).
- Calls are split as follows:
  1. An error-status response (4xx, 5xx) is a failed call even when its body was not read; the kind comes from the status code and as much of the body as was read (§Error Classification). The official SDKs close error responses they will resend (429, 5xx and others) without reading the body: Python for `stream=True` requests, Node for all requests.
  2. A request that ended before the response headers, and a call whose awaited body read on a 2xx response ended by a drop, time-out or cancel, are failed calls. When the awaited read ended because other service work closed the body, it is a cancel even if the transport raises a connection error (Python httpcore raises `ReadError`). The helper wraps body closing to see this, so it decides the same as a Node `AbortController` cut.
  3. An SSE copy that receives a failure end event is a 200 response that ended in failure, ended when that event was received. The kind comes from the event's error object through §Error Classification. An SSE response whose awaited read reached the end of the body without an end event (cut by a proxy in between) is a mid-body drop.
  4. Not failures: a read failure or cancel after an end event reached the SSE copy, and a cancel after a generation-end marker reached it (§End Events).
  5. A 2xx body that was closed or cancelled with no awaited read is not a failure. When it was not read to the end by the time the service function returned, it is an unread response ([data-model §Unread Response](../data-model.md#unread-response)). Whether a read was awaited is checked when the body is closed or cancelled: Node, the abort of the request `signal` and the cancel of the copy stream; Python, closing the body and cancelling the reading task. A read started after that close or cancel and ended by it is not an awaited read, such as the extra read some SDKs make after `abort()` inside an event handler (research R4).
- For an SSE response (`content-type: text/event-stream`) the content is not parsed; only the markers of §End Events are read, and the call carries a stream mark ([data-model §Captured Call](../data-model.md#captured-call)). The copy and the markers are updated before the chunk is handed to the SDK (research R4).
- SSE lines are split by the HTML standard's event-stream rules: line ends CR, LF or CRLF; lines starting with `:` are comments; several `data` lines of one event join with a newline; an empty line ends the event.
  - When the body ended without a read error, the last line without a line end is included, and a last event without a trailing empty line counts as received when its `data` is complete: it parses as JSON, or is Chat Completions `[DONE]`. Both languages decide the same ([research R13](../research.md#r13-make-both-helpers-produce-the-same-bytes)). Otherwise it is a mid-body drop.
  - What the service receives still follows its SDK (K15 of [data-model §Known Limits](../data-model.md#known-limits)).

## End Events

| Marker | Chat Completions | Responses | Anthropic Messages |
|---|---|---|---|
| Normal end event | `data: [DONE]` | `response.completed`, `response.incomplete` | `message_stop` |
| Failure end event | A `data` line under an `event: error` line, or `data` whose top-level `error` is not `null` | `response.failed`, `error` | `error` |
| Generation-end marker | A normal end event, or a chunk after which, counting earlier chunks, every one of the request's `n` `choices` items (1 when `n` is absent) has a `finish_reason` | A normal end event only | A normal end event, or a `message_delta` with `stop_reason` |
| Stream ended in a tool call | Every `choices` item's `finish_reason` is `tool_calls` or `function_call` | `response.completed` whose output holds a tool-call item ([data-model §Finish Reasons](../data-model.md#finish-reasons)) | `stop_reason` is `tool_use` or `pause_turn` |

- End events are normal and failure end events. A generation-end marker says the model finished the answer; after it only usage and the end event follow. A failure end event is not a generation-end marker.
- Responses has only the normal end event as marker, because output items can still follow intermediate events such as `response.output_text.done`.
- A stream that ended in a tool call is one whose generation-end marker reports a tool call. Only these values are read, never the tool calls inside chunks ([data-model §Failure Check](../data-model.md#failure-check); K31 of [data-model §Known Limits](../data-model.md#known-limits)). Non-stream responses check content first ([data-model §Finish Reasons](../data-model.md#finish-reasons)).
- Drops and time-outs after a generation-end marker but before the end event stay failures, and data-model Outcome row 3 decides by them (research R4).
- Finding end events and generation-end markers, telling whether a marker reports a tool call, and reading a failure end event's error type and code look only at end markers, never at answer content (research R4).

## Error Classification

The first matching row decides. The kind comes from the status code and the error object's `type`, code (OpenAI `code`, Anthropic cause code `details.error_code`) and `message`, never from SDK exception class names.

- The error object is the error response body's, the `error` of Chat Completions and Anthropic stream events, and the `error` of a failed Responses response and of the response inside a `response.failed` event.
- For a Responses `error` event and a Chat Completions `event: error` event: their `error` when present, else the event itself (its top-level `type`, `code`, `message`). An event whose own `type` is `error` carries the event name there (the Responses `error` event), and that `type` is not taken as an error type.
- `ModelCallError` thrown by the target function is classified with this table too.

| Observation | Kind |
|---|---|
| Quota or spending limit exhausted: a 429 or a failed 200 response whose OpenAI error object has `type` or `code` `insufficient_quota`, or `code` `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`, `usage_limit_exceeded` or `billing_not_active` | `config` |
| Spending limit, organisation or key problem: a 429, 400 or 409, or a failed 200 response, whose Anthropic error object has `details.error_code` of: `enforced_spend_limit_reached` (the organisation passed its API tier's monthly limit); `organization_on_hold` (the organisation is suspended); `claude_code_key_creator_not_member` (the person who created the Claude Code workspace's API key left the organisation or that workspace); `claude_code_version_too_old` (the Claude Code version that sent the request is older than the model or organisation requires; services that call the model through Claude Code, such as the Claude Agent SDK, report it from the target function); `cmek_key_disabled` or `cmek_key_network_blocked` (the customer-managed encryption key cannot be used); `skill_read_blocked_undecryptable` (a custom skill the request uses cannot be read because of the workspace's encryption key state) | `config` |
| No conversation state: a 404 whose Anthropic error object has `details.error_code` `thread_not_found` (a conversation kept on the server through beta `thread` was not found; the service can resend the whole conversation and continue) | `permanent` |
| 401, 402, 403, 404 | `config` |
| Billing or limit error: a 400 or a failed 200 response whose Anthropic error object has `type` `billing_error`, or whose error message contains `credit balance` or `usage limit` (case-insensitive) | `config` |
| TLS certificate verification failure (a company proxy's certificate, a wrong address) | `config` |
| 429, 5xx (529 overloaded included) | `transient` |
| 200 but the response ended in failure (Responses `status: failed`, a stream's failure end event) with error code or type `server_error` or `rate_limit_exceeded` (OpenAI), or `api_error`, `overloaded_error`, `rate_limit_error` or `timeout_error` (Anthropic) | `transient` |
| The request never arrived (connection refused, name resolution failure, connect time-out, connection-pool wait time-out, request body not fully sent, a 408 saying the server did not receive the whole request); the connection dropped after sending and before the response headers (the server closed without a response); the connection dropped while receiving the body; a read time-out while receiving a non-stream body | `transient` |
| A time limit before the response headers (the SDK's or the service's); a time limit waiting for the next stream event; the service cancelled the request before the full response; the service stopped waiting without cutting the request ([data-model §Unfinished Calls Count as Time-Outs](../data-model.md#unfinished-calls-count-as-time-outs) and data-model §Failure Check, `ModelCallError` `kind`); when the adapter gives raw, the service stopped reading a stream before the generation-end marker (data-model §Cut Streams, view 1; without raw such a stream is an unread response per §Reading Response Bodies) | `timeout` |
| Other 4xx (400, 409, 413, 422 and others), any other failed 200 response | `permanent` |

- The complete list of transient failures is [001 data-model §Transient Failures](../../001-swap-check/data-model.md#transient-failures); this table maps that list to response shapes. Reasons for the 408, 409, connect time-out, `timeout_error` and certificate rows: [research R9](../research.md#r9-classify-errors-by-status-and-code-at-the-http-layer).
- The helper classifies a stream's failure end event with this table (§Reading Response Bodies). Failures the helper cannot see (transports outside §Captured Requests, a background response that fails later) are classified from the `ModelCallError` the target function throws.
- Context length exceeded (400) and parameters the candidate model does not accept (400) are `permanent`: that the candidate cannot take the service's request is a result to compare.
- Rows that read the error body's type, code or message (quota, billing, spending limit, organisation or key, conversation state) match only when the body was read. An error response the SDK closed before resending is classified by its status code alone. The SDKs read the error body of the last attempt to build the exception, so quota exhaustion still hits the `config` row on the last call.
- New quota and billing error shapes are added to this table as providers introduce them (research R9).
- The official SDKs resend 408, 409, 429, 5xx, connection errors and time-outs up to twice by default. The helper reports an error only after the SDK's retries failed. When the tool retries a `transient` trial, the whole service function runs again.
- Certificate failures are `config` and the call is `failed` (not billed).

### Transport Exceptions

Transport exceptions are not split by class name, because transport backends convert or hide exceptions (research R9). Whether response headers arrived, together with the original exception, tells apart: request never arrived, drop before headers, drop mid-body, certificate failure.

- **Python**: follow `__cause__` to the end, and for each exception in the chain also look at exceptions inside its `args`. `__context__` is not followed (research R9). When httpcore hides the original exception with `raise … from None`, it still sits in `args[0]`. An `ssl.SSLCertVerificationError` anywhere in the chain means the certificate row; self-signed, expired, unknown issuer and hostname mismatch all raise it.
- **Node**: follow the error's `cause` to the end and look at `code`.

  | undici code | Kind |
  |---|---|
  | `UND_ERR_CONNECT_TIMEOUT` | Request never arrived: `transient` |
  | `UND_ERR_HEADERS_TIMEOUT` | `timeout` |
  | `UND_ERR_BODY_TIMEOUT` | `timeout` for a stream, `transient` otherwise |
  | `UND_ERR_SOCKET` | `transient`, before headers or mid-body |

  The certificate row covers every code in the X509 certificate error code table of the Node `tls` module documentation (for example `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`) and the hostname mismatch `ERR_TLS_CERT_ALTNAME_INVALID`. The helper carries that table as a list (research R9).

### `retryAfterMs`

`retryAfterMs` of `transient` results and call records is:

1. the response's `retry-after-ms` header in ms when readable; else
2. the `retry-after` header read as seconds or as an HTTP date (RFC 9110; the difference to now, 0 for a past date).

- A number is read only when, after trimming leading and trailing whitespace, it has the form `[0-9]+(\.[0-9]+)?`. `retry-after: 1.5` is 1500 ms; `-1`, `30s` and `1e3` are not read.
- The number is read as a double and converted to ms x (seconds times 1000); the value is floor(x + 0.5), a non-negative integer. When x is not finite, nothing is read.
- HTTP dates are read in all three RFC 9110 forms as GMT; the standard functions of both languages read the asctime form as local time.
- When neither header is readable, nothing is recorded. Both helpers follow this rule rather than their SDK's reading ([research R13](../research.md#r13-make-both-helpers-produce-the-same-bytes)).

Call `outcome` for failed calls: [data-model §Call Outcome](../data-model.md#call-outcome).

## Cancel

- A call the helper cut on the tool's `cancel` stays `unanswered` and is not classified, because the tool has already abandoned the trial.
- After that, requests from that trial context are not sent: they fail at once as if the request never arrived, and are not recorded as calls. An abandoned trial then costs nothing more, and where service code keeps running after the cut (Python synchronous functions, Node), a request the SDK resends after waiting does not enter the late response.
- Only captured requests (§Which Requests) are blocked; other transports are not seen. Blocked requests are not reported as calls after the result (`calls` notifications) either.
- Exceptions in background work caused by a blocked request are logged with log warning L3, so they are told apart from environment problems.

## Render Mode

With `render=True` on a target, the helper runs the same service function in render mode when it receives `render`.

1. In render mode no captured model request goes to the network, variant model or not, trial context or not. Each gets an error response that is not retried: HTTP 400 with error type `render_only`.
2. The target function receives the same `case` as in generation, with `repeat` 0 and the seed of repeat 0 ([001 adapter-protocol §`render`](../../001-swap-check/contracts/adapter-protocol.md#render-optional-when-capabilitiesrender)). An adapter that picks fake-storage fixtures by case ID uses the same fixtures in render.
3. The render target is the first variant model request `reply_call` is true for; without `reply_call`, the first request to the variant model. The helper records it and builds the render result from it however the service function ends (exception, fixed message).

The render result:

- `messages`: the request's system as the first `system` message, followed by the conversation items in order. Anthropic `system` and Responses `instructions` become that first `system` message; the `system` and `developer` messages at the start of Chat Completions and in Responses `input` keep their roles.
  - Role names stay as in the request (`developer`, and Chat Completions `tool`, included). `content` is always a string: text parts join with `\n`; non-text parts leave only their kind, such as `[image]`, `[file]`, `[audio]`. Tool-call and tool-result parts (Anthropic `tool_use` and `tool_result` blocks, the Chat Completions `tool_calls` field) and reasoning items each become one line of canonical JSON.
  - Input items that are not messages (Responses `reasoning` items, the tool-call and result items of [data-model §Finish Reasons](../data-model.md#finish-reasons)) become `{role: <the item's type>, content: <the item's canonical JSON>}`.
  - A Responses `input` that is a string is one `user` message. An Anthropic `system` block list is one `system` message of its text blocks joined with newlines. Several `system` or `developer` messages at the start of Chat Completions stay separate, in order.
  - A Responses `prompt` (a reference to a stored prompt) becomes `{role: "prompt", content: <its canonical JSON>}`, placed right after the leading `system` and `developer` messages (those built from `instructions` included), or first when there are none. The prompt body is not in the request, so anchors cannot be checked against it ([spec §Assumptions](../spec.md#assumptions)), and the tool's input token estimate takes this into account ([001 data-model §Cost](../../001-swap-check/data-model.md#cost)).
- `tools`: the request's tool definitions; omitted when absent.
- `fingerprint`: the render fingerprint of `{messages, tools}` ([001 data-model §Identifiers and Hashing](../../001-swap-check/data-model.md#identifiers-and-hashing)).
- `maxOutputTokens`: the request's output limit, whichever of `max_tokens`, `max_completion_tokens` and `max_output_tokens` is present.

A render function given by the adapter (`@adapter.render`) has its result normalised the same way before the fingerprint is computed ([research R7](../research.md#r7-render-by-running-the-service-in-render-mode)).

### When Render Fails

When the service ends before reaching the render target request: adapter error A11. Lint reports it as `render-failed`, a run as a configuration error at the start (001 data-model §Send Order).

| Cause | What to do |
|---|---|
| A call to another model before the answer fails in render and the service stops | Return the assembly result directly with `@adapter.render` |
| The case takes a path that calls no model (an input block, a fixed message) | The path has nothing to do with the model, so the swap check has nothing to look at. Remove the case or change its input |

### When the Render Target Differs From the Answer Request

- A same-model classification call before the answer, without `reply_call`: render captures the classification request and lint checks anchors against the classification prompt, giving `anchor-missing`. In a run, a service whose answer is captured has two variant model branches, so data-model Outcome row 5 (A3); with the answer through an uncaptured transport, §Not Captured applies. When the adapter gives raw: a classification that answers in text gives Outcome row 5 (with `Result(finish_reason=, answers=)` given, `render-mismatch`), and a streaming classification gives Outcome row 5 for unread responses with different systems. In every case, `reply_call` sets the answer call.
- `render-mismatch` is raised by the tool during a run when the render fingerprint differs from `generate`'s `fingerprint` (001 FR-015). It has three causes:
  1. The first answer did not come from the branch of the first answer candidate request: the first request failed or ended only in tool calls and the service resent a modified request. Render captures the first answer candidate request.
  2. Prompt assembly mixed in values not fixed by the case input, such as the time or random numbers.
  3. The result of a call before the answer enters the prompt (a classification result picks a block). During render that call gets a 400 and the service assembles along its default path. Such a target function replaces that call with a fake returning a common production value when `case.rendering` is true, or returns the assembly result with `@adapter.render`. Trials whose real result of that call differs from the render value still raise the warning; to remove it, fix the value in the case input and return it from the fake in both render and generation ([001 plan D2](../../001-swap-check/plan.md#d2-the-adapter-runs-the-services-real-turn-function)).

### Conditions and Notes

- Requests outside the captured paths (for example embeddings) still go out during render. The adapter replaces calls that must not happen during render with fakes.
- The service function must run on fake storage, so nothing written during render stays outside. With no request to the variant model, render is an adapter error, and `lint --render` catches this setup mistake before any cost.
- A service with code that waits and resends failed requests renders that much slower. A service with a separate assembly function may return its messages directly with `@adapter.render`.
- A case whose call to another model before the answer refuses, so that the service never calls the variant model, has nothing to do with the swap: remove the case or change its input. Giving `model=` and `answers=0` for such a trial instead would add a variant model call that was never made and count a fallback that has nothing to do with the swap (data-model §Raw Call).

## stdout Protection

- **Python**: on import, the helper duplicates file descriptor 1 for protocol output and points descriptor 1 at stderr (`os.dup`, `os.dup2`). `print`, C extensions and child processes all write to stderr.
- **Node**: on import, the helper sends `process.stdout.write` and `console` output to stderr and writes the protocol through a writer kept aside. Node has no API to swap file descriptors, so output that native modules or child processes write directly to descriptor 1 is not stopped; the tool catches it as stdout contamination and shows the offending line ([001 adapter-protocol §Transport](../../001-swap-check/contracts/adapter-protocol.md#transport)).
- Output the service prints while it is imported is caught only if the helper is in place first, so in both languages the helper is imported before the service.

## What the Target Function Reports

The helper cannot see why a service stopped, cut a stream or shipped a message. In these situations the target function reports it:

| Situation | Report |
|---|---|
| The answer comes through an uncaptured transport (§Not Captured) | `Result(raw=, final=, finish_reason=, usage=, model=)`, plus `model_snapshot=` when known. Exclude captured same-model side calls with `reply_call`. Throw failures as `ModelCallError` (§Uncaptured Transports) |
| The answer comes as a stream | `Result(raw=, finish_reason=, usage=)`. With regeneration or a resend after a content cut, also `answers=` |
| A Responses request runs in background mode | `Result(raw=, finish_reason=, usage=)` from the final output the service received later (data-model §Raw Cannot Be Determined row 3) |
| The service regenerates through unread responses (streams) | Also `Result(answers=)`, because the helper cannot count those answers; otherwise a trial whose regeneration stream was cut becomes `timeout` under data-model §Cut Last Answer |
| The service cut a stream for content and shipped a fixed message | `Result(raw=<first answer>, kind="fallback", finish_reason="other")` (data-model §Cut Streams, view 2) |
| After a fully received answer, the service cut a regeneration stream and shipped the cut text or a fixed message | `kind="fallback"`, with `Result(answers=)` counting the cut answer and `Result(finish_reason=)` (data-model §Cut Last Answer) |
| The service stopped reading at a configured string and answered with the received text | `Result(raw=, finish_reason="stop", stopped_early=True)`, only for that trial (data-model §Cut Streams, view 3) |
| The service regenerates with a changed system | `reply_call` true for both answer calls, and the first answer as `Result(raw=)` |
| The service picks one of several answers | The picked answer's `Result(finish_reason=)` |
| The service ships another model's answer instead of the candidate's (it regenerates an answer that failed validation with a larger model, or sends the same request to another model and uses the first answer) | Wrap it with `fallback(text)` (data-model §Another Model's Answer) |
| The service takes its final answer as a tool call | Set `answer_tool`, also when giving raw. Otherwise that response is not an answer, and a same-model side call's failure becomes the trial's failure |
| The service makes same-model side calls as streams (a classification stream before the answer, a same-system validation stream after a cut answer) | Select the answer calls with `reply_call` (data-model §Failure Check; K29 of [data-model §Known Limits](../data-model.md#known-limits)) |
| A service that gives raw ends with a `discard_on` exception | Catch it and return `Result(raw=, kind="discarded", discard_reason=)` |
| The service hit its own time limit | §Services That Stopped Waiting |
| A service time limit raised an exception | Catch it and throw `ModelCallError(kind="timeout")`, so it counts as a time-out (a completion failure) |
| Another call's failure made the service not answer | §Trials Stopped by Another Call's Failure |
| A check sent with the answer refused and the service cut the answer request | §Trials Stopped by a Parallel Check's Refusal |
| The service filtered a received answer and the regeneration request failed | Nothing to throw (data-model §Outcome Row 6 Details) |
| The same message is shipped for several causes | §Services That Stopped Waiting, shared messages |
| The service hands model calls to a thread without the trial context, or calls a model from background work after returning (memory writes) | Switch that work off in the target function or await it inside it, so it neither joins the next trial nor hides fake-storage rejections (data-model §Outside the Trial Context, §Late and Later Requests; [001 plan D2](../../001-swap-check/plan.md#d2-the-adapter-runs-the-services-real-turn-function)) |

### Uncaptured Transports

1. A service that calls the model by other means than §Captured Requests fills `Result(raw=, final=, finish_reason=, usage=, model=)`, plus `model_snapshot=` when it knows the response's snapshot (data-model §When the Adapter Gives Raw), and throws `ModelCallError` when a model call fails. Do this even when no error appears: otherwise a captured same-model side call (intent classification) becomes the raw answer without an error and the answer's cost is lost.
2. A trial in which a call before the answer failed or refused, so the service never sent the answer request, is reported by whether that call was captured.
   - Captured: do not give `model=`. A failure is then decided by the helper (data-model §Failure Check, §No Searched Calls), and a refusal by a same-model classification excluded with `reply_call` becomes a fallback (the uncaptured-call exception). With `model=`, the helper would take the trial as an empty answer received over the uncaptured transport, add that call, and count an empty answer.
   - Not captured: throw the failure as `ModelCallError`; report a same-model refusal as `Result(raw="", kind="fallback", model=, answers=0, finish_reason="other")`. The uncaptured-call exception needs a captured variant model call, so without `model=` the trial is adapter error A7, and without `answers=0` it is taken as that call's empty answer.
3. When raw came through an uncaptured transport, data-model Outcome row 4 checks `model` even when captured variant model calls exist, and a missing `model` is an adapter error (the uncaptured call). Without confirming the variant model, both variants could be compared on the same model ([spec.md](../spec.md) User Story 1, scenario 8).
4. With no captured call, no `calls` is sent, so cost is priced from `usage`; without `usage`, the attempt is charged its reservation ([001 data-model §Cost](../../001-swap-check/data-model.md#cost)).
5. Requests of such transports are not blocked in render mode. Do not call them during render; return the assembly result with `@adapter.render` (§Render Mode).
6. When that transport calls several models (sub-agents), `Result(usage=)` is added as one call and priced entirely at the variant model (K16 of [data-model §Known Limits](../data-model.md#known-limits)).

### Services That Stopped Waiting

When the service hit its own time limit, whether it raised or shipped a fixed message and whether it cut the request or only stopped waiting, the target function reads the service's exception, message or marker and reports as below. The helper cannot know when the service stopped waiting ([data-model §Unfinished Calls Count as Time-Outs](../data-model.md#unfinished-calls-count-as-time-outs)). Unreported, these trials are decided as [data-model §Unfinished Calls Count as Time-Outs](../data-model.md#unfinished-calls-count-as-time-outs) states (cases 1 to 3 and its last paragraph; K5, K17 of [data-model §Known Limits](../data-model.md#known-limits)).

1. **No fully received answer and no content-cut text**: throw the last failure that finished ([001 adapter-protocol §Reporting Model Failures](../../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures), rule 2).
   - Not resent, or the resent request also hit a time limit: `kind="timeout"`. Also when the SDK was waiting before resending a failed request.
   - The resent request ended in another failure, such as a rate limit: throw it with `status` or `kind` (from the third argument's `error` when the service swallowed it), or give that call as `call`. When the earlier request the service only stopped waiting for ended before the function returned (its call in the third argument has `outcome`), the failure may overlap that late response and look recovered, so `call` would be adapter error A13; throw with `status` or `kind`.
   - The same request was sent in parallel: the failure of the one that ended later. When one ended in 429 and the time limit then cut the other, it is `timeout`. When one failed and the service cut the other because of it, see §Trials Stopped by Another Call's Failure.
2. **Content-cut text exists**: do not throw; report per data-model §Cut Streams view 2. With a fixed message, `Result(raw=<first answer>, kind="fallback", finish_reason="other")`, where the first answer is the text before the cut when no full answer came earlier. The same holds when a request resent afterwards ended by a time limit or a rate limit.
3. **The service resent and shipped the answer it received**: do not throw. Give the raw answer and answer count decided without the late response as `Result(raw=, answers=)`, usually the re-received answer and 1. A late response to a request the service stopped waiting for is not an answer the service received ([001 adapter-protocol §Answers](../../001-swap-check/contracts/adapter-protocol.md#answers)). When a modified request was resent, select both requests with `reply_call`; with a cut stream, also give `finish_reason=` (data-model §Cut Last Answer, raw call cut).

**Shared messages**: a service that ships the same message for other causes too (a swallowed call failure, another call's failure, the tool loop limit, a content check, a parallel check's refusal) does not throw `kind="timeout"` or give `answers=0` based on the message alone, or trials ended for those causes would count as `timeout` or as a check's refusal. Check the service's markers and the third argument in this order and use the first that applies. A trial whose side call failed after the answer was fully received matches both 1 and 2; 1 must come first so that it counts as that failure.

1. A service that stops on another call's failure: when the third argument holds that failure (a failure with `retried` false of a call that stops the service, such as the same request sent in parallel or a safety check), throw it per §Trials Stopped by Another Call's Failure. Failures of calls the service swallows and moves past (memory retrieval and similar) are not considered.
2. When the finish reason of the answer stream the service collected is readable and present, the model finished the answer: give the first answer (the received text when no full answer came earlier) as `raw=` with `kind="fallback"` and `finish_reason="other"`, and the count as `answers=` when two or more answers were received. An answer that failed validation is then a fallback whose text counts on raw rules. When the service keeps collecting in the background after it stopped waiting, the late answer becomes raw (K18 of [data-model §Known Limits](../data-model.md#known-limits)).
3. When the causes cannot be told apart, do not throw; let the helper decide. A service that receives answers with non-stream requests wraps the message with `fallback`; a service that receives them as streams gives `Result(raw="", kind="fallback", finish_reason="other")`, because a streaming service without raw turns a stream cut without an awaited read into the adapter error of data-model §Raw Cannot Be Determined. The helper then decides a swallowed failure of the answer request and a time limit that cut the request as that failure and `timeout`, and a trial that ended before sending the answer request as that failure (a side call before the answer) or a fallback (the tool loop limit) ([data-model §Outcome Decision](../data-model.md#outcome-decision)). The cases this leaves decided differently are K19 to K24 of [data-model §Known Limits](../data-model.md#known-limits).

### Trials Stopped by Another Call's Failure

When the service did not answer because another call failed (the same request sent in parallel, or a side call made before, after or alongside the answer), the trial counts as that failure ([001 adapter-protocol §Reporting Model Failures](../../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures), rule 3). Four cases:

- The service swallowed the failure and answered: the result stands (data-model §Outcome Row 6 Details).
- That failure made the service cut a regeneration stream (data-model §Cut Streams, view 4) and ship no answer: throw the failure.
- It cut the regeneration stream and shipped the earlier, fully received answer: give `answers=` without the cut stream and the shipped text's `finish_reason=`; when the first answer came as a stream, `answers=` counts the cut stream (usually 2; K10 of [data-model §Known Limits](../data-model.md#known-limits)).
- Those values are missing: an unread response after the raw answer is Outcome row 5, and a raw call that is the cut stream hits the finish-reason check or the cut last answer.

When a side-call failure makes the service raise an exception, the target function leaves the exception as is instead of converting and throwing it; data-model Outcome row 3 decides that failure. When the answer request was cut too, rule 2 below applies.

1. **Failed before the answer request was sent**, so the service never requested the answer: the helper decides that failure (data-model Outcome row 3; with raw given, data-model §Failure Check). The target function need not throw, and a service that gives raw does not give `Result(model=)` for such a trial (with it, the helper takes the trial as an answer over an uncaptured transport and does not decide the failure; data-model §No Searched Calls). Two cases the helper cannot decide, so the target function throws:
   - After that failure the service made another captured call and returned a value or raised a `discard_on` exception (it built an apology message with another model). Outcome row 3 takes that as moving past the failure and leaves it out. With any other exception, Outcome row 3 decides the failure.
   - The service did not cut that call but only stopped waiting under its own time limit (Node `Promise.race`). The call is unfinished and does not look like a failure, so throw `kind="timeout"` with that call's `model`. For another model, the unfinished-call candidate matches that call and no call is added. A time limit that cuts the request (Python `asyncio.wait_for`) makes the call fail with `timeout` and the helper decides it, so the result does not depend on how the service cuts.
2. **The failure made the service cut the answer request and not answer** (`asyncio.TaskGroup` cancelling sibling tasks): the target function throws that failure. For the same request sent twice, the failed one, not the cut one. Unthrown, Outcome row 3, Outcome row 6 and the failure check pick the cut answer request and the trial usually becomes `timeout` (the earlier failure when the SDK was waiting before resending that request).
3. **The answer was fully received, and that failure made the service ship a message or another model's answer instead, or end with a `discard_on` exception**: the target function throws that failure. Only wrapping with `fallback` makes a fallback, and leaving the discard exception makes a discard (data-model Outcome row 8). The failure of a regeneration request after the service filtered a received answer is not another call's failure and is not thrown (data-model §Outcome Row 6 Details).
4. **What to throw**: the status code or kind of the service's exception when there is one; when the service swallowed the failure, that call's `error` from the third argument.
   - The third argument also holds earlier attempts the SDK resent and recovered, so never throw the failure of a call whose `retried` is true. The service received the result of the later request, and throwing would turn a normal trial into a transient failure the service never got.
   - For a side call, give that call's model as `model`. Matching (data-model §Matching Reported Failures) then avoids counting it twice.
   - When a same-model call failed without a status code (its `error` holds only `kind`), the thrown `kind` can also match the cut answer request (time-out, cancel) and give `timeout`, so give that call as `call` when possible. When `call` cannot be used: §The `call` Check.
5. A same-model side call excluded by `reply_call` is not a matching candidate, so the thrown value matches an answer call or is added as a new call.
   - When an answer request failed by time-out or cancel, a failure without a status code matches it and gives `timeout` (K25 of [data-model §Known Limits](../data-model.md#known-limits)).
   - When an answer stream was cut without an awaited read and became unread, `status` 200 and `disconnect` or `timeout` match that stream and the thrown value decides (the started-response candidate).
   - Otherwise (the answer was fully received, for example) nothing matches; a new call is added and the thrown value decides. A non-200 `status` and `connect` are unbilled `failed`, so cost does not change; `status` 200, `disconnect` and `timeout` are `unanswered`, so that model's reservation is charged once more and billed calls per attempt grow by one ([001 data-model §Cost](../../001-swap-check/data-model.md#cost)).
6. When an uncaptured side call (outside §Which Requests, for example OpenAI `/moderations`) failed and the service never requested the answer, the helper does not see the failure and the trial becomes an adapter error, usually data-model Outcome row 2. When the service raises, the target function converts it to that status code and throws it, with `usage` 0 when there are no captured calls (§`ModelCallError`).

### Trials Stopped by a Parallel Check's Refusal

When an input safety check sent with the answer request did not fail but answered "block", and the service cut the answer request or stopped waiting for it and shipped a fixed message or ended with a `discard_on` exception:

1. **No answer secured before** ([001 adapter-protocol §Answers](../../001-swap-check/contracts/adapter-protocol.md#answers)): even a service that never gives raw has the target function return `Result(raw="", kind="fallback", answers=0)`; for a discard, `kind="discarded"` and `discard_reason=` (data-model §Cut Streams view 5; [001 adapter-protocol §Streams the Service Cut](../../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut) reason 5). Unreported, the cut answer request is a `timeout` failure and the trial is `timeout`, or, for a stream cut without an awaited read, the adapter error of data-model §Raw Cannot Be Determined. Giving the text before the cut as a content cut would grade a cut text without violations on raw rules.
2. **An answer was fully received before the check blocked**: the service shipped a message instead of a received answer, so rule 1 does not apply.
   - All answers came as captured non-stream requests: wrap the message with `fallback`; for a discard, leave the `discard_on` exception.
   - An answer came as a stream: give the first answer (the received text when no full answer came earlier) as `Result(raw=, kind="fallback", finish_reason="other")` (`kind="discarded"` for a discard), with `answers=` when two or more were received.
   - The answer came through an uncaptured transport, stream or not: give the first answer as `Result(raw=, kind="fallback", model=, finish_reason="other", usage=)` (`kind="discarded"` for a discard), with `answers=` when two or more were received.
   - Only wrapping would make the raw answer empty and drop the first answer's violations and that call's cost.
   - The first answer came as a non-stream request and the check cut the regeneration stream that followed: do not wrap; give the first answer as `Result(raw=, kind="fallback", finish_reason="other", answers=)`, where `answers` is the number received, usually 1, counting streams cut late in between. Wrapping alone leaves raw undeterminable because of the cut stream, and without `answers` it is Outcome row 5 for an unread response after the raw answer.
   - When an answer request the service only stopped waiting for (the one the check cut, or one stopped earlier for being late) ended before the function returned (its call in the third argument has `outcome`), the service did not receive that answer, but report the same way; that answer becomes raw (K18 of [data-model §Known Limits](../data-model.md#known-limits)).
3. **Non-empty text was cut for content earlier**: it is neither rule 1 nor 2 but a content cut (data-model §Cut Streams view 2). Give that text when it is the first answer, or the earlier fully received answer when there is one, as `Result(raw=, kind="fallback", finish_reason="other")` (`kind="discarded"` for a discard), with `answers=` when two or more answers were received, whether the full answer came before or after the cut text. Never give `answers=0`: an empty raw with `answers=0` silently drops that text's violations from raw rules.
4. **Counting**: the answer counts in rules 2 and 3 include answer cut streams (any number count as one) and leave out the stream the check cut. Protocol meaning: [001 adapter-protocol §Streams the Service Cut](../../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut), reason 5.
5. **Answer through an uncaptured transport with no secured answer**: also give `model=`, `finish_reason="other"` and `usage=` as far as known. With a secured answer, add `model=` and the known `usage=` to the values of rules 2 and 3. The answer request sent is then added as that model's call and its cost is kept (data-model §Raw Call, the uncaptured call).
6. A check that reads the received text (an output check) is a content check, not this case (view 2).
7. A same-model check is excluded with `reply_call`. With another model's check the path has nothing to do with the swap, as for a refusal before the answer: remove the case or change its input (§Render Mode). In a case left in, trials that sent the answer request count as fallbacks.

### The `call` Check

`call` takes only a failure the service received and, with `reply_call`, only one of an answer call ([research R14](../research.md#r14-outcome-decision-trade-offs)).

- A trial stopped by the failure of a side call excluded with `reply_call` throws that failure with `status` or `kind` and `model` instead of `call` (§Trials Stopped by Another Call's Failure).
- When a request was sent in the same branch after the failure, the failure the service received is the later one: a stream the SDK resent after a 429 and the service then cut fails by that cut.
- The check looks only at send time and branch (K30 of [data-model §Known Limits](../data-model.md#known-limits)). When the SDK resent the other parallel copy after the failure that ended first (the 429 of K30), a `call` with that failure is caught. So trials that resent or sent the same request in parallel throw per §Services That Stopped Waiting and §Trials Stopped by Another Call's Failure.

## SDK Retries and `adapter.timeoutMs`

[001 data-model §Trial Outcomes](../../001-swap-check/data-model.md#trial-outcomes) asks for an `adapter.timeoutMs` longer than one service call can take, so that the service's time-out fires first.

- One model call can take up to the service's time limit × (SDK retries + 1), plus the SDK's waits before resending. Tool loops, service retries and regenerations add their calls' times.
- The SDKs wait for the response's `retry-after` before resending, and without it start at 0.5 s and double up to 8 s. The Anthropic SDK in both languages honours `retry-after` with practically no ceiling. The OpenAI SDK honours it up to 120 s in Python (above that it does not resend) and up to 60 s in Node (above that it uses the default wait).
- So a rate-limited candidate can pass the tool's time limit while the SDK inside the service waits, and count as abandoned (an adapter error) instead of transient. The OpenAI SDK also resends twice by default and can wait up to 120 s (Python) or 60 s (Node) each time, which can exceed the default tool time limit of 120 s; the Anthropic SDK, without a ceiling, more so.
- When warning `abandoned-trials` reports transient failures in abandoned trials, this is the case: raise `adapter.timeoutMs` by the SDK retry count (default 2) times the longest `retryAfterMs` in the message, or lower the concurrency. When the longest `retryAfterMs` exceeds 120 s, look at the provider account's limits instead of raising the time limit, for the reason the tool's own retries wait at most 120 s. When the message has no `retryAfterMs` (503, a dropped connection), the SDK waits at most 8 s each time, so raise it by the service's time limit × (SDK retries + 1) as above.
- A service without a time limit gets the official SDKs' defaults: 10 minutes per request and 2 retries. In Node the transport's default 300 s time limit fires first, and once response headers arrive the SDK's time limit no longer applies. The tool's time limit is then effectively that service's time limit.

## Messages

### Adapter Error Messages

| ID | Where | Message |
|---|---|---|
| A1 | data-model Outcome row 2 | "No model request was captured." followed by the guidance of §Not Captured |
| A2 | data-model Outcome row 4 | "No request went to the variant model `<model>` (actual: …). If the answer came through an uncaptured transport (Bedrock and similar), give `Result(raw=, model=)`. Do not give it for trials where a captured call before the answer failed or refused and the answer was never requested." When the function raised a non-`discard_on` exception, it is added |
| A3 | data-model Outcome row 5 | "Cannot choose the answer call (<cause>). Set `reply_call`." Causes include: several variant model branches; the answers' branches have different system prompts; no call is true for `reply_call`; `reply_call` is true only for calls to `<model>`; a same-model background request sent just before the function returned. With raw given (data-model §Answer Candidate Calls When Raw Is Given), the three messages are: "Cannot choose the answer call (unread responses have different system prompts). Set `reply_call`."; "Cannot choose the answer call (a variant model answer is outside the raw call's branch). If it is a side call, exclude it with `reply_call`; if it is a regenerated answer, give `Result(finish_reason=, answers=)`."; "Cannot choose the answer call (an unread response follows the raw answer). Exclude side calls with `reply_call`, or give `Result(finish_reason=, answers=)`." |
| A4 | data-model §Raw Cannot Be Determined row 1 | "Every answer call ended in a tool call. If the service takes its final answer as a tool call, set `answer_tool`." |
| A5 | data-model §Raw Cannot Be Determined row 2 | "Streaming responses are not parsed yet. Pass the raw answer and finish reason the service received as `Result(raw=, finish_reason=)`." |
| A6 | data-model §Raw Cannot Be Determined row 3 | "Responses background mode is not parsed. Pass the final output and finish reason the service received later." |
| A7 | data-model §Raw Call, uncaptured call | "Unknown raw call (no answer of the variant model `<model>` has the same text as the raw answer; models of the captured calls: …). If you refined a captured answer, pass it unchanged. If the answer came through an uncaptured transport, give `Result(model=)`. For a trial where a same-model call before the answer refused and the answer was never requested, report `Result(kind=\"fallback\")`: exclude that call with `reply_call` when it was captured, and also give `model=` and `answers=0` when it was not. If the captured calls went only to other models, check that the adapter passes the variant model to the service; for cases where another model's call before the answer keeps the service from calling the variant model, remove the case or change its input." |
| A8 | data-model §Cut Streams, the `answers=0` check | "`answers=0` was given but a fully received answer exists. If the answer was fully received before the check blocked, give the first answer as raw with `kind=\"fallback\"` (for a stream also `finish_reason=\"other\"`; with two or more received answers, or a stream cut after it, also `finish_reason=\"other\"` and the received count as `answers=`; the stream the check cut is not counted; for a discard `kind=\"discarded\"`). If it is the answer of a same-model check, exclude that call with `reply_call`. For a streaming tool loop with `answer_tool`, do not give `answers=0`." |
| A9 | data-model §Answer Candidate Calls When Raw Is Given, finish-reason check | "`Result(finish_reason=)` is required: the answer that decides the finish reason is an unread response or an uncaptured call." |
| A10 | data-model §Outside the Trial Context | "A model request was made outside any trial context (run with `--concurrency 1`, or have the service pass the context)." |
| A11 | §When Render Fails | "Could not reach the render target request." |
| A12 | `ModelCallError` | "`ModelCallError` takes exactly one of `status`, `kind` and `call`." |
| A13 | §The `call` Check | "`call` takes only a failure the service received, and with `reply_call` only a failure of an answer call." |

### Trial Warnings

Attached to the attempt's `warnings` ([001 adapter-protocol §`generate`](../../001-swap-check/contracts/adapter-protocol.md#generate-required)) and grouped by the comparison as `adapter-warnings` ([001 data-model §Warnings](../../001-swap-check/data-model.md#warnings)). None changes the outcome.

| ID | Condition | Sentence |
|---|---|---|
| W1 | data-model §Outcome Row 6 Details | "In a trial that received an answer, a call to `<model>` failed transiently and the trial ended in a fallback or discard. If it was the regeneration request, this is correct. If the service shipped a message or discarded the answer because of that failure, throw the failure. If it was an unrelated call the service swallows and moves past (memory writes and similar), leave it." `<model>` is "the variant model" or the call's model name |
| W2 | data-model §Another Model's Answer | "The shipped text may be another model's answer (`<model>`). If the service shipped it, wrap it with `fallback`." |
| W3 | data-model §Derived Result Fields, finish reason | "The last answer did not end with `stop`, but an earlier answer of the same request did. If the service picked an answer, give its finish reason as `Result(finish_reason=)`." |
| W4 | data-model §Raw Call: the uncaptured call while a searched answer exists | "No captured answer has the raw answer's text, so it was added as an uncaptured call and its cost may be counted twice. Pass a captured answer unchanged; if the captured answer belongs to a side call, exclude it with `reply_call`." |
| W5 | data-model §Failure Check or §Cut Last Answer, not from a cut stream or an unfinished call | "Decided by a captured call's failure instead of the given raw answer." Guidance: when a stream failed by a provider error (overload and similar) or a dropped connection, the result is right, leave it. Otherwise by cause: a trial that received no model answer (§When to Give `raw` item 2); a failed same-model side call, such as when the answer came through an uncaptured transport or a memory summary was called after a cut answer (exclude it with `reply_call`, §What the Target Function Reports); from data-model §Cut Last Answer, a regeneration cut after an earlier answer was fully received (give `answers=` counting the cut answer and `finish_reason=`; `kind="fallback"` when the cut text, a fixed message or another model's answer was shipped) |
| W6 | data-model §Failure Check or §Cut Last Answer, from a cut stream or an unfinished call | "Decided as a time-out instead of the given raw answer (the service stopped receiving before the model's answer was complete)." Guidance by cause, each reported as its row of §What the Target Function Reports says: a content cut; a parallel input check that blocked and cut (§Trials Stopped by a Parallel Check's Refusal); a stop at a configured string without an awaited read; a cut stream that is a same-model side call; a regeneration cut after an earlier answer was fully received (give `answers=` counting the cut answer and `finish_reason=`; `kind="fallback"` when the cut text, a fixed message or another model's answer was shipped; per data-model §Cut Streams view 4 when a parallel request's failure cut it); a modified request, sent in parallel or after the cut, that was fully received and shipped instead of the cut stream (select both requests with `reply_call` and give `Result(finish_reason=, answers=1)`; §Services That Stopped Waiting rule 3). A service that returns on an intermediate event saying the answer text ended (Responses `response.output_text.done`, Anthropic `content_block_stop`) has to receive up to the end event (K14 of [data-model §Known Limits](../data-model.md#known-limits)). When this appears although `stopped_early` was given, the stream cancelled an awaited read or was unfinished (data-model §Cut Streams view 3). When the service's time limit cut the trial, the time-out is right |
| W7 | data-model §Cut Streams view 3 | "`stopped_early` is honoured only with a non-empty raw answer and kind `model`." |
| W8 | data-model §Raw Call, uncaptured call | "The raw answer may come from a response of `<model>`, not the variant model. Check that the adapter passes the variant model to the service." |
| W9 | data-model §Usage Buckets | "Input tokens minus cache hits and cache writes was negative and was set to 0. The provider may have changed what the usage fields mean." |
| W10 | data-model §Matching Reported Failures | "The thrown failure may belong to an earlier attempt that was resent. Throw the failure the service received." |

### Log Warnings

Sent as `log` with level `warn` ([001 adapter-protocol §`log`](../../001-swap-check/contracts/adapter-protocol.md#log-notification-adapter--tool-optional)); the tool groups them at the end of a run.

| ID | When | Message |
|---|---|---|
| L1 | git, `lstat` or a file read failed while computing the service version | "Service version not reported: <reason>." |
| L2 | An unhandled exception in a Python asyncio task or a Node promise of background work | "Unhandled exception in background work: <exception>." |
| L3 | Background work raised because a request of an abandoned trial was blocked (§Cancel) | "Blocked a request of an abandoned trial: <exception>." |

## Supported SDKs

Only the combinations the CI contract tests run are supported. For each major version below, the last release is tested; for a major version that changed the transport, the first release too. The CI configuration is the source of the exact versions tested.

| Runtime | SDK | Major versions | Default transport |
|---|---|---|---|
| Python 3.10 or later | `openai` | 1, 2 | `httpx` |
| Python 3.10 or later | `openai` | 3 | `httpx2` |
| Python 3.10 or later | `anthropic` | 0 | `httpx` |
| Python 3.10 or later | `anthropic` | 1, 2 | `httpx2` |
| Node 22.17 or later | `openai` | 5, 6, 7 | global `fetch` |
| Node 22.17 or later | `@anthropic-ai/sdk` | 0 (from 0.50.1), 1 | global `fetch` |

- The SDKs' aiohttp backend (`DefaultAioHttpClient`) is an httpx or httpx2 async client with a different transport, so it is captured as is.
- Azure OpenAI is captured. The OpenAI SDK's Azure client puts the deployment name in the path (`/openai/deployments/<deployment>/chat/completions`) and also keeps it as the body's `model`, so variant `model` values and price keys are deployment names. The variant model check reads only the body's `model`, so it does not catch a client created with `azure_deployment` (K35 of [data-model §Known Limits](../data-model.md#known-limits)). Let the target function pick the deployment per variant by `model`; the comparison raises `same-response-model` when both variants answered with the same response model ([001 data-model §Warnings](../../001-swap-check/data-model.md#warnings)).

### Not Captured

A service that receives the answer through one of these gets data-model Outcome row 2 when no request is captured, or Outcome row 4 when only other-model calls are captured; nothing empty is recorded silently. When a same-model side call (intent classification) is captured, its output becomes the raw answer with no error and the answer's cost is lost, so such services report per §Uncaptured Transports even when no error appears.

- The service hands the SDK another transport: a client other than httpx or httpx2 in Python, the SDK constructor's `fetch` option in Node (for example undici's `fetch`).
- In Node, an SDK client created before the helper was imported.
- Old Node SDK versions (`openai` 4.x and earlier, `@anthropic-ai/sdk` before 0.50.1), which use node-fetch.
- Connections that are not HTTP: OpenAI Realtime, the Responses WebSocket mode.
- APIs that put the model in the path and not in a body `model`: Amazon Bedrock, Google Vertex AI. Their path suffixes also differ from §Which Requests.
- SDK settings that use their own transport instead of the global `fetch` (for example x509 certificate authentication in openai-node 7.x).
- SDKs that call the model from a child process (for example the Claude Agent SDK, which starts Claude Code, whose process calls the model). The helper sees only requests inside the adapter process.

## Distribution

- **Python**: one file, `model_eval_adapter.py`, standard library only. `init --adapter python` copies it next to the adapter ([001 FR-033](../../001-swap-check/spec.md#functional-requirements)), and nothing is installed into the service's virtual environment. The file header carries the helper version and the protocol version; when the tool ships a newer helper, `lint` reports `helper-outdated` ([001 data-model §Validation Rules](../../001-swap-check/data-model.md#validation-rules)).
- **TypeScript**: the `model-eval/adapter` subpath of the tool package, exporting `defineAdapter`, `fallback`, `result` and `ModelCallError`.
- Both helpers report as `adapter.helper.version` the bundled helper version of the tool release they come from; the Python file header carries the same value.
- `init --adapter python|node` creates an adapter skeleton that uses the helper (001 FR-033).
