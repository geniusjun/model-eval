# Adapter Helper Scenarios Contract

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md) | **API**: [helper-api.md](helper-api.md)

Expected results of the helper contract tests (SC-002), the two-language parity tests (SC-003) and the uncaptured-call tests (SC-005). Every row runs in both helpers, against the local mock API servers, unless it names one language.

- "Outcome row N" is a row of [data-model §Outcome Decision](../data-model.md#outcome-decision).
- "K1" to "K36" are rows of [data-model §Known Limits](../data-model.md#known-limits): the expected result is the limit, not the service's real behaviour.
- A, W and L IDs are the messages of [helper-api §Messages](helper-api.md#messages).

## Two-Language Parity

Both helpers give the same values in every row ([spec FR-024](../spec.md#functional-requirements), SC-003). Rules: [data-model §Comparing Text](../data-model.md#comparing-text), [001 data-model §Canonical JSON](../../001-swap-check/data-model.md#canonical-json), [helper-api §`retryAfterMs`](helper-api.md#retryafterms), [helper-api §Reading Response Bodies](helper-api.md#reading-response-bodies), [data-model §Service Version](../data-model.md#service-version), [research R13](../research.md#r13-make-both-helpers-produce-the-same-bytes).

| ID | Scenario | Same in both helpers |
|---|---|---|
| S-PAR-01 | Raw and shipped text with U+FEFF, U+0085 or U+001F at either end | Raw, shipped text and emptiness |
| S-PAR-02 | A discard reason over 200 characters that contains emoji | `discardReason` |
| S-PAR-03 | `answer_tool` arguments with `1.0`, `1e-07`, `-0.0`, an integer above 2^53 | Raw |
| S-PAR-04 | An object whose keys are U+FF01 alone and U+1F600 alone | Key order (the U+1F600 key first) |
| S-PAR-05 | Object values and keys with lone surrogates | Raw |
| S-PAR-06 | Arguments containing `NaN` or `1e400` | Not JSON, so the raw answer is empty |
| S-PAR-07 | JSON, SSE and `with_streaming_response` responses compressed with each advertised encoding (gzip, br, zstd) | Raw, usage and end events |
| S-PAR-08 | Usage whose input minus cache writes is negative | 0 and warning W9 |
| S-PAR-09 | `retry-after-ms` and `retry-after` together | The first |
| S-PAR-10 | `retry-after: 1.5`; `30s`, `-1`, `1e3`; `0.5005`; a number of 400 nines | 1500; not recorded; 500; not recorded |
| S-PAR-11 | `ModelCallError` `retry_after_ms` of -1 or NaN | Not recorded |
| S-PAR-12 | An HTTP date; a past date | The difference; 0 |
| S-PAR-13 | `treeHash` scenarios of §Render and Version (S-RV-04 to S-RV-17) | `version`, `dirty`, `treeHash` |

## Uncaptured Calls

Each load-order and uncaptured-transport scenario ends as listed, and none records an empty raw answer in a normal trial (SC-005). Rules: [helper-api §Captured Requests](helper-api.md#captured-requests), [helper-api §Not Captured](helper-api.md#not-captured), [data-model §Outcome Decision](../data-model.md#outcome-decision) rows 2 and 4.

| ID | Scenario | Expected |
|---|---|---|
| S-UNC-01 | An SDK imported after the helper | Captured |
| S-UNC-02 | `httpx` and `httpx2` both installed | Both captured |
| S-UNC-03 | A service that calls `httpx2.alias_httpx()` | The service starts normally, and each call is recorded once |
| S-UNC-04 | Node: a client created before the helper import | Outcome row 2 adapter error (A1) |
| S-UNC-05 | A service that calls the model from a child process, like the Claude Agent SDK | Outcome row 2 adapter error with the guidance of helper-api §Not Captured |
| S-UNC-06 | The answer through the Claude Agent SDK and a same-model intent classification through the Anthropic SDK | With raw and `model=` from the target function and the classification excluded by `reply_call`: raw is the answer and the classification is a side call |
| S-UNC-07 | The answer through an uncaptured transport, only other-model calls captured | Outcome row 4 adapter error (A2) |

## Responses

Rules: [data-model §Captured Call](../data-model.md#captured-call), [data-model §Usage Buckets](../data-model.md#usage-buckets), [data-model §Call Branches](../data-model.md#call-branches), [data-model §Raw Cannot Be Determined](../data-model.md#raw-cannot-be-determined), [helper-api §Render Mode](helper-api.md#render-mode), [helper-api §Cancel](helper-api.md#cancel).

| ID | Scenario | Expected |
|---|---|---|
| S-RESP-01 | Normal response | Raw, usage, finish reason recorded |
| S-RESP-02 | Cache-hit and cache-write tokens (OpenAI from fixtures recorded from real responses) | Buckets per [data-model §Usage Buckets](../data-model.md#usage-buckets) |
| S-RESP-03 | Tool loop of two calls | One branch |
| S-RESP-04 | Final answer as a tool call without text | `model`: adapter error A4. `fallback` or discard: empty raw |
| S-RESP-05 | Responses tool-call response with `status` `completed` | Ended in a tool call |
| S-RESP-06 | Stream response | data-model §Raw Cannot Be Determined row 2 unless raw is given |
| S-RESP-07 | Discard exception; undeclared exception | Outcome row 8; Outcome row 9 |
| S-RESP-08 | Variant model mismatch | Outcome row 4 |
| S-RESP-09 | Render mode; `print` in the service | Render result, no request sent; output on stderr |
| S-RESP-10 | Four concurrent requests | Contexts kept apart |
| S-RESP-11 | Cancel | helper-api §Cancel |
| S-RESP-12 | Background mode: the first response has `status` `queued` and the target function returns text without raw | data-model §Raw Cannot Be Determined row 3, adapter error A6 |

## Answer Calls

Rules: [data-model §Call Branches](../data-model.md#call-branches), [data-model §Answers](../data-model.md#answers), [data-model §Outcome Decision](../data-model.md#outcome-decision), [data-model §Outcome Row 6 Details](../data-model.md#outcome-row-6-details), [data-model §Another Model's Answer](../data-model.md#another-models-answer), [data-model §Variant Model Call](../data-model.md#variant-model-call).

| ID | Scenario | Expected |
|---|---|---|
| S-ANS-01 | A same-model side call after the answer | Without `reply_call`, Outcome row 5; with it, the first answer of the answer candidates is raw |
| S-ANS-02 | A validation call that continues the conversation after the answer | A new branch, so Outcome row 5 without `reply_call` |
| S-ANS-03 | A re-draw with the same request | One branch, the first answer is raw, `answers` 2 |
| S-ANS-04 | A regeneration with a modified request (same system plus a critique), `reply_call` true for both branches | First answer is raw, `answers` 2, fingerprint equals the render fingerprint |
| S-ANS-05 | Without raw: the regeneration streamed and cut by the service's time limit (cancelled or only stopped waiting) | data-model §Raw Cannot Be Determined adapter error |
| S-ANS-06 | Without raw: the regeneration stream cut after its generation-end marker and before the end event | The same adapter error |
| S-ANS-07 | Without raw: the regeneration request had received no response headers when the function returned and answered later with SSE | An unfinished call, so Outcome row 7, normal with the earlier answer |
| S-ANS-08 | Without raw: the first answer streamed in full, a re-draw with the same request ends in 429 after the SDK's retries, the earlier answer is shipped | The stream with a generation-end marker counts as an answer in Outcome row 6, so data-model §Raw Cannot Be Determined adapter error, not transient |
| S-ANS-09 | `reply_call` true for both calls; the first answer stream fails with a provider error event and the same request is fetched again without streaming | Normal, no adapter error. Without `reply_call` the same, since the requests differ only in streaming and form one branch |
| S-ANS-10 | `reply_call` true for a classification call (different system) and the answer call | Outcome row 5. Also when only a leading `developer` message in Responses `input` makes the systems differ |
| S-ANS-11 | Reasoning tool loops: Anthropic `thinking` and `redacted_thinking` blocks sent back, a request continuing after `pause_turn`, a Responses loop resending `reasoning` items without `previous_response_id`, a Responses loop chained by `conversation` | One branch |
| S-ANS-12 | Responses loops over `custom_tool_call`, `computer_call`, a local `shell_call`, `mcp_approval_request`, and `tool_search_call` with `execution` `client` | One branch; earlier responses are not answers |
| S-ANS-13 | The same loop as streams, the last call ending in `response.failed`, the service shipping what it received | `transient` |
| S-ANS-14 | A response through a container shell tool (`shell_call`, `shell_call_output`, message) or a provider-run tool search (`execution` `server`, also with an empty result `call_id`) | An answer |
| S-ANS-15 | The same request sent in parallel, first answer used and the rest cancelled | Normal; the cancel is a recovered failure; `answers` 1 |
| S-ANS-16 | The same, both succeed | The first sent is raw; `answers` 2 |
| S-ANS-17 | A non-stream request first and the same request as a stream; the finished non-stream answer is used, the stream cut, that answer given as raw | One branch, so the cut stream is a recovered failure; neither Outcome row 5 nor the cut last answer applies; normal, `answers` 1 |
| S-ANS-18 | Chat Completions `n` = 3 | First `choices` item is raw, `answers` 3, finish reason of the last item. Last item not `stop` and an earlier one `stop` without `Result(finish_reason=)`: W3; with it, that value. A regeneration with a modified request that was cut: no warning |
| S-ANS-19 | A forced `reply` tool with `answer_tool` | Raw is the argument, finish reason `stop`. Called again after validation: `answers` 2. Argument cut at the output limit: empty raw, `length`. The service sends a tool result and continues the branch: `answers` 1 |
| S-ANS-20 | A regeneration with a changed system, `reply_call` true for both branches, first answer as `Result(raw=)` | No Outcome row 5, `answers` 2, finish reason of the regenerated answer; the raw call is the first answer's response with the same text. Without `reply_call`, `Result(raw=)` alone is Outcome row 5 (answer outside the raw call's branch); with `Result(finish_reason=, answers=)` too, normal with those values |
| S-ANS-21 | Same request to two models at once, the candidate loses | Outcome row 6, `timeout` |
| S-ANS-22 | Tool loop limit reached, fixed message shipped | `fallback`, empty raw, `answers` 0 |
| S-ANS-23 | Another model's answer shipped without `fallback`: after the first answer; the same request to two models, both succeed; another model regenerates with a changed prompt and the text is shipped unchanged; another model answers through `answer_tool` | W2 |
| S-ANS-24 | A memory summary by another model (another system) whose text differs from the shipped text | No warning |
| S-ANS-25 | A same-model classification before the answer | Without `reply_call`, Outcome row 5 in a run and `anchor-missing` in lint |
| S-ANS-26 | That classification refuses and the service ships a fixed message without requesting the answer | With `reply_call` and `fallback`: a fallback with `answers` 0; unwrapped: Outcome row 5. A raw-giving service: `Result(raw="", kind="fallback", finish_reason="other")` with `reply_call` is a fallback; without `reply_call` the classification's answer is a searched answer, so A7 |
| S-ANS-27 | Another model's language detection fails, the service swallows it, then the classification refuses | The classification was sent after the failure, so not Outcome row 3: a fallback. Both sent together: `transient` (K1) |
| S-ANS-28 | `reply_call` excludes the classification; it refuses; before returning the service calls another model for a memory write that ends in 429 and is swallowed | `transient` (Outcome row 3; K2) |
| S-ANS-29 | Another model's call before the answer is blocked, so render cannot reach its target | A11 |
| S-ANS-30 | `reply_call` true only for calls to another model | Outcome row 5 |
| S-ANS-31 | A variant model call fails and the service answers with another model | Outcome row 6 |
| S-ANS-32 | A regeneration fails and the service ships the first answer | Outcome row 7, no warning |
| S-ANS-33 | A failed validation answer regenerated with another model, that request ends in 429 after the SDK's retries, a message is shipped | Outcome row 7; wrapped, a fallback with W1 |
| S-ANS-34 | Regenerating with the same model ends in 429 and a larger model answers | Outcome row 7. Unwrapped: W2. Wrapped: a fallback; the larger model's call came after the failure, so no warning |
| S-ANS-35 | Regeneration ends in 429 and the service raises the SDK exception | Outcome row 3, `transient` |
| S-ANS-36 | Regeneration ends in 429 and the service raises a `discard_on` exception | Outcome row 8 discard with W1 |
| S-ANS-37 | A check sent with the answer fails with 429 after the first answer ended, the service ships a message, the target function only wraps it | A fallback with W1 |
| S-ANS-38 | Content cut, the same request resent ends in 429 after the SDK's retries, a message shipped | `Result(raw=<pre-cut text>, kind="fallback", finish_reason="other")`: a fallback with W1. Nothing is thrown |
| S-ANS-39 | Content cut, the resent stream cut by the service's time limit, a message shipped | The same `Result`: a fallback, no warning. `timeout` is not thrown |
| S-ANS-40 | Cut late, the resent stream cut for content, a message shipped | The same `Result`: a fallback; raw is the content-cut text |
| S-ANS-41 | Content cut, the resent request ends in 429, a larger model's answer shipped | The same `Result`: a fallback; the larger model's call came after the failure, so no warning |
| S-ANS-42 | The same check fails with 429 before the first answer arrived | A fallback with W1 |
| S-ANS-43 | Regeneration ends in 429, another model's regenerated answer is shipped | Wrapped, a fallback, no warning (K28) |
| S-ANS-44 | The regeneration request ends in 403 and the service ships the first answer | Outcome row 1, `config` |
| S-ANS-45 | Names sharing a prefix (`model-b` and `model-b-mini`) | Not the variant model |
| S-ANS-46 | A dated snapshot name (`model-b-2026-10-01`) | The variant model; prices found under `model-b` |

## Streaming Services That Give Raw

Rules: [data-model §When the Adapter Gives Raw](../data-model.md#when-the-adapter-gives-raw), with its subsections data-model §Cut Streams, §Failure Check, §Raw Call and §Cut Last Answer.

| ID | Scenario | Expected |
|---|---|---|
| S-STR-01 | The variant request gets 429 after the SDK's retries (the SDK closed the first two 429s unread), the service ships a fixed message, the adapter gives an empty raw without `Result(model=)` | The failure check comes before the raw call: `transient`, no uncaptured call added, warning W5. A whitespace-only raw (`"\n"`) too |
| S-STR-02 | A non-stream same-model classification answers in text, then the answer stream gets 429, the adapter gives an empty raw | The classification answer does not block the check: `transient`, W5 |
| S-STR-03 | A same-model classification before the answer, no `reply_call`, `Result(raw=, finish_reason=, answers=)` | No Outcome row 5; the fingerprint is the stream request's, unlike the render target (the classification): `render-mismatch` |
| S-STR-04 | Classification and answer both stream, no `reply_call` | Outcome row 5 (unread responses with different systems) |
| S-STR-05 | The answer through an uncaptured transport; only a same-model side call excluded by `reply_call` is captured and fails | Normal with the given raw |
| S-STR-06 | The same without `reply_call`, the side call fails with 400 and the service swallows it | `permanent` with W5, as Outcome row 6 without raw |
| S-STR-07 | The service stops waiting under its own time limit without cutting the request and gives what it received | `timeout` with W6, as when it cuts the request |
| S-STR-08 | Background work reads the stream and the function returns on the `finish_reason` chunk | Normal even when `[DONE]` is not in the copy yet |
| S-STR-09 | Return on `content.done` of the openai-node stream helper (`client.chat.completions.stream()`), or `abort()` after it | Normal, the same as the Python service with the same logic |
| S-STR-10 | Return on Responses `response.output_text.done` | Normal when `response.completed` is already in the copy; otherwise `timeout` with W6 (K14) |
| S-STR-11 | A content cut (`break` or `close` in the read loop, cancelling an awaited read, only stopping to wait) given as `Result(raw=, kind="fallback", finish_reason="other")` | A fallback; raw rules grade that text; no failure check; the raw call is that stream |
| S-STR-12 | The same with an awaited read cancelled and `usage=` given | That stream call becomes `failed` and is priced at that usage |
| S-STR-13 | The same with no `kind` and `finish_reason="stop"` | `timeout` with W6 in all three styles |
| S-STR-14 | Content cut, regenerated with a non-stream request and shipped, `reply_call` true for both, the pre-cut text as raw | Normal; raw call is the cut stream; `answers` 2; finish reason of the regenerated answer |
| S-STR-15 | Content cut, the same request resent as a stream and fully received, `Result(raw=<pre-cut text>, finish_reason="stop", answers=2)` | Normal, `answers` 2. Without `answers`, the helper takes it as a late cut: 1 |
| S-STR-16 | `break` at a configured string with `Result(raw=, finish_reason="stop", stopped_early=True)` | Normal |
| S-STR-17 | The same logic with `break` from a Node stream helper's `for await` | Events sent one by one: the SDK cancels the awaited read, `timeout` with W6. Two events in one chunk, stopping at the first: normal (K8) |
| S-STR-18 | The same logic with an immediate `abort()` inside the event handler | Normal, also on openai-node 5 and 6 and `@anthropic-ai/sdk` 0 and 1, which read the body once more after abort |
| S-STR-19 | `abort()` after an `await` in the handler | Events one by one: `timeout` with W6. Waiting one `setImmediate`: always `timeout`. One `await null` with two events in one chunk: normal at the first event (K8) |
| S-STR-20 | `break` at a configured string without `stopped_early` | `timeout` with W6 |
| S-STR-21 | An adapter that always gives `stopped_early`; the service's time limit cancels an awaited read | `timeout` |
| S-STR-22 | The same adapter; the time limit fires while the service processes each chunk from the iterator with `await` | No awaited read, so it passes as complete (K9). Without `stopped_early`, or through a Node stream helper: `timeout` |
| S-STR-23 | `stopped_early` with `kind="fallback"` or an empty raw | Ignored, W7 |
| S-STR-24 | A streaming tool loop (earlier calls are tool-call streams), the last call cut for content | No `kind` with `finish_reason="stop"`: the earlier calls do not block the check, `timeout` with W6. `kind="fallback"`: a fallback. Resent as a stream after the cut and fully received and shipped: normal, raw is the pre-cut text; `answers=2` gives 2 |
| S-STR-25 | The same with `answer_tool` on the target | The earlier calls block the check, but the cut last answer gives `timeout`. A last call ending in a provider error that the service swallows passes (K12); when the target function reads that call's `outcome` and reports `ModelCallError(call=)`, `transient` |
| S-STR-26 | A streaming tool loop hits its limit, a fixed message, `Result(raw="", kind="fallback")` | `answers` 0, a fallback |
| S-STR-27 | The same loop with the service's time limit cancelling the last call and shipping what it received | `timeout` |
| S-STR-28 | The same loop's last call ends in a provider error event or a mid-body drop and the service ships what it received | `transient` with W5 |
| S-STR-29 | A tool loop of non-stream requests whose last answer only is streamed hits its limit, never sends that stream, ships a fixed message, `Result(raw="", kind="fallback", finish_reason="other")` | `answers` 0, a fallback. Not an adapter error without `Result(model=)`, and no uncaptured call is added |
| S-STR-30 | A provider error mid-stream (Anthropic `overloaded_error` event, Responses `response.failed`, Chat Completions `error` data) swallowed, received text given as raw | `transient` with W5 in all three APIs |
| S-STR-31 | A drop after the generation-end marker and before `[DONE]`, the service ships the full answer | `kind` `model`: normal. `fallback`: `transient` |
| S-STR-32 | A shared message for time limits and swallowed call failures with no other marker; the deadline fires and the service leaves the iterator | `Result(raw="", kind="fallback", finish_reason="other")`: `timeout` with W6. `fallback(text)` alone: data-model §Raw Cannot Be Determined adapter error. Throwing `kind="timeout"` on the message alone: `timeout` |
| S-STR-33 | The same service swallows the answer request's 429 and ships the same message | The same `Result`: `transient` with W5. Throwing `kind="timeout"` on the message alone: no candidate matches, so a new call and `timeout` |
| S-STR-34 | The same service fully receives the answer stream, validation fails, the same message | An empty raw: an empty answer, and that answer is not graded on raw rules (K20). Reading the collected stream's finish reason and giving the received text with `kind="fallback"` and `finish_reason="other"`: a fallback graded on raw rules |

## Regeneration in Streaming Services That Give Raw

Rules: [data-model §Answer Candidate Calls When Raw Is Given](../data-model.md#answer-candidate-calls-when-raw-is-given), [data-model §Cut Last Answer](../data-model.md#cut-last-answer).

| ID | Scenario | Expected |
|---|---|---|
| S-REGEN-01 | A streamed first answer filtered, a modified request streamed for regeneration and cut by the service's time limit, the first answer refined and shipped | `Result(raw=<first answer>, finish_reason="stop", answers=2)`: normal, the first answer's violations count on raw rules. Without `answers`: cut last answer, `timeout` with W6. `kind="fallback"`: a fallback |
| S-REGEN-02 | The same, the regeneration stream cut before its first character | `answers=2`: normal; a cut answer stream counts even without text |
| S-REGEN-03 | A same-request re-draw on `content.done` of the openai-node stream helper, cut by the service's time limit, first answer shipped | The first stream ended when its generation-end marker was read, even though the SDK read its usage and `[DONE]` after the re-draw was sent. Without `answers`: cut last answer, `timeout`. `answers=2`: normal. The same as the Python service |
| S-REGEN-04 | The same on Responses `response.output_text.done` | `answers=2`: normal. Without it: `timeout` or normal depending on whether `response.completed` arrived before the re-draw was sent (K14) |
| S-REGEN-05 | The first answer fully received without streaming, a modified request (same system) streamed for regeneration and cut by the time limit, the first answer shipped | `Result(raw=<first answer>, finish_reason="stop", answers=2)`: normal. Without `answers`: `timeout` with W6. When the same request is resent after the cut and ends in 429 after the SDK's retries: without `answers`, `transient` with W5 plus the `answers` guidance; `answers=2`: normal |
| S-REGEN-06 | The same with `reply_call` true for both calls, an Anthropic response with two `text` blocks, only the first block given as raw | The raw call becomes the cut stream; without `answers` still `timeout`; the helper's own count is not used. Without `reply_call`: Outcome row 5 (answer outside the raw call's branch) |
| S-REGEN-07 | The answer without streaming; just before returning, the function streams a memory extraction with another system to the same model, still running at function end; `Result(raw=, finish_reason="stop")` without `reply_call` | Outcome row 5. Also when that stream got its generation-end marker before the function returned. With `reply_call` excluding it: normal |
| S-REGEN-08 | The same request as two streams, the first finished answer used, the late one cut | Normal; the cut stream is a recovered failure and not an answer; `answers` 1 |
| S-REGEN-09 | A stalled answer stream cut, the same request resent, fully received and given as raw | Normal, `answers` 1, whichever line cuts or resends first. Also when the resend is non-stream, or a modified request (same system) that asks for a short answer |
| S-REGEN-10 | The same with a modified non-stream resend, `reply_call` true for both, the re-received answer refined, `Result(raw=, finish_reason="stop", answers=1)` | The raw call becomes the cut stream, but an answer that ended later exists among calls `reply_call` is true for, so the cut last answer does not apply: normal. Without `answers=1` it does not apply either, but the helper counts the cut stream: 2. Without `reply_call`: `timeout` |
| S-REGEN-11 | Content cut, regenerated with a modified non-stream request and shipped, no `reply_call`, `Result(raw=<pre-cut text>, finish_reason=, answers=2)` | Normal, no Outcome row 5 |
| S-REGEN-12 | A non-stream same-model classification answers in text, the answer stream is cut for content, `Result(raw=, finish_reason="stop", answers=1)` without `kind` | The classification answer is not counted in `answers`; it blocks the failure check but the cut last answer gives `timeout` |
| S-REGEN-13 | The same with a same-system streaming classification | The same |
| S-REGEN-14 | After the same classification, the answer stream cut by a first-token time limit, the same request resent and cut by the overall time limit, what was received is shipped | The two cut answer streams count as one, `Result(answers=1)`; cut last answer, `timeout` |
| S-REGEN-15 | The answer stream cut by the service's time limit and the received text shipped, then a non-stream same-model memory summary; `Result(raw=, finish_reason="stop", answers=1)` without `reply_call` | Cut last answer, `timeout` with W6, even with the later memory summary. With `reply_call` selecting the answer call: the failure check gives `timeout`. When the memory summary ends in 429 after the SDK's retries and is swallowed: without `reply_call` it cannot be told from a failed modified resend, so the latest-ended failure, `transient` with W5; with `reply_call` excluding it, `timeout` |
| S-REGEN-16 | The original request streamed; when it is late, without cutting it, a modified request (same system, asking for a short answer) also streamed; the original finishes first, the modified one is cut, the original's answer shipped | `reply_call` true for both and `Result(raw=, finish_reason="stop", answers=1)`: normal, `answers` 1. Without `reply_call` or `answers`: cut last answer, `timeout` with W6 |
| S-REGEN-17 | A stalled answer stream cut (an awaited read cancelled, `break` with or without close), the same request resent, the resend gets 429 after the SDK's retries, a fixed message shipped | `ModelCallError(status=429)` or `call=`, or an empty raw with `kind="fallback"`, or `fallback(text)` without raw: `transient` in both languages, no call counted twice. Also when the service raises the SDK exception instead, or closes the cut stream after the resend failed. A resend that also ends at the time limit with `ModelCallError(kind="timeout")`: `timeout`. When the service only stopped waiting for the first stream and the target function returns a value without throwing: the unfinished call gives `timeout`; when that stream came in full before the function returned, a value without raw is an adapter error, and an empty raw makes that stream the raw call, so an adapter error without `finish_reason` and an empty answer with it (`answers` 1, 001 data-model §Trial Outcomes row 6) (K17). Throwing `status=429` gives `transient` either way |
| S-REGEN-18 | The same request sent alongside without cutting; after the SDK's last retry is sent and before its 429 arrives, the service cuts the first stream without an awaited read (Python or Node `create` iterator `break`, an immediate `abort()` in a Node stream helper handler) and ships a message | An empty raw with `kind="fallback"`, or throwing `status=429` or `call=`: `transient`, no call counted twice. A value without raw, or the service raising: the first stream overlaps that request as a successful call, an adapter error (K7). Cut before the last retry was sent: no overlap, `transient` in all forms. Two streams sent together where the winner cut the other and then ended in a mid-stream provider error: the same limit (K7) |
| S-REGEN-19 | The same request as two streams; the first to end fails with 429 after the SDK's retries and the service cuts the other and ships a message | Throwing that failure with `status=429` or `call=`: `transient`, no call counted twice. Not thrown: the cut stream looks like the last failure, `timeout` or an adapter error |
| S-REGEN-20 | The service cut, as late, a stream the SDK had resent after a 429, and the target function gives the earlier 429 as `call=` | A request followed it, so A13 whatever the cut style |

## Other Raw-Giving Scenarios

Rules: [data-model §Raw Call](../data-model.md#raw-call), [data-model §Answer Candidate Calls When Raw Is Given](../data-model.md#answer-candidate-calls-when-raw-is-given).

| ID | Scenario | Expected |
|---|---|---|
| S-RAW-01 | Every scenario that passes the failure check and lands on the uncaptured call (data-model §Raw Call) | Needs `Result(model=)`; without it A7 |
| S-RAW-02 | A captured answer refined and given as `Result(raw=, finish_reason=, model=)`, and a same-model side call fails and is swallowed | No failure check, so not a failed trial; added as an uncaptured call with W4 |
| S-RAW-03 | An adapter that does not pass the variant model refines another model's captured answer and gives `Result(raw=, finish_reason=, model=<variant>)` | Outcome row 4 passes, but another model's answer contains raw: W8 |
| S-RAW-04 | A streamed first answer filtered, regenerated without streaming, `reply_call` true for both branches, first answer as `Result(raw=)` | `answers` 2, finish reason of the regenerated answer |
| S-RAW-05 | A non-stream first answer filtered, regenerated by stream, `reply_call` true for both, only `Result(raw=<first answer>)` | Outcome row 5. With `Result(raw=, finish_reason=, answers=)`: those values |
| S-RAW-06 | A service that streams from a default model; the adapter does not pass the variant model and gives collected raw with `Result(model=<variant>)` | W8; with rendering on, a configuration error at start |
| S-RAW-07 | A short raw answer contained in another model's long summary | No warning |
| S-RAW-08 | A tool loop whose last call alone is non-stream | Earlier calls also `branch: answer`; `fingerprint` is the first request |
| S-RAW-09 | A streaming same-model classification before a non-stream answer | Outcome row 5 |
| S-RAW-10 | The answer through an uncaptured transport, only a same-model classification captured and excluded by `reply_call`; the answer is empty (reasoning used the whole output limit) and turned into a message: `Result(raw="", kind="fallback", model=, usage=, finish_reason="length")` | Not the uncaptured-call exception: the call is added, `answers` 1, an empty answer. Also with a swallowed other-model side-call failure |
| S-RAW-11 | No captured call, only an uncaptured transport; a same-model classification before the answer refuses and a message is shipped | `Result(raw="", kind="fallback", model=, answers=0, finish_reason="other")`: a fallback, `answers` 0. Without `model=`: A7. Without `answers`: an empty answer |
| S-RAW-12 | A stream answer given as `Result(raw=)` without `finish_reason=` | The raw call is the last unread response and the last answer, so the finish-reason check gives adapter error A9 |

## Status Codes

Rules: [helper-api §Error Classification](helper-api.md#error-classification), [data-model §Call Outcome](../data-model.md#call-outcome).

| ID | Scenario | Expected |
|---|---|---|
| S-STAT-01 | 429 then a successful SDK retry | Normal: in both languages the 429 the SDK closed unread is a recovered failure |
| S-STAT-02 | 429 only | `transient` |
| S-STAT-03 | A tool loop's earlier call succeeds, the later call ends in 429 after the SDK's retries, a fixed message | The earlier call ended before the later was sent, so it does not recover the failure: Outcome row 6, `transient` |
| S-STAT-04 | Quota exhaustion, every quota code of [helper-api §Error Classification](helper-api.md#error-classification) | `config` |
| S-STAT-05 | Anthropic `details.error_code`: `enforced_spend_limit_reached` in a 429; `organization_on_hold`, `claude_code_key_creator_not_member`, `claude_code_version_too_old` in a 400; `skill_read_blocked_undecryptable` in a 409 | `config` |
| S-STAT-06 | Anthropic `ramp_limit_exceeded` in a 429 | `transient` |
| S-STAT-07 | Anthropic `thread_not_found` in a 404 | `permanent` |
| S-STAT-08 | A beta `thread` service gets `thread_not_found`, resends the whole conversation and answers | `reply_call` true for both requests: normal. Without it: two branches, Outcome row 5 |
| S-STAT-09 | 401; 402; 400 billing error in both shapes (type and message) | `config` |
| S-STAT-10 | 400 | `permanent` |
| S-STAT-11 | 408 remaining after the SDK's retries | `transient` |
| S-STAT-12 | 409 | `permanent` |
| S-STAT-13 | 529 | `transient` |
| S-STAT-14 | Responses `failed` with `server_error`, and with other codes | With usage: `failed`, priced at it. Without: `unanswered` |

## Connections and Time

Rules: [helper-api §Reading Response Bodies](helper-api.md#reading-response-bodies), [helper-api §End Events](helper-api.md#end-events), [helper-api §Error Classification](helper-api.md#error-classification), [helper-api §Transport Exceptions](helper-api.md#transport-exceptions).

| ID | Scenario | Expected |
|---|---|---|
| S-CONN-01 | TLS certificate failures: self-signed (Node `DEPTH_ZERO_SELF_SIGNED_CERT`), a proxy that does not send its root (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), expired, hostname mismatch; on the httpx and httpx2 default transports, the aiohttp backend and Node | `config`, `failed` |
| S-CONN-02 | Connection refused, connect time-out, connection-pool wait time-out, request body write failure | `transient`, `failed`; a request body write failure is `transient`, `unanswered` (K36) |
| S-CONN-03 | The server closes the connection after the request without a response | `transient`, `unanswered` |
| S-CONN-04 | A drop while receiving; a read time-out on a non-stream body | `transient` |
| S-CONN-05 | A read time-out between stream events | `timeout` in both languages |
| S-CONN-06 | A read time-out before the response; the service cancelling the request before or during the response | `timeout` |
| S-CONN-07 | Connection refused and a drop before headers raised inside an `except` block handling another HTTPS call's certificate error | `transient` |
| S-CONN-08 | After `[DONE]` the SDK closes the stream or cancels the remaining read (Python sync and async, Node) | An unread response |
| S-CONN-09 | The `[DONE]` chunk arrives 0.5 s late, after the generation-end marker, and the async SDK cancels the remaining read | An unread response |
| S-CONN-10 | The service `break`s from the SDK stream iterator | An unread response. A Node stream helper left with `break` from `for await` with events sent one by one: the SDK cancels the awaited read, `timeout` (data-model §Cut Streams view 3; K8) |
| S-CONN-11 | The service cancels the remaining read after the generation-end marker | An unread response |
| S-CONN-12 | A drop after the generation-end marker and before `[DONE]` | `transient` |
| S-CONN-13 | A drop after a Responses `error` event | A call failed by the `error` event; the drop is not a failure |
| S-CONN-14 | SSE whose body ended without an end event | `transient` |
| S-CONN-15 | SSE ending with an end event but no final empty line, also without a final line end | Both languages take the end event as received: normal |
| S-CONN-16 | SSE ending with a failure end event and no final empty line | A failed call |
| S-CONN-17 | SSE dropped in the middle of its last event; SSE whose last `data` is cut when the body ends | A mid-body drop, `transient` |
| S-CONN-18 | Cancelled by the service's time limit while waiting for the next chunk | `timeout` |
| S-CONN-19 | Other work closes the body and ends the awaited read (Python `aclose()`) | A cancel even when the transport raises `ReadError`: `timeout` |
| S-CONN-20 | Node `UND_ERR_HEADERS_TIMEOUT`; stream `UND_ERR_BODY_TIMEOUT`; non-stream `UND_ERR_BODY_TIMEOUT` and `UND_ERR_SOCKET` | `timeout`; `timeout`; `transient` |
| S-CONN-21 | Non-stream requests and the aiohttp backend | Both helpers split not-reached, before-headers and mid-body the same way |
| S-CONN-22 | A `with_streaming_response` response dropped mid-body | The SDK's retry count and the exception the service receives equal those without the helper |
| S-CONN-23 | The service reads only the headers or one chunk of a `with_streaming_response` response (Node `.asResponse()`) and returns | Not waited for; an unread response in both languages (an adapter error without raw) |

## Side Calls

Rules: [data-model §Outcome Decision](../data-model.md#outcome-decision), [data-model §Cut Streams](../data-model.md#cut-streams) view 5, [data-model §Matching Reported Failures](../data-model.md#matching-reported-failures); adapter reports per [helper-api §Trials Stopped by Another Call's Failure](helper-api.md#trials-stopped-by-another-calls-failure) and [helper-api §Trials Stopped by a Parallel Check's Refusal](helper-api.md#trials-stopped-by-a-parallel-checks-refusal).

| ID | Scenario | Expected |
|---|---|---|
| S-SIDE-01 | A side call fails, the service swallows it and returns a value | Result unchanged |
| S-SIDE-02 | A side call fails and the service raises | Outcome row 3 |
| S-SIDE-03 | A side call gets 401 | Outcome row 1 |
| S-SIDE-04 | Another model's input safety check before the answer ends in 429 after the SDK's retries; the service ships a fixed message without requesting the answer | Returning a value: Outcome row 3, `transient`. A raw-giving service with an empty raw: the failure check, `transient`. Also with a same-model check excluded by `reply_call` |
| S-SIDE-05 | The same check through uncaptured `/moderations` | The service raises and the target function throws `status=429` with `usage` 0: `transient`. Not thrown: Outcome row 2 adapter error |
| S-SIDE-06 | Another model's safety check and the answer stream sent together with `asyncio.TaskGroup`; the check ends in 429 after the SDK's retries and the answer task is cancelled | Throwing that failure with `status=429` and `model=`, whether the service raises or ships a fixed message: `transient`. Not thrown: a cancel landing on an awaited chunk read makes the cut answer request decide, `timeout`; landing while a chunk is processed gives Outcome row 3 `transient` when the service raises, and the data-model §Raw Cannot Be Determined adapter error when it ships a fixed message |
| S-SIDE-07 | The same with `except*` swallowing the exception and a fixed message; the target function throws the third argument's `error` and `model` | 429: `transient`; 400: `permanent`. Matched to that call even with `reply_call`, so no call counted twice; with a same-model check excluded by `reply_call`, added as a new call |
| S-SIDE-08 | A same-model check excluded by `reply_call` sent together; the check ends with a dropped connection and the answer stream is cancelled | Thrown with that call's `error`, it matches the cut answer request: `timeout` (K25) |
| S-SIDE-09 | After the answer was fully received, the safety check ends in 429 and the service ships a fixed message instead | Thrown: `transient`. Reported as a fallback instead: a fallback with W1 |
| S-SIDE-10 | A same-model input check excluded by `reply_call`, sent with the answer stream, answers "block"; the service cuts the stream and ships a message | `Result(raw="", kind="fallback", answers=0)`: a fallback. Not given: `timeout`, or for a cut without an awaited read the data-model §Raw Cannot Be Determined adapter error |
| S-SIDE-11 | The same with a non-stream answer request cancelled | The same |
| S-SIDE-12 | The same where the answer request ended in 429 after the SDK's retries before the check blocked | The same `Result` still gives the failure check's `transient` |
| S-SIDE-13 | The same where the check blocks while the answer request's SDK retry after a 429 is being received | The earlier attempt has a later request and is ignored: a fallback whatever the cut style |
| S-SIDE-14 | The same where the check blocks after a 429 and before the SDK resends | `transient` (K5) |
| S-SIDE-15 | The same where the answer request ends in 429 after the SDK's retries, the service sends a modified request to the same model, and the check blocks that one | The earlier 429 has a later searched call and is ignored: a fallback |
| S-SIDE-16 | A streaming tool loop whose last answer stream is cut because the check blocked | `Result(raw="", kind="fallback", answers=0)`: the earlier tool-call streams are left out, a fallback with `answers` 0 |
| S-SIDE-17 | A streaming tool loop hitting its limit, a message, with `answers=0` | A fallback |
| S-SIDE-18 | The same two trials with `answer_tool` on a streaming tool loop | `answers=0`: A8. Not given: an empty answer and `timeout` (K11) |
| S-SIDE-19 | Another model's language detection ends in 429 after the SDK's retries and is swallowed; then the answer stream and the input check are sent together and the check blocks | `Result(raw="", kind="fallback", answers=0)`: a fallback |
| S-SIDE-20 | The same with another model's memory retrieval sent alongside, ending in 429 | `transient` (K1) |
| S-SIDE-21 | Another model's input check sent with the answer stream blocks | A fallback; the guidance to remove the case is in helper-api §Trials Stopped by a Parallel Check's Refusal |
| S-SIDE-22 | The answer through an uncaptured transport, only a same-model check captured and excluded by `reply_call`; the check blocks, the answer request is cut, `Result(raw="", kind="fallback", answers=0, model=, finish_reason="other", usage=)` | A fallback; the answer request sent is added as that model's call |
| S-SIDE-23 | `answers=0` given on a trial cut late whose resend ended in 429 after the SDK's retries | `transient` |
| S-SIDE-24 | `answers=0` given on a trial only cut late | A fallback instead of a time-out |
| S-SIDE-25 | A same-model input check excluded by `reply_call`, and the answer stream fully received before the check blocked | That `Result`: A8. The received text with `kind="fallback"` and `finish_reason="other"`: a fallback graded on raw rules |
| S-SIDE-26 | The same with the answer stream cut for content and the resend blocked by the check | The pre-cut text with `kind="fallback"` and `finish_reason="other"`: a fallback, `answers` 1, graded on raw rules. An empty raw with `answers=0`: a fallback that loses that text |
| S-SIDE-27 | The same with a non-stream first answer failing validation, the regeneration stream cut for content, and the resend blocked | The first answer with `kind="fallback"`, `finish_reason="other"`, `answers=2`: a fallback, `answers` 2, raw is the first answer |
| S-SIDE-28 | The same with the answer stream cut for content, the resent stream fully received, then the check blocks | The pre-cut text with `kind="fallback"`, `finish_reason="other"`, `answers=2`: a fallback; raw is the pre-cut text |
| S-SIDE-29 | The same with a non-stream first answer failing validation and the regeneration stream fully received before the check blocks | The first answer with `kind="fallback"`, `finish_reason="other"`, `answers=2`: a fallback. Giving the regenerated answer as raw loses the first answer's violations |
| S-SIDE-30 | The same with the first answer fully received, the regeneration stream cut late, and the resend blocked | The first answer with `kind="fallback"`, `finish_reason="other"`, `answers=2`: a fallback, `answers` 2 |
| S-SIDE-31 | The answer through an uncaptured non-stream call, only a same-model input check captured and excluded by `reply_call`; the first answer fails validation and the check blocks the regeneration | The first answer as `Result(raw=, kind="fallback", model=, finish_reason="other", usage=)`: a fallback and that call added. Only wrapping the message: a fallback with an empty raw |
| S-SIDE-32 | A streamed first answer fully received; the regeneration stream and a side call sent together; the side call ends in 429 and the service cuts the regeneration and ships the first answer | First answer with `finish_reason=` and `answers=2`: normal, one more regeneration counted (K10). `answers=1`: the cut last answer (raw call cut), `timeout`. A non-stream first answer: `finish_reason=` and `answers=1` give normal |
| S-SIDE-33 | The same with a non-stream first answer and the regeneration stream cut by the check | First answer with `finish_reason="other"` and `answers=1`: a fallback. Without `answers`: Outcome row 5 |
| S-SIDE-34 | A service with a shared message; another model's safety check recovers by SDK retry after 429; the answer is fully received, fails validation, message shipped | The check's earlier attempt has `retried` true and is not thrown; by the finish reason, a fallback. Throwing that attempt's `error`: `transient` with W10 |
| S-SIDE-35 | The same service; another model's memory retrieval ends in 429 and is swallowed; the answer fails validation, message shipped | Memory retrieval did not stop the service, so it is not thrown: a fallback |
| S-SIDE-36 | The service stops waiting for another model's safety check before the answer with `Promise.race` and ships a message | Throwing `kind="timeout"` with that `model`: `timeout`, no call added. Not thrown: Outcome row 4 (A2). The same check cut with `asyncio.wait_for`: Outcome row 3, `timeout` |
| S-SIDE-37 | The safety check fails, then the service builds an apology with another model and ships it | Not Outcome row 3: thrown, that failure; not thrown, Outcome row 4 |
| S-SIDE-38 | The same, then the service raises after building the apology | The failure is not left out: Outcome row 3, `transient` |
| S-SIDE-39 | A check after the answer fails with 429, the service ships a message instead of the received answer, and the target function only wraps it | A fallback with W1 |
| S-SIDE-40 | A memory write ends in 429 after the SDK's retries, the service swallows it and answers | Unchanged, no warning |

## Exceptions Before the Model Call

Rules: [data-model §Outcome Decision](../data-model.md#outcome-decision) rows 2 and 4.

| ID | Scenario | Expected |
|---|---|---|
| S-EXC-01 | Fake storage rejects a query during assembly | Outcome row 2 adapter error with that exception's message and the guidance of helper-api §Not Captured; no `calls` |
| S-EXC-02 | The same rejection after another model's call before the answer succeeded | Outcome row 4 (A2) with the exception in the message |

## `ModelCallError`

Rules: [helper-api §`ModelCallError`](helper-api.md#modelcallerror), [data-model §Matching Reported Failures](../data-model.md#matching-reported-failures).

| ID | Scenario | Expected |
|---|---|---|
| S-MCE-01 | 429 with `retry_after_ms` | `transient` |
| S-MCE-02 | 401 | `config` |
| S-MCE-03 | 429 with `code` `insufficient_quota` | `config` |
| S-MCE-04 | `kind` `timeout`; `connect`; `tls` | `timeout`, call reservation; `transient`, added as `failed` without billing when calls were captured; `config` |
| S-MCE-05 | No captured call: `usage` 0; no `usage` | Cost 0; the attempt reservation |
| S-MCE-06 | Thrown together with a captured side call's `config` failure | `config` |
| S-MCE-07 | Two or more of `status`, `kind`, `call`, or none | A12, even with `ValueError` in `discard_on` |
| S-MCE-08 | `call` with a captured failure the service swallowed | That call's classification; no call counted twice |
| S-MCE-09 | `call` with a successful call, a 429 the SDK recovered from, a side call excluded by `reply_call`, or a 503 whose SDK resend was still awaited when the service ended | A13 in every case |
| S-MCE-10 | A stream starts with 200 and ends with an `error` event (`overloaded_error`); the service raises and the target function throws `status` 200 with `type` | That stream call already failed as `transient`, so the matching-failure candidate matches: `transient`. Ending in the exception without throwing: Outcome row 3, `transient` |
| S-MCE-11 | A background Responses response later ends `failed` (`server_error`) and the target function throws | The first request's call is corrected: `transient` |
| S-MCE-12 | A captured 429 raised by the service and converted and thrown | No call counted twice |
| S-MCE-13 | A captured mid-body read time-out raised by the SDK as `APITimeoutError`, thrown as `kind` `timeout` | The captured classification: `transient` |
| S-MCE-14 | A failed 200 response over an uncaptured transport; its `code` `insufficient_quota` | `unanswered`, call reservation; `config` |
| S-MCE-15 | Anthropic `timeout_error` in a stream `error` event | `transient` |
| S-MCE-16 | A same-model safety check sent at the same time fails with 400 first, the answer stream ends in `overloaded_error`, and the target function throws `status` 200 | Matched to the stream call: `transient` |
| S-MCE-17 | A captured 429 followed by a thrown 400 from an uncaptured transport | Added as a new call: `permanent` |
| S-MCE-18 | A captured connection refusal raised by the SDK and thrown as `kind` `connect` | No call counted twice |
| S-MCE-19 | A same-model classification by SSE first, the answer without streaming, a mid-body read time-out thrown as `kind` `timeout` | The classification stream is not corrected; the answer call's captured classification: `transient` |
| S-MCE-20 | The answer through an uncaptured transport; a same-model side call recovered by SDK retry after a drop; the target function throws `kind` `timeout` | Not matched to the recovered failure: `timeout` |
| S-MCE-21 | A 429 the SDK closed before resending, then a thrown `insufficient_quota` 429 | `config` |
| S-MCE-22 | A fully received same-model classification stream, then `kind` `timeout` for the uncaptured answer call | The classification stream is not corrected; a new call is added |
| S-MCE-23 | The answer through an uncaptured transport; a same-model memory summary excluded by `reply_call` dropped mid-body and swallowed; the target function throws `kind` `timeout` | Not matched to the memory summary; a new call, `timeout` |
| S-MCE-24 | After a fully received answer, a same-model validation stream excluded by `reply_call` ends in an `error` event with `type` `overloaded_error` and an unlisted `details.error_code`; the service ships a message; the target function throws that call's `error` | Added as a new call: `transient` by type |
| S-MCE-25 | The answer through an uncaptured transport; the earlier attempt of a same-model side call excluded by `reply_call` recovered by SDK retry after 429; the target function throws the answer's 429 as `status` | A new call, `transient`; no call is true for `reply_call`, so no W10 |

## Cost

Rules: [data-model §Derived Result Fields](../data-model.md#derived-result-fields), [data-model §Raw Call](../data-model.md#raw-call), [helper-api §Cancel](helper-api.md#cancel).

| ID | Scenario | Expected |
|---|---|---|
| S-COST-01 | A call outside the captured transports with `Result(raw=, finish_reason=, usage=, model=)` | No `calls`; priced from `usage` |
| S-COST-02 | The same without `usage` | The reservation |
| S-COST-03 | A stream response with `Result(raw=, finish_reason=, usage=)` | The raw call's `usage` |
| S-COST-04 | The answer outside the captured transports, only side calls captured | `Result(usage=)` is added to `calls` as the uncaptured call; without it, that call is charged its reservation. The same when the side calls use the variant model (one or two branches), and the side calls' `usage` stays. A side call that answers in text gives W4; excluded by `reply_call`, no warning |
| S-COST-05 | A captured answer refined and given as `Result(raw=, finish_reason=)` | Added as an uncaptured call with W4 |
| S-COST-06 | A Responses background response (first request `queued`) with `Result(raw=, finish_reason=, usage=)` | The first request's `usage`; not counted twice |
| S-COST-07 | A streaming service with an empty raw and a variant side call that ended only in tool calls | The side call is not chosen as the raw call; its `usage` stays |
| S-COST-08 | A streaming tool loop of three calls with `Result(raw=, finish_reason=)` | `fingerprint` from the first request, equal to the render fingerprint; all three `branch: answer`; the first two at their reservation |
| S-COST-09 | A request the SDK resends after waiting, after the tool's `cancel` | Not sent and not recorded; in Python sync and async functions and Node, the late response does not contain it |

## Contexts

Rules: [data-model §Outside the Trial Context](../data-model.md#outside-the-trial-context), [data-model §After the Function Returned](../data-model.md#after-the-function-returned), [data-model §Unfinished Calls Count as Time-Outs](../data-model.md#unfinished-calls-count-as-time-outs); adapter reports per [helper-api §Services That Stopped Waiting](helper-api.md#services-that-stopped-waiting).

| ID | Scenario | Expected |
|---|---|---|
| S-CTX-01 | A request from a thread that does not carry the context | Concurrency 1: that trial's call. 2 or more: every trial in progress ends as A10 |
| S-CTX-02 | At concurrency 1, a background thread request of the previous trial joins the next trial | When it follows a failure before the next trial's answer, Outcome row 3 leaves that failure out, so Outcome row 4 (K26) |
| S-CTX-03 | A thread started with `contextvars.copy_context().run` | That trial's call |
| S-CTX-04 | A memory write that ends after the service function returned | Waited for and included |
| S-CTX-05 | An SSE body nobody reads at function end | Not waited for; an unread response |
| S-CTX-06 | A body background work is reading | Waited for |
| S-CTX-07 | A background request with no response by the time limit | `unanswered`, no error kind, result unchanged |
| S-CTX-08 | A request first sent while waiting after the function returned | Not in the trial; a `calls` notification after the result |
| S-CTX-09 | A request from a thread without the context, sent while waiting | Concurrency 1: a `calls` notification of that trial |
| S-CTX-10 | The service stops waiting with its own time limit (`Promise.race`) without cutting the request and returns a fixed message | `timeout` whether the answer request then succeeds, fails with 503 or is cut by the helper, and whether wrapped with `fallback` or not; the same as cancelling |
| S-CTX-11 | The same, ending while the SDK's resend after a 503 is awaited | `timeout` |
| S-CTX-12 | The same, the target function throwing `kind` `timeout` | No call added |
| S-CTX-13 | The same, the first attempt dropped and the SDK's resend ending before the function returned; the target function throws `kind` `timeout` | A new call, `timeout`; no W10 |
| S-CTX-14 | The same with a streaming answer request that got its generation-end marker before the function returned | A value without raw: the data-model §Raw Cannot Be Determined adapter error. Throwing `kind` `timeout`: `timeout` with one more call |
| S-CTX-15 | The same time limit through `fut.result(timeout=)` in Python `with ThreadPoolExecutor()` (at concurrency 1 without context), the late response awaited when the block exits | The late answer becomes the first answer and passes as complete, a fallback when wrapped (K17). Throwing `kind` `timeout`: `timeout` with one more call |
| S-CTX-16 | The same, resending the same request and shipping its answer | `Result(raw=<re-received answer>, answers=1)`: normal, `answers` 1. Without it the late response counts too, `answers` 2 (K17). A modified resend with `reply_call` true for both: the same, with `render-mismatch` |
| S-CTX-17 | The same, the resend ends in 429 after the SDK's retries and a fixed message is shipped | Throwing `status=429`: `transient`. When that 429 overlaps the late response it is recovered, so one more call is added; giving it as `call=` is A13 |
| S-CTX-18 | A service that only stops waiting uses the same fixed message for swallowed call failures, has no other marker, and only wraps the fixed message with `fallback` | A swallowed 429: `transient`. A late response after the function: `timeout`; before it: a fallback (K19) |
| S-CTX-19 | The same time limit raised by the service as an exception | Outcome row 9, whether the SDK's resend after a 503 or the first request without a 503 was awaited. Converted to `kind` `timeout`: `timeout` |
| S-CTX-20 | The time limit fires while the SDK waits before resending after a 503 | No resend exists, so the 503 stays an unrecovered failure: without throwing, a fixed message is Outcome row 6 and an exception Outcome row 3, `transient` (K5). Throwing `kind` `timeout`: no candidate, `timeout` with one more call. When the earlier failure was a drop before headers or a non-stream read time-out, the thrown value matches it: `transient` (K6) |
| S-CTX-21 | The function ends with a fake-storage exception raised while a model call ran, the answer request left running | Outcome row 9 |
| S-CTX-22 | A request sent after the result | A `calls` notification |
| S-CTX-23 | Background requests left at `shutdown` | Waited for and reported before the response |
| S-CTX-24 | An exception in background work | Log warning L2 |

## Render and Version

Rules: [helper-api §Render Mode](helper-api.md#render-mode), [data-model §Service Version](../data-model.md#service-version).

| ID | Scenario | Expected |
|---|---|---|
| S-RV-01 | A render where `case.rendering` replaces the classification call before the answer with a fake | Render result of the answer request |
| S-RV-02 | `@adapter.render` returning part lists | After normalisation the fingerprint equals the captured request's |
| S-RV-03 | A case on a path that calls no model | Render fails (A11) |
| S-RV-04 | `treeHash` after editing a rule file inside `toolPaths`, also when committed; after committing or staging without changing service code | Unchanged |
| S-RV-05 | `treeHash` after editing a tracked binary fixture, adding a file outside the ignore list, or editing a file in a submodule or an untracked nested repository | Changed |
| S-RV-06 | An uninitialised submodule, or `service_dir` being one | The computation ends |
| S-RV-07 | A tracked file replaced by a folder, or a link by a file, without committing; a merge conflict in progress | No failure |
| S-RV-08 | Python and TypeScript helpers on the same repository | The same values |
| S-RV-09 | A working folder entered through a symbolic link, a config path written with different case (macOS) | Rule and config files are still left out |
| S-RV-10 | Not a git work tree; `service_dir` in the ignore list; `service_dir` at the place of an uninitialised submodule | None of the three values |
| S-RV-11 | `GIT_DIR` set in the environment (git hooks) | The same values |
| S-RV-12 | `status.showUntrackedFiles=no` | Untracked files still count for `dirty` |
| S-RV-13 | File names with U+1F600, U+FF01, or non-UTF-8 bytes (Linux) | The same values in both helpers |
| S-RV-14 | The output folder in `toolPaths` not created yet (first run) | All three values reported |
| S-RV-15 | A file deleted while computing: a listed path missing at `lstat` | Left out, no failure |
| S-RV-16 | `service_dir` a subfolder of a monorepo | Changes in other folders do not affect `dirty` |
| S-RV-17 | A case file that is a link to a file in the service folder | Its target is left out too |
