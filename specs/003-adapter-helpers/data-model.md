# Data Model: Adapter Helpers

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This file defines what the helpers derive from the calls they capture and from the target function's result: call records, branches, answers, the trial outcome, and the service version. Related rules live elsewhere:

- The API, what the adapter passes, and the wire-level reading rules: [contracts/helper-api.md](contracts/helper-api.md).
- The expected result of each case: [contracts/helper-scenarios.md](contracts/helper-scenarios.md).
- Why each rule is chosen: [research.md](research.md), mostly [research R14](research.md#r14-outcome-decision-trade-offs).
- Protocol fields (`raw`, `answers`, `finalKind`, `calls`, error kinds, call `outcome`): [001 data-model §Trial](../001-swap-check/data-model.md#trial) and [001 adapter-protocol §`generate`](../001-swap-check/contracts/adapter-protocol.md#generate-required).
- Canonical JSON: [001 data-model §Canonical JSON](../001-swap-check/data-model.md#canonical-json).
- Cases the rules decide differently from the service's real behaviour: listed once, in §Known Limits.

## Overview

```text
service function ─┬─> captured calls (per trial context) ──> branches ──> answer candidate calls ──> answers ──> first answer (raw)
                  └─> value | exception | Result | ModelCallError ──────────────────────────────────────┴──> outcome decision ──> generate result
```

- A **captured call** is one request to a captured API path and its response ([helper-api §Captured Requests](contracts/helper-api.md#captured-requests)).
- A **branch** groups a call with the calls that resend or continue it (§Call Branches).
- **Answer candidate calls** are the variant model calls that may carry the reply; their successful, non-tool-call responses are **answers**.
- The **outcome decision** turns calls and the function's result into a `generate` result (§Outcome Decision). When the adapter gives the raw answer itself, §When the Adapter Gives Raw replaces it.

## Captured Call

Recorded per call: the request's model, messages, tool definitions and output limit; the response's text, tool calls, usage, finish reason and response model; the HTTP status; latency. The official SDKs resend a failed request up to twice by default, and each resent request is its own call. An SSE response (`content-type: text/event-stream`) carries a stream mark.

### When a Call Ended

The order of calls is the order their requests were sent. A request is sent when the SDK hands it to the HTTP client (the wrapped `send` or `fetch` is called), so waiting for a pooled connection and connecting belong to the call. A call's `latencyMs` runs from that moment to when it ended (below); calls that had not ended when the service function returned, and calls cut on the tool's `cancel`, have none. Two calls overlap when the later one was sent before the earlier one ended. Chunks read after the service function returned are ignored.

| Call | Ended when |
|---|---|
| Failed call | It failed: an error-status response when its headers arrived, a failure end event when it was received, a 2xx body that is not a JSON object, or a 2xx JSON object with a non-null top-level `error`, when it was fully received ([helper-api §End Events](contracts/helper-api.md#end-events)) |
| Non-stream response | Its body was fully received |
| Unread response | The service, SDK included, read the last chunk of the body; with no chunk read, when the headers arrived. Closing the body does not end it |
| SSE response whose copy holds a generation-end marker | The chunk with the marker was read, even when the response is unread. If it fails later and counts as a failed call, when it failed |

Reasons: [research R10](research.md#r10-when-a-call-ended-and-why-stopping-to-wait-is-a-time-out). Ending SSE at the generation-end marker has the cost K27.

### Unread Response

A 2xx response whose text, finish reason and usage the helper does not know and that did not end in failure:

1. An SSE response.
2. A body not fully read by the time the service function returned ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies)).
3. A Responses response with status `queued` or `in_progress` (background mode).

Error-status responses, responses whose body failed while being read, streams that ended in a failure end event, non-stream 2xx bodies read to the end that are not a JSON object, and 2xx JSON objects with a non-null top-level `error` are failed calls, not unread responses.

### Call Outcome

The `outcome` of a failed call ([001 data-model §Trial](../001-swap-check/data-model.md#trial), call record):

| Failure | `outcome` |
|---|---|
| Any failure with `usage` | `failed`, priced at that usage |
| Possibly billed, no `usage`: a failed 200 response, a drop, time-out or cancel after the request was sent | `unanswered`, charged the call reservation |
| Not billed: a non-200 error status, a request that never arrived (a URL scheme other than `http` or `https` included), a certificate failure | `failed` |
| A call the helper cut on the tool's `cancel` (asynchronous target functions only; the calls of a synchronous one end as they ended, [helper-api §Cancel](contracts/helper-api.md#cancel)) | `unanswered`, not classified |

Calls the helper corrects or adds from a `ModelCallError` follow §Matching Reported Failures.

## Comparing Text

- Ignoring leading and trailing whitespace means removing the 25 Unicode `White_Space` code points listed in [001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes) from both ends before comparing. The helpers remove exactly that list, not what the language's own trim function removes ([research R13](research.md#r13-make-both-helpers-produce-the-same-bytes)).
- **Empty** means nothing remains after that removal ([001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes)).

## System Prompt

The system of a request is:

- Anthropic: `system`. A block list joins its text blocks with newlines.
- Responses: `instructions` plus the consecutive `system` and `developer` messages at the start of `input`.
- Chat Completions: the consecutive `system` and `developer` messages at the start of the message list.

Several messages are taken in order. A message whose content is a part list is converted to a string as render mode does ([helper-api §Render Mode](contracts/helper-api.md#render-mode)) before comparing.

## Variant Model Call

A call whose request `model` equals the variant `model`, or equals it followed only by a date (`-YYYY-MM-DD` or `-YYYYMMDD`). A model that only shares the name's prefix is not the variant model ([research R5](research.md#r5-pick-the-raw-answer-by-rule-and-let-the-adapter-choose-instead-of-guessing)). The response `model` is not used here, only for `modelSnapshot`.

## Call Branches

A later call joins an earlier call's branch only in the two cases below; any other call starts a new branch. The earlier call is any call sent before it; when several match, the later call joins the branch of the latest one sent.

1. **Resend**: the later request body equals the earlier one. This covers SDK and service retries and re-draws with the same request. Equal means the canonical JSON of the body without the top-level `stream` and `stream_options` keys is equal: a request that differs only in streaming is the same request ([001 adapter-protocol §Streams the Service Cut](../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut), reason 1).
2. **Tool loop**: the earlier response ended in a tool call or Anthropic `pause_turn`; the later request has the same system and tool definitions; its message list starts with the earlier request's message list; and what follows is only the earlier response's output items, copied, and tool results.
   - Responses chained with `previous_response_id`: that ID names the earlier response. Chained with `conversation`: the earlier response is the latest call sent earlier in the same conversation. Either way the system (`instructions`) and tool definitions must equal the earlier request's, and the input must be only tool results (the result items of §Finish Reasons).
   - Output items include reasoning items next to text and tool calls (Anthropic `thinking` and `redacted_thinking` blocks, Responses `reasoning` items).
   - An item is copied when its kind and position, text, tool-call ID, name and arguments, and reasoning `signature`, `data` and `encrypted_content` are equal. The ID of a Responses tool call is `call_id`, not the item `id` (only `mcp_approval_request` uses `id`, and an item whose `call_id` is missing, `null` or empty uses `id` as in §Finish Reasons); `id` is optional and hand-written loops drop it when copying. Other fields that SDKs drop or add when copying are ignored.

A request that continues the conversation after a call that ended in text (answer validation, memory writes) is a new branch.

## Answers

Answers, successful calls, unrecovered failures and unread responses are decided over the calls that had ended when the service function returned; the exceptions are in §After the Function Returned.

### Answer Candidate Calls

- With `reply_call`: the variant model calls it returns true for.
- Without `reply_call`: every variant model call, and those calls must form one branch.
- A branch that holds an answer candidate call is an **answer branch**. In `calls`, calls of answer branches have `branch: answer` and the others `side`.

### Answer

A successful response of an answer candidate call that did not end in a tool call (§Finish Reasons), whatever its finish reason: a text response with no tool call in its content is an answer, and its finish reason maps by §Finish Reasons, so an unknown value is `other`. The exception is an Anthropic response with `pause_turn`, which continues a tool loop (§Call Branches, [helper-api §End Events](contracts/helper-api.md#end-events)) and is not an answer. Each `choices` item of a Chat Completions response is one answer (`n` > 1). A response with no text and no tool call is an answer with empty text, and so not §Raw Cannot Be Determined row 1: an Anthropic `content` without `text` blocks, a Responses `output` without a message item (only `reasoning` items, or none), and a Chat Completions response whose `choices` list is empty, which counts as one answer with finish reason `other`. A JSON object without a top-level `error` and without the `choices`, `output` or `content` key is the same as an empty list, so such a response is one empty answer, a completion failure. One whose top-level `error` is not `null` is a failed call with status 200, classified by that error object ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies) item 4). An unread response cannot be classified because its end was not seen.

With `answer_tool` (a tool name and the argument key holding the text), a response that calls that tool is also an answer:

1. The text is that argument's value. With several calls of the tool in one response, the first is used.
2. A non-string value becomes its canonical JSON string. A `null` value, arguments that are not JSON (001 data-model §Canonical JSON, reading), or a missing key give the empty string.
3. The finish reason is the provider's when the output limit or a filter ended the response, else `stop`.
4. When the service sends a tool result for that call and continues the branch, the continued responses are not answers.

First answer, answer count and finish reason then follow the same rules as for services that answer in text.

### First Answer

The earliest sent answer; within one response, the first `choices` item. The raw answer is its text, and the number of answers received is reported as `answers` ([001 adapter-protocol §Answers](../001-swap-check/contracts/adapter-protocol.md#answers)).

- When the service validates and regenerates, or picks one of several answers, the shipped text has already been filtered by the service. Violations hidden by regenerating or picking count on raw rules, like violations that post-processing removed; the shipped text is judged by final rules and `completed` ([001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes)).
- When answers come from several branches, the first requests of those branches must have the same system; otherwise the answer candidate calls cannot be determined (Outcome row 5).

### Successful Calls and Unrecovered Failures

- A **successful call** is a call that ended `ok`, unread responses included. Two exceptions are not successful calls: an SSE response taken as cut view 1 when the adapter gives raw (§Cut Streams), and an SSE response that ended before receiving a generation-end marker, in the matching-failure candidate of §Matching Reported Failures and in the `call` check ([helper-api §The `call` Check](contracts/helper-api.md#the-call-check)).
- An **unrecovered failure** is a call that ended `failed` or `unanswered` with no successful call in the same branch sent after it or overlapping it.
  - A service that sends the same request in parallel, uses the first answer and cancels the rest: the cancelled calls overlap a successful call, so they are recovered failures.
  - A failure followed in the same branch by an unfinished call (§After the Function Returned) is not unrecovered either. The service was waiting for the request the SDK or the service resent and never received that failure; Outcome row 6 and the failure check handle the resent request.

## Outcome Decision

When the service function ends, the first matching row decides. When the adapter gives a raw answer, §When the Adapter Gives Raw decides instead. When the target function throws `ModelCallError`, `discard_on` is not consulted, only Outcome row 1 is checked, and otherwise that error decides through §Matching Reported Failures, or as adapter error A12 when it does not give exactly one of `status`, `kind` and `call`; rethrowing a failure the helper already captured takes that call's kind. These rows are cited as "Outcome row N".

| Row | Situation | Result |
|---|---|---|
| 1 | Any call failed with kind `config` ([helper-api §Error Classification](contracts/helper-api.md#error-classification)) | `config` error, also when the service swallowed the failure and returned a value |
| 2 | No model request was captured | Adapter error A1, in its exception form when the function raised an exception that is not in `discard_on`. Either way with the guidance of [helper-api §Not Captured](contracts/helper-api.md#not-captured) |
| 3 | An unrecovered failure exists, and (a) the function raised an exception not in `discard_on`, or (b) there is no variant model call (with `reply_call`: none it is true for) | That failure's kind: the latest-ended unrecovered failure of the answer branch when there is one, else the latest-ended of all unrecovered failures |
| 4 | No request went to the variant model | Adapter error A2. When the function raised an exception that is not in `discard_on`, the message names it too |
| 5 | The answer candidate calls cannot be determined: no variant model call is true for `reply_call`; or there is no `reply_call` and two or more variant model branches; or the branches the answers came from have different systems | Adapter error A3. When `reply_call` is true only for calls to another model, the message names that model; when the function raised an exception that is not in `discard_on`, the message names it too. Exception below |
| 6 | No answer, and an unrecovered failure in the answer branch. Or: the function returned a value or raised a `discard_on` exception, there is no answer, and the answer branch has an unfinished call | `timeout` when the answer branch has an unfinished call, else the kind of the unrecovered failure (the latest-ended when several). A service that swallowed the error and shipped a fixed message still counts as the call failure |
| 7 | The function returned a value | `ok`. `finalKind` is `model` by default and `fallback` when the target function wrapped the text with `fallback(...)` |
| 8 | The function raised a `discard_on` exception | `ok` · `discarded`. `discardReason` is the exception's text as [helper-api §Adapter Error Messages](contracts/helper-api.md#adapter-error-messages) builds `<exception>` (the message trimmed first; the class name alone when it is then empty, else `Class: message`), cut to its first 200 code points |
| 9 | Any other exception | Adapter error. When a model response was received, the text of the first answer goes along as `capturedRaw`; with no answer, the text of the last successful response |

Outcome rows 7 and 8 need a raw answer that can be determined (§Raw Cannot Be Determined).

**Non-text return**: when the target function returned a value that is not text, `fallback(text)` or a `Result` (after awaiting an awaitable, [helper-api §Return Values](contracts/helper-api.md#return-values)), only Outcome row 1 is checked, and otherwise the trial is adapter error A14 with `calls`, `usage` and `capturedRaw` in its data as in Outcome row 9. The value is an adapter defect, never caused by a call failure, so Outcome row 3 does not take it.

**Decision failure**: when `reply_call` or a `discard_on` function raises, or the helper's own analysis of the calls raises, Outcome row 1 is checked first, as for A12, A14 and cancel, unless the classification of the calls is what raised; otherwise the trial is adapter error A16. Its data holds `calls` and `usage` after the helper has waited for unfinished calls as for every result (§After the Function Returned), so the trial is charged its real cost and a `config` failure among those calls still stops the run ([001 adapter-protocol §Reporting Model Failures](../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures), rule 6).

- A `reply_call` or `discard_on` exception is A16 after Outcome row 1, in render too, where it comes before A11: A11 means only that the service ended without reaching the render target ([helper-api §When Render Fails](contracts/helper-api.md#when-render-fails)).

**Outcome row 3 when only (b) holds**: failures followed by a captured call of the trial sent after they ended are left out. Calls sent after the function returned do not count. Limits: K1, K2, K3.

**Outcome row 5 exception**: when variant model calls exist but none is true for `reply_call`, and the target function wrapped the result with `fallback` or the function raised a `discard_on` exception, the service ended in a fallback or discard without requesting the answer. The trial is Outcome row 7 or 8 with an empty raw answer, `answers` 0 and finish reason `other`.

### Outcome Row 6 Details

- Only the answer branch is checked, and any answer makes the row not match. An SSE response that received a generation-end marker counts as an answer here, also when it failed afterwards; without `answer_tool`, streams that ended in a tool call do not count.
- When the service swallowed a side-branch failure and answered, the outcome does not change; the failure stays in `calls` and in the side-call failure count (the per-kind side-call failures of [001 data-model §Comparison](../001-swap-check/data-model.md#comparison) `ops`). A `config` failure is Outcome row 1. When the service did not answer because of that failure, the trial is that failure: usually Outcome row 3 when the answer was never requested; when Outcome row 3 does not decide it, and in other cases, [helper-api §Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure).
- When the service tried to regenerate, with the same or another model, failed, and shipped the earlier answer, a fixed message or another model's answer, a first answer exists, so the trial is Outcome row 7; a `discard_on` exception makes it Outcome row 8 ([001 adapter-protocol §Reporting Model Failures](../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures), rule 4). When that failure makes the service raise an exception that is not a discard, Outcome row 3 decides it; a regeneration request that failed with `config` is Outcome row 1.
- When there is no answer, a variant model call failed and the service answered with another model, the trial is Outcome row 6. If the failed call is an SSE response that failed after its generation-end marker, it counts as an answer per the first item, so §Raw Cannot Be Determined row 2 applies.
- A service that sends the same request to different models in parallel and uses the first answer: when the candidate loses, its cancelled call is an unrecovered `timeout`, so Outcome row 6 again. Stopping to wait without cancelling leaves an unfinished call and gives the same result.

**Warning W1** ([helper-api §Trial Warnings](contracts/helper-api.md#trial-warnings)) is attached when the result is `fallback` or `discarded`, a first answer exists, and some `transient` unrecovered failure has no captured call sent after it ended. `` `<model>` `` with its backticks becomes "the variant model" when that failure is a variant model call, else `<model>` is the call's model name; with several such failures, the latest-ended one. The outcome does not change.

- When the adapter gives raw, trials whose raw call is the matching answer, the last unread response or the uncaptured call and that did not give `answers=0` count as having a first answer, except trials under the uncaptured-call exception that never sent the answer request.
- Limits: K4, K28.

### Unfinished Calls Count as Time-Outs

A service that does not cut the request but stops waiting under its own time limit (Node `Promise.race`) leaves the request to succeed, fail or be cut by the helper after the function returned. It counts the same as a service that cancelled the request (`timeout` in [helper-api §Error Classification](contracts/helper-api.md#error-classification)). The unfinished call decides even when the SDK was resending a failed request.

The helper cannot know when the service stopped waiting. In the three cases below, the target function must report per [helper-api §Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting) to be counted correctly ([001 adapter-protocol §Answers](../001-swap-check/contracts/adapter-protocol.md#answers)):

1. The service stopped waiting, resent, and the resent request ended in another failure such as a rate limit: the trial becomes `timeout` here. When the target function throws that failure, it counts as that failure.
2. The request the service stopped waiting for ended before the function returned, so it looks like a received response (K17).
   - A stream: the SDK kept reading in the background and received the generation-end marker. It counts as an answer (§Outcome Row 6 Details), so a value without raw becomes the adapter error of §Raw Cannot Be Determined.
   - A non-stream request: this happens with `fut.result(timeout=)` inside Python `with ThreadPoolExecutor()`, which waits for its threads when the block exits (without passing the context it works only at concurrency 1, §Outside the Trial Context), and with code that waits for leftover tasks at the end of the function (`asyncio.gather`, `Promise.allSettled`). The late response becomes the first answer and passes as complete under Outcome row 7, or is a fallback when wrapped.
   - When the service shipped an answer it received by resending, the late response also counts as an answer; without raw it is the first answer. Raw and regeneration rate then differ from the same service whose late response arrives after the function returned.
   - That response is not a matching candidate (a stream for the started-response candidate's reason; a fully received response is not a failure). Throwing `kind="timeout"` therefore adds a new call, so cost grows by that call's reservation and billed calls per attempt grow by one ([001 data-model §Cost](../001-swap-check/data-model.md#cost)).
   - Throwing the resent request's failure: when that failure overlaps the late response, it is a recovered failure and not a candidate, so it is added as a new call. A non-200 `status` is an unbilled `failed`, so cost does not grow. Giving that failure as `call` is an adapter error.
3. When the service ends while the SDK waits before resending (about 1 s by default, or the `retry-after` value; [helper-api §SDK Retries and `adapter.timeoutMs`](contracts/helper-api.md#sdk-retries-and-adaptertimeoutms)), no unfinished call exists and the earlier failure decides (K5). When the target function throws `kind="timeout"`:
   - after an error response (429, 503), no candidate matches, so a new call is added and the trial is `timeout`;
   - after a failure without an error response (a connection failure or drop; 408 is an error response and belongs to the previous case) or a read time-out on a non-stream body, the error matches that call and the trial is `transient` (K6).

Unfinished calls do not count as time-outs in functions that ended in another exception: fake storage raising while a model call was running must show as Outcome row 9.

### Another Model's Answer

- `fallback` means other text was shipped instead of the raw answer; fixed messages and other models' answers both qualify. Another model's answer the target function did not wrap with `fallback(text)` is graded as the candidate's final output and passes `completed`.
- When the candidate call failed without a candidate answer and another model answered instead, the trial is that failure under Outcome row 6, wrapped or not.
- **Warning W2** is attached when the result is `model`, another model's answer exists (responses that did not end in a tool call, and `answer_tool` calls; unfinished calls are excluded because the service did not receive them), and either its text equals the shipped text (whitespace ignored) or the first request of its branch has the same system as the answer branch's. Without an answer branch (the raw call is the uncaptured call), only the text is compared. Send order is not checked.

## Raw Cannot Be Determined

Outcome rows 7 and 8 need a raw answer. When the adapter gave none:

| Situation | Handling |
|---|---|
| 1. No answer, and every answer candidate response ended in a tool call | With `model` (Outcome row 7): adapter error A4. With `fallback` (Outcome row 7) or Outcome row 8: raw is the text of the last answer candidate response, or empty, `answers` is 0, and the trial is a completion failure |
| 2. An answer candidate call has a stream response or a body that was not fully read ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies)). This includes SSE responses that failed by time-out or cancel before the generation-end marker, SSE responses that failed after it, and SSE responses unfinished when the function returned. Whether a response is SSE is decided by the headers received by the time the function returned | Adapter error A5 |
| 3. A Responses `status` of `queued` or `in_progress` | Adapter error A6. Background mode is not parsed; the adapter passes the final output and finish reason the service received later |

- Row 2 leaves out SSE responses that failed before the generation-end marker through a provider error event or a drop mid-body (a lost connection, a body that ended without an end event).
- Row 2 decides SSE by the headers at function end, so a request that had no headers then and answers late with SSE does not change the result (§After the Function Returned).

## When the Adapter Gives Raw

The raw answer is the `Result(raw=)` value, and the helper does not pick one. When to give it: [helper-api §When to Give `raw`](contracts/helper-api.md#when-to-give-raw).

**Order of checks**, first match decides; when none matches the trial is `ok` with `finalKind` from `Result(kind=)` (default `model`):

1. Outcome row 1.
2. The `answers=0` check (cut view 5).
3. The failure check.
4. The raw call. The uncaptured call without `Result(model=)` is an adapter error here, apart from the uncaptured-call exception.
5. Outcome row 4, applied to `Result(model=)` when given. A matching answer or a last unread response implies a captured variant model call; the uncaptured call implies `Result(model=)`; the uncaptured-call exception implies a captured variant model call.
6. Outcome row 5, with the conditions of §Answer Candidate Calls When Raw Is Given.
7. The cut last answer.
8. The finish-reason check.

Outcome row 2 and §Raw Cannot Be Determined are not used.

**Searched calls**: with `reply_call`, the variant model calls it is true for; without it, the variant model calls. The failure check and the raw call look only at these.

### Cut Streams

A **cut stream** is a searched SSE call that ended before receiving a generation-end marker: it failed with `timeout` before the marker (a service cancel, a time limit between events), became an unread response (`break` or `close` in the read loop, left half-read), or was unfinished when the function returned. It means the service stopped receiving before the model's answer was complete. Whether a call is SSE is decided by the headers received by the time the function returned; a request without headers then stays an unfinished call even if it answers late with SSE (§After the Function Returned).

The protocol counts a cut stream by the reason it was cut ([001 adapter-protocol §Streams the Service Cut](../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut)). The helper does not know the reason, so for the rest of this section (failure check, raw call, answer candidate calls, cut last answer, warnings) it takes one of the views 1, 2, 3 or 5 below from the values the adapter gave; reason 4 is reported by the target function. The records stay as the calls ended. View numbers equal the protocol's reason numbers, and view 1 is the default.

When the adapter gives the raw answer and the answer count, they carry the protocol meaning of `raw` and `answers` ([001 adapter-protocol §Answers](../001-swap-check/contracts/adapter-protocol.md#answers)): the first answer, and a count that includes cut answers (any number of cut answer streams count as one; cut streams that are not answers are left out).

1. **Cut late** (the default, when 2, 3 and 5 do not apply).
   - In the failure check, the cut stream is a call that failed with `timeout`; one that became unread ended per §When a Call Ended. One still being read when the function returned ended when the service last read it, or when its headers arrived if it read nothing (K38). After the failure check it is an unread response.
   - It is not a successful call when deciding whether another call's failure was recovered.
   - Without raw from the adapter, a stream cut without an awaited read is a successful call (K7).
   - When the failure check does not run, §Cut Last Answer looks at the stream.
2. **Cut for content**: the adapter gives a non-empty raw answer and `Result(kind=)` `fallback` or `discarded`. Every cut stream is then an unread response.
   - The trial is a fallback or discard, a completion failure, and the violations in the given text count on raw rules, as violations the service filtered always do (§First Answer).
   - When the raw answer given is an earlier, fully received answer, the fallback or discard is reported as is even when the cut was a time limit (§Cut Last Answer).
3. **Deliberate stop**: the adapter gives a non-empty raw answer, `Result(stopped_early=True)` and kind `model`. Only cut streams that became unread responses are unread; the others are taken as view 1.
   - There is no awaited read after `break` from an SDK stream iterator (Python, all; Node `create({ stream: true })`), or after an immediate `abort()`, without awaiting, inside a Node stream helper event handler. After an `await` in the handler, the SDK has usually started the next read in the meantime; with only one microtask awaited and events left in that chunk, there is no awaited read (K8).
   - Node stream helpers (`chat.completions.stream()`, `responses.stream()`, `messages.stream()`) iterated with `for await` and left with `break`: when the stopping event was the last event of a chunk read at once (usually so), the SDK cancels the awaited read in the background. That cannot be told from a cancel by the service's time limit, so it counts as a time-out. When events remain in that chunk there is no awaited read and the trial is normal (K8).
   - A time limit that fires while the service processes each chunk from an SDK iterator with `await` leaves no awaited read and becomes an unread response (Python `asyncio.wait_for` too) (K9). Node stream helpers read the next chunk ahead in the background, so there is an awaited read then and it counts as a time-out.
   - `stopped_early` given with no raw, an empty raw or a kind other than `model` is ignored, and warning W7 is attached.
4. **Cut because a parallel request failed**: the helper does not see this separately; the target function reports it ([helper-api §Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure)).
   - After a matching answer an unread response remains, so a report that lacks `answers=` or `finish_reason=` is Outcome row 5.
   - When the first answer arrived as a stream, the raw call becomes the cut stream, and `answers=1` makes the cut last answer (raw call cut) decide `timeout`, so the reported count includes the cut stream (K10).
5. **Cut because a parallel check refused**: the adapter gives an empty raw answer, `Result(answers=0)` and kind `fallback` or `discarded`. Among the searched calls, the rest of this section ignores cut streams, calls that failed with `timeout` and unfinished calls; they are neither failures nor answers, and not successful calls when deciding recovery. The same holds for trials that cancelled or stopped waiting for a non-stream answer request.
   - Also ignored: a searched call's failure followed by another searched call sent after it ended, ignored calls included (an earlier attempt the SDK or service resent, the earlier request of a modified resend). This works like Outcome row 3 but on searched calls only, so that an SDK retry of another model's check does not erase the answer request's failure. So when the answer request ends in 429 after the SDK's retries, the service asks another model, and the check blocks that request, the trial is `transient`.
   - When the check blocks while the SDK waits before resending, no later call exists and the earlier failure decides (K5). Then the failure check decides when another unrecovered failure exists (such as an answer request that ended in 429 after the SDK's retries before the check blocked); otherwise the uncaptured-call exception makes the trial a fallback or discard. It then counts like a trial refused before the answer.
   - Ignored calls still count as "a captured call to the variant model" for the uncaptured-call exception. A check that blocked before the answer request was sent is the same as a refusal before the answer: with a same-model classification excluded by `reply_call` it is the uncaptured-call exception; with another model's check it is adapter error A7, so that the case gets removed.
   - **The `answers=0` check**: when the searched calls contain, besides ignored calls, an answer or a stream that received a generation-end marker, the value is not honoured and the trial is adapter error A8. Without `answer_tool`, streams that ended in a tool call do not count here; with `answer_tool` they cannot be left out, because which tool was called is unknown (K11). The check runs after Outcome row 1 and before the failure check.
   - When only ignored calls remain, the trial is treated as having no searched calls, and the check of §No Searched Calls runs; its "captured call sent after the failure" counts ignored calls too. A swallowed failure of a side call made after settling on a fallback or discard is K2. A trial that swallowed another model's failure before the answer and then sent the answer request moved past it. A swallowed failure of another call sent alongside decides the trial (K1).
   - `answers=0` must be given explicitly so it differs from the default 1. Giving it on a trial that was cut late makes a fallback instead of a time-out (or, when the last attempt ended in another failure, that failure).

#### Cut Styles

Cancelling the request, leaving the read loop and only stopping to wait are treated alike when the adapter gives raw: view 1 takes each cut stream as a `timeout` failure, and an unfinished call is a time-out too ([research R14](research.md#r14-outcome-decision-trade-offs)). The exceptions are view 3, where only a stream left without an awaited read escapes the time-out (K8, K9), and a request the service only stopped waiting for that ended before the function returned, which looks like a received response (K17). Without raw they can differ, because a stream left without an awaited read is a successful call (K7); scenarios then name the style (cut styles per client, [helper-scenarios](contracts/helper-scenarios.md)).

### Failure Check

The failure check applies when the searched calls include an unrecovered failure (a cut stream taken as a `timeout` failure under view 1 included) or an unfinished call, and include no unread response (K29); without `answer_tool`, a stream that ended in a tool call does not count as an unread response here. When one of the following holds, the given raw is not used and the trial is decided like Outcome row 6: `timeout` when an unfinished call exists, else the kind of the unrecovered failure (the latest-ended when several).

1. The searched calls have no answer.
2. The raw answer is empty, and no answer has empty text.

- With kind `model`, an SSE call that failed by a drop or time-out after its generation-end marker is an unread response for the rest of this section. With a fallback or discard it stays a failure.
- With `answer_tool`, a streaming tool loop's earlier calls block the check; a cut last call is caught by §Cut Last Answer (K12).
- Warnings: when the result came from a cut stream or an unfinished call, W6, with the fix for each cause. Otherwise W5, with its guidance.

### No Searched Calls

With no searched calls the failure check does not run. Then, when the raw answer is empty, there is no `Result(model=)`, and an unrecovered failure exists as in Outcome row 3 (failures followed by a captured call sent after they ended are left out), the given raw is not used and the trial is that failure.

- Limits K1 and K2 apply as for Outcome row 3.
- No warning is attached.
- A non-empty raw answer or a `Result(model=)` stops this check from running.

### Raw Call

The raw call is the first match below:

1. **Matching answer**: an answer of the searched calls whose text equals the raw answer, whitespace ignored; `choices` items and `answer_tool` argument values included. With several, the earliest sent. Only answers are searched.
2. **Last unread response**: the last unread response of the searched calls. For a background Responses response this is the first request; the requests that fetch the result are not captured.
3. **Uncaptured call**: the raw answer came through an uncaptured transport.
   - Its model is known only from `Result(model=)`, which is then required and must be the variant model (Outcome row 4). Without it: adapter error A7.
   - With captured calls, the helper appends this call to `calls`: `model` from `Result(model=)`, `responseModel` from `Result(model_snapshot=)`, `outcome` `ok`, `usage` from `Result(usage=)`. Without `usage`, the tool charges the call reservation ([001 data-model §Cost](../001-swap-check/data-model.md#cost)). With no captured call at all, there is no `calls`, and `Result(usage=)` becomes the trial's `usage` (§Derived Result Fields).

**Uncaptured-call exception**: when there is no `Result(model=)`, the raw answer is empty, the kind is `fallback` or `discarded`, a captured call to the variant model exists, and the searched calls have no answer (they ended only in tool calls, there are none, or only calls ignored under view 5 remain), the trial is not an adapter error.

- The service shipped a fixed message before sending the answer request, or after cutting it because a parallel check refused. Examples: a tool loop of non-stream requests hit its limit and never sent the last answer stream; a same-model classification before the answer, excluded by `reply_call`, refused; a check sent with the answer refused and the answer request was cut (view 5). Without `reply_call`, the classification's answer is an answer of the searched calls, so the exception does not apply.
- No call is added. `answers` is 0, and the finish reason is `Result(finish_reason=)`, else `other`.
- With `Result(model=)` it is not the exception, and the call is added as the uncaptured call.
- Limit: K13.

Warnings on the raw call:

- **W4** when the searched calls have an answer but the raw call is the uncaptured call.
- **W8** when the raw call is the uncaptured call and a captured call to a model that is not the variant model looks like the source of the raw answer. It looks like the source when the call is an unread response, an unfinished call or an SSE response that failed with `timeout` before its generation-end marker; or when the raw answer is not empty, the call's answer text contains it (whitespace ignored), and the raw answer is at least half that text's length in code points.
  - With `reply_call`, only calls it is true for are source candidates.
  - With rendering on, this mistake is a configuration error at the start of the run ([helper-api §Render Mode](contracts/helper-api.md#render-mode)).

### Answer Candidate Calls When Raw Is Given

When the raw call is the matching answer or the last unread response:

- With `reply_call`: the calls it is true for, without the system comparison, plus the raw call.
- Without `reply_call`: the calls in the raw call's branch, plus the calls of branches holding an unread response of a searched call sent before the raw call.

`answers`, the finish reason and `branch` then follow this file's rules. When the raw call is the last unread response:

1. It counts as the first answer, except when it is a stream that ended in a tool call, the target has no `answer_tool`, and the kind is `fallback` or `discarded`. A streaming service that shipped a fixed message at the tool-loop limit then does not count as an empty answer ([001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes) row 6).
2. `answers` = the answers counted among the answer candidate calls + 1.
3. It takes part in picking the last answer for the finish reason. When it is the last answer, `Result(finish_reason=)` is required (finish-reason check).

So a service that filtered a streamed first answer and regenerated with a non-stream request keeps the regenerated answer.

Outcome row 5 cases when raw is given:

1. Without `reply_call`, the branches of the answer candidate calls must have the same first-request system. Otherwise adapter error A3 with the cause "unread responses have different system prompts". A streaming tool loop has one system and is not caught.
2. Without `reply_call`, a variant model answer outside the raw call's branch may be a regenerated answer or a side call. Unless both `Result(finish_reason=)` and `Result(answers=)` are given, adapter error A3 with the cause "another variant model request, not a resend or tool-loop step of the raw answer's request, also got an answer".
3. When the raw call is the matching answer and a searched call sent after it has an unread response, that response may be a regenerated answer or a side call, also with `reply_call`. Unless both `Result(finish_reason=)` and `Result(answers=)` are given, adapter error A3 with the cause "an unread response follows the raw answer".
   - When §Cut Last Answer applies, it decides instead of Outcome row 5.
   - Without `reply_call`, when the cut stream's branch has a first-request system different from the raw call's branch, Outcome row 5 stands, decided as for a last unread response (case 1) and as without raw (two or more branches).
   - Cut streams that are recovered failures when taken as `timeout` failures are not counted here: another call of the same branch succeeded, so the stream was cut late and is not an answer (001 adapter-protocol §Streams the Service Cut, reason 1).

`fingerprint` is taken from the first request of the branch of the first-sent call among the raw call and the earlier searched calls with an unread response; with no such unread response, from the first request of the raw call's branch. The render target rule (the first variant model request) is not used.

With the uncaptured call as raw call there are no answer candidate calls: `answers` is 1 (0 in the uncaptured-call exception), and `fingerprint` and `branch` are omitted.

**Finish-reason check**: when the raw call is the last unread response and it is the last answer, or the raw call is the uncaptured call (not the exception), the finish reason cannot come from a response, so `Result(finish_reason=)` is required; without it, adapter error A9. Streams that ended in a tool call have a known end and do not need it (§Derived Result Fields).

- In services that regenerate through unread responses, the raw call (the last unread response) is the regenerated answer's call (K32).

### Cut Last Answer

When one of the two conditions below holds, the trial is decided as the failure check decides (the cut stream is a `timeout` failure; with several failures, the latest-ended) and gets the same warning. The cut streams meant here are those under view 1 that are unrecovered failures when taken as `timeout` failures.

1. **Last call cut**: the last-sent call among the searched calls' answers and unread responses is a cut stream, and no `Result(answers=)` was given. The helper's own count is not used, so the trial is a time-out whether or not the first answer came as a stream, and whether or not raw equals the first answer's text. A failure that ended after the cut stream (a resent request's 429) decides instead, as above.
2. **Raw call cut**: the raw call is a cut stream (the last unread response) and `Result(answers=)` is 1.
   - Not when `reply_call` exists and the searched calls include a complete response that ended after the cut stream was sent: an answer, or a stream that received a generation-end marker; without `answer_tool`, streams that ended in a tool call do not count; ended per §When a Call Ended.
   - Without such a response, the cut stream is an answer in the protocol. `Result(answers=)` counts answer cut streams as one in total, side-call answers excluded, so 1 means the service received no full answer.
   - With such a response, the stream was cut late and is not an answer, and the raw answer is that response's answer, possibly refined.
   - Without `reply_call` there is no such exception.

When this section decides the trial, the warning carries the regeneration sentence of [helper-api §Trial Warnings](contracts/helper-api.md#trial-warnings) after its first sentence, which asks for `answers` counting the cut answer and `finish_reason`: W6 when the cut stream decides, also with the sentence about a modified request sent alongside; W5 when another failure that ended after the cut stream decides (a resent request's 429).

- `Result(answers=)` of 2 or more is not caught: a fully received answer exists, and the adapter's `kind` is trusted. This matches Outcome row 7 for a service without raw that failed to regenerate and shipped the earlier answer. Without `Result(answers=)` and `Result(finish_reason=)` both, a matching answer hits Outcome row 5 and a last unread response hits the finish-reason check.
- Trials with a stream cut late that is not an answer (001 adapter-protocol §Streams the Service Cut, reason 1) are not caught this way.
  - A resend of the same request is one branch, so the cut stream is a recovered failure. When the re-received answer is given unchanged as raw, the last-sent call is that answer.
  - When a modified request was sent in parallel and the late one cut, or the re-received answer is refined, the raw call becomes the cut stream. With both requests selected by `reply_call` and `Result(finish_reason=, answers=1)`, the exception of the raw call cut condition applies.
  - Without `answers`, a modified request sent in parallel hits the last call cut condition, and with a refined re-received answer the helper counts the cut stream and reaches 2.
- The helper counts a cut stream as an answer only when it is the raw call (the last unread response). In trials where a cut stream must also count (cut for content and received again, or a regeneration cut after a fully received earlier answer), only `Result(answers=)` counts it ([helper-api §`Result`](contracts/helper-api.md#result)).

## Derived Result Fields

- **Raw call**: the call that produced the first answer. With no answer (tool-call responses, unread responses), the last successful answer candidate call. When the adapter gives raw, §Raw Call decides.
  - `modelSnapshot` is the raw call's response `model`; `Result(model_snapshot=)` overrides it.
  - `Result(usage=)` becomes the raw call's `usage`. When the raw call's record is a failure (a cut stream, a failure after the generation-end marker) and `Result(usage=)` is given, its `outcome` becomes `failed` and it is priced at that usage, as for corrected calls in §Matching Reported Failures.
- **`final`**: the returned text, the text inside `fallback(text)`, or `Result(final=)`. A `Result` without `final` ships `raw` with kind `model`, the empty string with kind `fallback`, and no `final` with kind `discarded` ([001 data-model §Trial](../001-swap-check/data-model.md#trial)). An explicit `final=None` with kind `model` or `fallback` is adapter error A14 (§Outcome Decision, non-text return).
- **Text**: Chat Completions `message.content`, or the empty string when absent; Responses, the text parts of the output messages joined without a separator; Anthropic, the `text` blocks joined without a separator. This equals the OpenAI SDK's `output_text`.
- **Finish reason**: that of the last answer by send order, and within one response the last `choices` item. Text answers map through §Finish Reasons; `answer_tool` answers follow §Answer.
  - When `Result(finish_reason=)` is not given, the last answer is not `stop`, and an earlier answer from the same request (an earlier `choices` item of the same response, an answer of a request with the same body) is `stop`, warning W3 is attached: the service may have discarded the cut answer and picked a complete one. A cut regenerated answer from a modified request gets no warning.
  - With no answer, the raw call's value. When the raw call ended in a tool call, streams that ended in a tool call included: `stop` with kind `model` (the service took that tool call as the final answer), `other` with `fallback` or `discarded`. The same applies when a stream that ended in a tool call and counted as the first answer (the last unread response) is the last answer. Such streams have a known end, so `Result(finish_reason=)` is not needed; for other unread responses it is required.
  - The adapter can override the value with `finish_reason`.
- **`usage`**: the sum over every call of the trial that has usage; per-call values stay in `calls`.
  - A failure that may have been billed for an unknown amount (§Call Outcome) stays `outcome: unanswered`, so the tool charges the call reservation.
  - Stream and background calls have unknown usage and are recorded without `usage`; the tool charges the call reservation ([001 data-model §Cost](../001-swap-check/data-model.md#cost)). `Result(usage=)` becomes the raw call's `usage`. Other stream calls, such as earlier calls of a streaming tool loop, stay at their reservation.
- **`calls`**: when calls were captured, they go in send order into normal results, model failure results and the `data` of adapter errors alike ([001 adapter-protocol §`generate`](../001-swap-check/contracts/adapter-protocol.md#generate-required)).
  - Every call has `model` and `outcome`. `branch` is present only when the answer branch was decided, so it is absent with Outcome rows 4 and 5, except in the Outcome row 5 exception, where every call is `side`. When the trial has no variant model call, no call carries `branch`, whichever Outcome row decides. `retryAfterMs` is present when the failed response said how long to wait and the call's kind is `transient` ([helper-api §`retryAfterMs`](contracts/helper-api.md#retryafterms)).
  - With no captured call (Outcome row 2, or calls made by other means than helper-api §Captured Requests), `calls` is omitted. The tool then prices `usage`, or charges the reservation without it.
- **`latencyMs`**: the duration of the whole service function.
- **`fingerprint`**: the first request of the branch that produced the first answer is converted to the render shape (`messages`, `tools`, [helper-api §Render Mode](contracts/helper-api.md#render-mode)) and hashed as the render fingerprint ([001 data-model §Identifiers and Hashing](../001-swap-check/data-model.md#identifiers-and-hashing)). With no answer, the first answer candidate request; with raw given, §Answer Candidate Calls When Raw Is Given. When that request is the render target, the value equals the render fingerprint.

## Matching Reported Failures

When the target function throws `ModelCallError` ([helper-api §`ModelCallError`](contracts/helper-api.md#modelcallerror)), the helper looks for the captured call that the thrown failure belongs to, among calls to the error's `model`. When that model is the variant model and `reply_call` exists, only calls it is true for are searched. Calls to another model are searched regardless of `reply_call`. With `call`, nothing is searched and that call is used as the matching-failure candidate.

Candidates:

1. **Started response**, when the thrown failure may have started a response (`status` 200, or `kind` `disconnect` or `timeout`): the last-sent unread response to that model. SSE responses qualify only if they received no generation-end marker. A stream that ended in a failure end event is not unread but already a failed call (the matching-failure candidate).
2. **Matching failure**: the last-sent unrecovered failure to that model that matches the thrown value. Recovered failures are not candidates.
   - With `status`, the call failed with an error response of that status; with 200, a failed 200 response.
   - With `kind`, the call failed without an error response: not reached, certificate, drop before headers or mid-body, read time-out, time-out or cancel. A call that failed mid-body still counts as having failed without an error response even though its header status was 200.
3. **Unfinished call**, when the thrown value is `kind` `timeout`: the last-sent unfinished call to that model (§After the Function Returned). The service ended without waiting for that response.

With several candidates, the latest-sent is used.

| Candidate | Record | Trial result |
|---|---|---|
| Started response | That call is corrected; no call is added | The thrown value |
| Matching failure | Unchanged, except that a `config` thrown value makes its kind `config` | That call's own kind, not the thrown value |
| Unfinished call | Unchanged, as the call ended; no call is added | The thrown value |
| None | A new call is appended to `calls`; with no captured call at all, no `calls` (§Derived Result Fields) | The thrown value |

- When the thrown value classifies as `config`, the trial and the call's kind are `config` even with the matching-failure candidate. An error response closed before the SDK resent has an unread body, so its quota code is unknown ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies)).
- `retryAfterMs` of the trial's failure belongs to the call whose kind decides it ([001 adapter-protocol §Reporting Model Failures](../001-swap-check/contracts/adapter-protocol.md#reporting-model-failures)). With the matching-failure candidate it is that call's own value from the response headers, and the thrown `retry_after_ms` is not used. Otherwise it is the thrown `retry_after_ms`, which a corrected or added call carries too. Either way it is present only when the kind is `transient`, on the trial's result and on every call record alike (§Derived Result Fields, `calls`).
- With no candidate, warning W10 is attached when the thrown value is a `status` or a `kind` other than `timeout`, and the only captured calls to that model (regardless of `reply_call`) with a failure matching it in the matching-failure sense have `retried` true. Not when that model is the variant model, `reply_call` exists, and no captured call is true for it. The outcome does not change.
- A corrected or added call has the `errorKind` from [helper-api §Error Classification](contracts/helper-api.md#error-classification). Its `outcome`: `failed`, priced at the usage, when `usage` was given. Without `usage`, a corrected call and `status` 200, `disconnect` and `timeout` are `unanswered` and charged the call reservation; a non-200 `status`, `connect` and `tls` are `failed`.

## Outside the Trial Context

The wrappers sit at class level, so requests to captured paths without a trial context are seen too. When the service hands work to a thread that does not carry the context (Python `loop.run_in_executor`, a thread it creates), the request cannot be tied to a trial.

1. A trial whose service function has ended and that waits before sending its result is not counted as in progress (§After the Function Returned). A `render` whose service function or render function is running counts as a trial in progress.
2. With exactly one trial in progress, the request joins that trial and is handled like a request of its context (waiting at function end, unfinished calls); when that is a render, it gets the render-mode 400 ([helper-api §Render Mode](contracts/helper-api.md#render-mode)). So such services run with concurrency 1. A request a background thread sends after the previous trial ended then joins the next trial in progress (K26).
3. With two or more trials in progress, all of them end as adapter error A10, a render included. The request is not blocked, except that it gets the render-mode 400 when one of them is a render, since it may be that render's request.
4. With no trial in progress, only the call's cost is reported, as a `calls` notification: with the `id` of the one trial waiting to send its result if there is exactly one, otherwise without `id`.

When the service passes the context along with the work (Python `executor.submit(contextvars.copy_context().run, fn)`, `asyncio.to_thread`), the request is inside the trial context and none of this applies.

## After the Function Returned

A service may call a model from background work (memory writes, analytics) after returning its answer.

### Unfinished Calls

When the function ends while its trial context has a request without a response, or a body being read (a body with a waiting reader), the helper waits for them to finish before sending the result. These are **unfinished calls**.

- Not unfinished, and not waited for: a body whose SSE copy received a generation-end marker (an unread response) and a body whose copy received a failure end event (a failed call), even while still being read. This is the case where the SDK's stream helper reads to the end in the background while the service returns on an event saying the answer text ended (openai-node `content.done`, raised on the `finish_reason` chunk). A service that returns on an intermediate event before the marker is K14.
- The wait lasts until the tool's time limit (`timeoutMs` of `initialize`) minus the time already spent, keeping 5 s so that the result reaches the tool.
- A body nobody is reading (SSE included) is not waited for and stays an unread response.
- Whether a body is being read is checked after yielding to the event loop once (Python `asyncio.sleep(0)`, Node `setImmediate`); one microtask is not enough on Node. A body read from a thread is not caught by yielding (K34).

### What Decides the Result

- The result is decided from what the service had received when the function returned. Unfinished calls, however they end while the helper waits, are not answers, successful calls, unrecovered failures (failure check included) or unread responses, and are not matching candidates of §Matching Reported Failures.
- The exceptions are the unfinished-call candidate, SSE responses taken as cut streams when the adapter gives raw (§Cut Streams), and §Raw Cannot Be Determined row 2.
- The helper waits only to learn their cost and `config` failures; a call that ends with `config` while waited for falls under Outcome row 1. An answer branch with an unfinished call and no answer is Outcome row 6's `timeout`.
- `reply_call` receives these calls without response fields (text, tool calls, finish reason, usage, `outcome`), so the answer branch does not depend on late responses.

### Late and Later Requests

1. A request first sent after the function returned does not join the trial, even while the helper waits; it is reported as a `calls` notification. When it ends during the wait, it is reported after the result is sent ([001 adapter-protocol §`calls`](../001-swap-check/contracts/adapter-protocol.md#calls-notification-adapter--tool-optional)).
2. A request still without a response when the wait ends joins the trial as `unanswered` with no error kind, like a call cut by the tool's `cancel`. A body still being read joins with the record of an unread response (`ok`, no `usage`). Both are charged the call reservation. The helper does not cut those requests or the service's work, and does not report them again when they end later.
3. A request sent from that trial context after the result was sent is reported as a `calls` notification when it ends. The tool adds its cost and does not grade it (a cost line, [001 data-model §Trial](../001-swap-check/data-model.md#trial)), and stops the run on a `config` failure or an unpriced model ([001 adapter-protocol §`calls`](../001-swap-check/contracts/adapter-protocol.md#calls-notification-adapter--tool-optional)).
4. On `shutdown`, the helper waits for such requests up to `timeoutMs` minus 5 s, reports them, then responds ([001 adapter-protocol §`shutdown`](../001-swap-check/contracts/adapter-protocol.md#shutdown-required)).
5. A same-model background request sent just before the function returns joins the trial's branches; sent just after, it becomes a notification. Without `reply_call`, Outcome row 5 can therefore come and go, and the A3 message names this cause. When the adapter gives raw, the result also depends on how far that request had got when the function returned, if no `Result(answers=)` was given:
   - before its response headers: an unfinished call, so the result does not change;
   - while receiving the stream: a cut stream, so §Cut Last Answer gives `timeout`, or Outcome row 5 when the system differs;
   - after its generation-end marker: Outcome row 5 (§Raw Call).
   With `reply_call` selecting the answer call, it is a side call in every case.
6. Exceptions in background work never reach the trial's result. The helper reports unhandled exceptions of Python asyncio tasks and Node promises as log warning L2 (K33).

## Service Version

Given `service_dir` (`serviceDir` in TypeScript), the helper reports in `initialize`'s `service` the full git commit SHA of that folder as `version` (40 characters for SHA-1 repositories, 64 for SHA-256), `dirty`, and `treeHash`. A relative path resolves from the adapter process's working folder (`adapter.cwd`). Without `service_dir`, none of the three is reported. Reasons for each rule below: [research R11](research.md#r11-identify-service-code-by-content-not-by-commit).

### Excluded Tool Files

`dirty` and `treeHash` look only inside `service_dir` and leave out the files and folders the tool sent as `toolPaths` in `initialize` (the config file, the files the rule and case globs matched, the output directory) and everything below them. Rule edits then do not block a resume when the evaluation files live inside the service repository (001 FR-013).

- Identity is by the file, not the path text: two entries are the same file when their `lstat` device and inode numbers are equal. Node reads them with `{ bigint: true }`.
- Each `toolPaths` entry is compared by both its `lstat` and its `stat` (link followed).
- A working folder reached through a symbolic link (macOS `/tmp`) and a path written with different case only (macOS default file system) are therefore the same file.
- `toolPaths` entries that do not exist now (an output folder not created yet, a deleted rule file) are skipped.

### `dirty`

`dirty` is true when `git --no-optional-locks status --porcelain -z --untracked-files=all --ignore-submodules=none -- .`, run in `service_dir`, shows a change in that scope. Its paths are relative to the repository top. A path absent from the work tree (a deleted file) is compared with `toolPaths` through its parent folders.

### `treeHash`

`treeHash` is the SHA-256, written as in [001 data-model §Identifiers and Hashing](../001-swap-check/data-model.md#identifiers-and-hashing), of the bytes built below for one folder, starting at `service_dir`. Repositories inside it (submodules, untracked nested repositories) are computed the same way.

1. **Paths**: join, in that folder, `git ls-files -z --cached` (tracked paths) and `git ls-files -z --others --exclude-standard` (untracked paths outside the ignore list).
   - A trailing `/` is removed, since git lists a nested repository it does not enter as `nested/`.
   - Duplicate paths (per-stage entries during a merge conflict) are kept once.
   - Paths are relative to that folder and handled as the bytes git printed, never decoded.
2. **Excluded paths**: a path that is, or has a parent folder up to this folder that is, the same file as a `toolPaths` entry; and a path absent from the work tree (a deleted file, or one that disappeared while computing: `lstat` or reading fails with "not found", or a nested repository's git fails and `lstat` of that folder then fails with "not found"; when the folder still exists, its git failure is reported per §When Nothing Is Reported).
3. **Kind**, from the work tree's `lstat`: a symbolic link is `l`; a regular file is `f`; a folder is a nested repository `s` when it is the top of a repository, else it is excluded, and files placed in it are not counted; anything else (sockets and so on) is excluded. A folder is a repository top when the folder `git -C <folder> rev-parse --show-toplevel` names is the same file as that folder.
4. **Content**: for `f`, the file bytes; for `l`, the bytes of the link target as `readlink` returned it; for `s`, that folder's `treeHash` string. Submodules are thus compared by file content, not by commit. Binary files, such as fake storage in SQLite, are included by content.
5. **Bytes**: sort the paths by bytes (Node sorts with `Buffer.compare`). For each path append: path, NUL, kind, NUL, content length in bytes as a decimal number, NUL, content.

Every git call runs with the variables printed by `git rev-parse --local-env-vars` (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and others) removed from its environment.

### When Nothing Is Reported

| Condition | Reported |
|---|---|
| git, `lstat` or a file read fails (permissions and similar; paths that vanish while computing are excluded by step 2). This includes git failing to start for any reason other than not being installed (`EACCES`), and a `service_dir` that does not exist or is not a folder: the helper runs `lstat` on `.` in `service_dir` before any git call, so a missing folder is never taken for a missing git | None of `version`, `dirty`, `treeHash`; the reason goes to log warning L1 |
| `service_dir` is outside a git work tree, or git is not installed (starting it fails with `ENOENT`) | None of the three |
| `service_dir` is in the ignore list (`git -C <service_dir> check-ignore -q .` exits 0), or the path list after step 3 is empty (the place of an uninitialised submodule) | None of the three |

- These rules apply to `service_dir` only. A nested repository whose list is empty contributes, as its `s` content, the `treeHash` of an empty list.
- Resume treats a missing value as a condition it cannot verify (`resume-unverified`, [001 data-model §Resume and Locking](../001-swap-check/data-model.md#resume-and-locking)).
- `service_dir` need not be the repository top (a service folder in a monorepo).

## Usage Buckets

Provider fields map to the protocol's non-overlapping buckets ([001 adapter-protocol §`generate`](../001-swap-check/contracts/adapter-protocol.md#generate-required), `usage`):

| API | `input` | `cachedInput` | `cacheWrite` | `output` | `reasoning` |
|---|---|---|---|---|---|
| Chat Completions | `prompt_tokens` − cache hits − cache writes | `prompt_tokens_details.cached_tokens` | `prompt_tokens_details.cache_write_tokens` | `completion_tokens` | `completion_tokens_details.reasoning_tokens` |
| Responses | `input_tokens` − cache hits − cache writes | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` | `output_tokens` | `output_tokens_details.reasoning_tokens` |
| Anthropic Messages | `input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` | `output_tokens_details.thinking_tokens` |

- OpenAI `prompt_tokens` and `input_tokens` are totals that include cache hits and cache writes, so both are subtracted; Anthropic `input_tokens` already excludes them. That OpenAI totals include cache writes is checked against fixtures recorded from real responses ([helper-scenarios S-RESP-02](contracts/helper-scenarios.md#responses)).
- A negative difference is set to 0 and warning W9 is attached.
- A bucket whose field is absent from the response is omitted.

## Finish Reasons

Provider values map to the protocol scale:

| Provider value | Protocol |
|---|---|
| `stop`, Responses `completed`, Anthropic `end_turn` and `stop_sequence` | `stop` |
| `length`, Responses `incomplete` with reason `max_output_tokens`, Anthropic `max_tokens` and `model_context_window_exceeded` | `length` |
| `content_filter`, Responses `incomplete` with reason `content_filter`, Anthropic `refusal` | `content_filter` |
| Tool calls (`tool_calls`, `function_call`, `tool_use`), Anthropic `pause_turn`, any other value | `other` |

The raw finish reason of a Responses call (helper-api `finishReason`) is its `status`, except that an `incomplete` response gives `incomplete_details.reason` when present. A failed call has none.

The response content is checked before the provider value. A response ended by the output limit or a filter is `length` or `content_filter`. Otherwise a response that holds a tool call (Chat Completions `message.tool_calls`, a Responses tool-call item, an Anthropic `tool_use` block) ended in a tool call, even when its Responses `status` is `completed`.

**Responses tool-call items** are output items the service must answer with a result before the response can continue:

| Tool-call item | Result item | The result points to the call when |
|---|---|---|
| `function_call` | `function_call_output` | `call_id` equals the call's `call_id` |
| `custom_tool_call` | `custom_tool_call_output` | `call_id` equals |
| `computer_call` | `computer_call_output` | `call_id` equals |
| `local_shell_call` | `local_shell_call_output` | its `id` equals the `local_shell_call`'s `call_id` |
| `shell_call` | `shell_call_output` | `call_id` equals |
| `apply_patch_call` | `apply_patch_call_output` | `call_id` equals |
| `mcp_approval_request` | `mcp_approval_response` | its `approval_request_id` equals the request's `id` |
| `tool_search_call` | `tool_search_output` | Not used; decided by `execution` (below) |

- In this pairing a `call_id` that is missing, `null` or the empty string counts as not given, and the item's `id` is used in its place. Any other non-string `call_id` is its canonical JSON (helper-api §Shared Conventions).
- A tool-call item that a result item of the same response already points to was run by the provider on the spot (a `shell_call` in a container environment) and is not a tool call.
- `tool_search_call` is decided by `execution`, because both items can arrive with an empty `call_id`: `server` means the provider ran it; `client` means it is a tool call.
- Items of tools the provider runs (`web_search_call`, `file_search_call`, `code_interpreter_call`, `mcp_call` and others) are not tool calls.
- New items are added to this list when they appear.

## Known Limits

Cases where the fixed rules decide differently from what the service did, because the helper cannot see the difference. Each is accepted. Where a limit needs more than its row, the reason is in [research R14](research.md#r14-outcome-decision-trade-offs).

- For parallel-check refusals ([001 adapter-protocol §Streams the Service Cut](../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut), reason 5), the limits that apply are K1, K2, K5, K11, K13 and K18. In K1, K2 and K5 (a mix with a swallowed failure of a parallel call, a swallowed failure of a side call made after the service settled on a fallback or discard without an answer, a block during an SDK retry wait), the trial counts as that failure, usually `transient`, instead of a fallback; K11, K13 and K18 have the effects their rows state.
- A shared-message service ships one message for several causes ([helper-api §Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting), shared messages). In K19 to K24 it reports per rule 3 there and lets the helper decide.

| ID | Limit |
|---|---|
| K1 | A swallowed failure and a later call sent together cannot be told apart, so the failure decides instead of being left out (Outcome row 3, §No Searched Calls, view 5) |
| K2 | A swallowed failure of a call made after the service settled on a fallback or discard without an answer (another model, or a same-model side call excluded by `reply_call`, such as a memory write) has no call after it and decides the trial; a transient one is usually corrected by the retry, other kinds count as that kind |
| K3 | Failures are not left out when the function raised a non-discard exception, so an unrelated exception after a handled failure (fake storage rejecting a query on the apology path) counts as that failure; trials that take the same path without a failure still show it as Outcome row 4 or 9 |
| K4 | An answer call through an uncaptured transport is not "a captured call sent after the failure", so such services get W1 on fallbacks that swallowed a transient failure of a captured call before the answer, and get none when a regeneration over the uncaptured transport failed |
| K5 | When the service ends, or a parallel check blocks, while the SDK waits before resending, no later or unfinished call exists and the earlier failure decides (without raw: Outcome row 6 for a fixed message or a `discard_on` exception, Outcome row 3 for another exception; under view 5: the failure check); the helper cannot know whether the SDK would have resent |
| K6 | `kind="timeout"` thrown during that wait after a failure without an error response (a connection failure or drop, or a read time-out on a non-stream body) matches that call, so the trial is `transient` |
| K7 | Without raw from the adapter, a stream cut without an awaited read is a successful call, so a request sent while it was being received that failed after it was cut becomes a recovered failure; the trial ends in the adapter error of §Raw Cannot Be Determined or Outcome row 9, unless the target function throws that failure |
| K8 | A Node stream helper left with `break` from `for await`, or `abort()` after one awaited microtask, has no awaited read when events remain in the chunk read at once, so the trial is normal or `timeout` depending on chunking |
| K9 | A time limit that fires while the service processes each chunk from an SDK iterator with `await` leaves no awaited read, so with an adapter that always gives `stopped_early` the cut text passes as complete |
| K10 | Under view 4 with a streamed first answer, `answers` counts the cut stream, so the regeneration rate counts one more |
| K11 | A streaming tool loop with `answer_tool` cannot give `answers=0`: a trial that hit the loop limit counts as an empty answer, and a trial whose last stream a parallel check cut counts as `timeout` |
| K12 | In a streaming tool loop with `answer_tool`, a provider error on the last call that the service swallowed passes the failure check; reported as `ModelCallError(call=)`, it counts as that failure |
| K13 | In the uncaptured-call exception and in view 5, text attached to a tool-call response (a short note before calling a tool) does not become raw and is not graded; a non-stream loop without raw from the adapter takes that text as raw per §Raw Cannot Be Determined row 1, because the raw-giving path accepts only an empty raw answer here |
| K14 | A service that returns on an intermediate event before the generation-end marker (Responses `response.output_text.done`, Anthropic `content_block_stop`) is normal or `timeout` depending on whether the marker had already arrived; one that re-draws with the same request on that event can become normal instead of `timeout` without reporting `answers`, because the two calls overlap and the cut re-draw becomes a recovered failure. W6 names this cause |
| K15 | A service whose SDK drops a last SSE event that has no final empty line (Python `openai` and `anthropic`, Node `@anthropic-ai/sdk`) may not receive the end event and may raise, so the same response, seen the same way by the helper, gives a result that differs by SDK (Outcome row 9) |
| K16 | When an uncaptured transport calls several models (sub-agents), `Result(usage=)` is added as one call and priced entirely at the variant model |
| K17 | A request the service only stopped waiting for that ended before the function returned looks like a received response: unreported, its late answer becomes the first answer, passes as complete (a fallback when wrapped) and counts in `answers` |
| K18 | A late answer that ended before the function returned becomes raw even when reported: when a shared-message service keeps collecting in the background after it stopped waiting, and when an answer request the service only stopped waiting for is reported after a parallel check's refusal |
| K19 | A non-stream request the service only stopped waiting for that ends before the function returns is a fallback |
| K20 | An answer stream that received its generation-end marker before the function returned (it failed validation, or a stream the service stopped waiting for ended late) is an empty answer ([001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes) row 6), and an answer that failed validation is not graded on raw rules |
| K21 | A request the service only stopped waiting for, unfinished at function end, whose resent request ended in another failure, is `timeout` |
| K22 | A stream cut for content is the last failure that finished instead of a fallback (usually `timeout`; `transient` when the resent request ended in 429), and the text before the cut is not graded |
| K23 | When another call's failure cannot be told apart, a trial whose answer request was cut because of it is `timeout`, and a fixed message shipped after the answer was fully received is an empty answer for a stream, else a fallback |
| K24 | When a parallel check's refusal cannot be told apart, a trial whose answer request was cut by that refusal is the cut answer request's `timeout` instead of a fallback |
| K25 | A failure without a status code thrown for a same-model side call excluded by `reply_call` matches an answer request that failed by time-out or cancel and gives `timeout` (matching-failure candidate) |
| K26 | At concurrency 1, a request a background thread sends after the previous trial ended joins the next trial in progress: it can add a branch (Outcome row 5), look like a call sent after a failure before the answer so that Outcome row 3 leaves that failure out (then Outcome row 4), or charge cost to the wrong trial |
| K27 | A service that sends the same request twice in parallel and sends and cuts the late one between the first stream's generation-end marker and its end event (usually a few ms) looks like a re-draw and becomes a time-out |
| K28 | A trial whose regeneration failed, after which the service asked another model and shipped its answer as a fallback, gets no warning W1 |
| K29 | In a service with a classification stream before the answer, the failure check does not run when the answer request fails: if the classification stream has a different system, successful trials report Outcome row 5; with the same system, nothing reports. A same-system side-call stream after a cut answer (validation) becomes the last unread response, and the cut last answer does not catch it either |
| K30 | The `call` check looks only at send time and branch, so giving the failure that ended first in a trial that resent a modified request, or sent the same request in parallel, is not caught: when one of two parallel requests ended in 429 and the service's time limit then cut the other, the right result is `timeout`, but the trial becomes `transient`, and throwing that 429 with `status` gives the same |
| K31 | A compatible server whose Chat Completions stream calls a tool but reports `finish_reason` `stop` is not recognised as a stream that ended in a tool call |
| K32 | In services that regenerate through unread responses, `Result(usage=)` attaches to the regenerated answer's call and the first answer's call is charged a reservation, so the total is higher than the actual cost |
| K33 | Fake storage rejecting an unexpected query in background work does not surface as an adapter error |
| K34 | A body read from a thread is not caught by yielding to the event loop, so it becomes an unread response when it is between chunks at that moment; a thread blocked in a read that waits for the next chunk is reading, not between chunks |
| K35 | A client created with `azure_deployment` has the path's deployment fixed and goes to that deployment whatever the body's `model` says; the variant model check reads only the body's `model` and does not catch it |
| K36 | A failure while writing the request body cannot be told apart from a connection closed before headers: on the httpx and httpx2 default transports httpcore swallows the write error, and aiohttp raises the same `ClientOSError` for both, with a broken pipe or a reset depending on timing. Such a call is `unanswered` and the trial `transient`. |
| K37 | A request the HTTP client refuses while sending the request for a reason other than its URL scheme (a header value it refuses) is not told apart from a drop before headers: the call is `unanswered` and charged its reservation, and the trial is `transient`, so every trial is retried and the run stops on the transient rate |
| K38 | The SDK can keep reading a stream after the service stopped waiting for it, so its end time comes out later than when the service stopped, and a failure that ended in between can be taken as ending first (§Cut Streams) |
| K39 | A stream the service cancels or closes between reads, with no read waiting, is not cut by that cancel: it stays an unread response, so a time limit that fires while the service is between chunks cannot be told apart from a deliberate stop ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies) item 6; K8, K9) |
