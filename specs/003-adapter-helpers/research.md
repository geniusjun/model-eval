# Research: Adapter Helpers

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

External facts are as of 2026-11-09.

## R1. What the helpers provide

**Decision**: Python and TypeScript adapter helpers ([contracts/helper-api.md](contracts/helper-api.md)) and an `init --adapter` skeleton that uses them (plan D1).

**Rationale**:

- Four hard parts of writing an adapter are the same for every service: capturing the raw answer at the model call, telling a discarded answer from an adapter defect, getting the prompt without a separate assembly function, and classifying provider errors. Watching the HTTP requests the service already makes solves all four without changing service code.
- Most LLM services are written in Python or TypeScript. Other languages are served by the protocol example, since the protocol is line-based JSON ([001 adapter-protocol §Minimal Adapter](../001-swap-check/contracts/adapter-protocol.md#minimal-adapter-python-without-the-helper)).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| An HTTP adapter configured without code | The service would have to expose the raw answer and the discard decision in its response, and per-case state is hard to control (001 research R2). A later feature |
| A mode where the tool calls the model itself | It skips the service's assembly and post-processing (constitution I) |

## R2. Capture at the HTTP client layer

**Decision**: Capture model calls at the HTTP client layer (Python `httpx` and `httpx2`, Node global `fetch`), not by wrapping SDK classes or methods (plan D2).

**Rationale**:

- Wrapping SDK methods means finding and patching the same copy of the SDK module the service uses. In Node, dual ESM and CJS builds and separate `node_modules` copies make that easy to miss.
- At the HTTP layer the helper sees only the public API's request and response JSON, which changes less than SDK internals. Both SDKs and both languages are handled the same way.
- Classifying errors by HTTP status and error codes instead of SDK exception class names avoids a separate table per language and SDK (R9).
- Transports do change (R3). At the HTTP layer the helper follows by wrapping one more class; wrapped SDK methods would have to follow the changed SDK internals. Contract tests for every supported SDK major version catch such changes early (plan Risks).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Wrap SDK methods, as Inspect AI's `agent_bridge()` does | Tied to module copies and SDK internals, and needs an exception table per language and SDK |

## R3. Which transports to wrap, and when

**Decision**: In Python, wrap `Client.send` and `AsyncClient.send` of both `httpx2` and `httpx` at class level, without importing either module; in Node, wrap `globalThis.fetch` before the service creates its SDK clients ([helper-api §Captured Requests](contracts/helper-api.md#captured-requests)).

**Rationale**:

- The two official SDKs' default transports: the Python SDKs use `httpx2`, a fork of httpx, from OpenAI 3.0.0 (2026-08) and Anthropic 1.0.0 (2026-08) on; earlier major versions use httpx. The classes of the two modules differ, so wrapping one captures none of the other's requests. Requests sent with httpx directly, without an SDK, use `httpx` too.
- The Node SDKs use the global `fetch` from OpenAI 5.0.0 and Anthropic 0.50.1 on, and keep a reference to it when a client is created and never look up the global again. So Python wraps both modules, and Node wraps before the service creates a client.
- Sources: [openai-python](https://github.com/openai/openai-python) `httpx2.md`, [anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python) `MIGRATION.md`, [openai-node](https://github.com/openai/openai-node) and [anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) `src/client.ts`.
- The SDKs look up the class's `send` on every request, so wrapping modules already loaded at helper import, and the others through an import hook right after they load, is enough even for services that import the SDK late inside a function.
- The helper does not import `httpx` itself: with `httpx` loaded first, a service that calls `httpx2.alias_httpx()` stops with an error.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Wrap only `httpx` in Python | No request of the OpenAI 3.x and Anthropic 1.x SDKs and later would be captured |
| Import `httpx` and `httpx2` in the helper to wrap them | Breaks services that call `httpx2.alias_httpx()` |

## R4. Read response bodies only as the SDK reads them

**Decision**: The helper never reads a body ahead of the SDK. Python wraps the response byte stream and copies what the SDK reads; Node hands the SDK a pass-through stream that reads the original only on demand. Stream content is not parsed; only end events and generation-end markers are read ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies), [helper-api §End Events](contracts/helper-api.md#end-events)).

**Rationale**:

- The official SDKs close the body or cancel the remaining read even when ending a normal stream: the OpenAI Python SDK closes at `[DONE]`; its async client reads the rest briefly and then cancels the awaited read; openai-node 7 cancels at `[DONE]` (5 and 6 read to the end of the body). A service may also cancel the remaining read once it has the whole answer text (`abort()` after `content.done` in the openai-node stream helper). Counting that as a failure would turn normal answers into `timeout` behind proxies that deliver the final chunk a little late, and split the two languages.
- The SDK raises drops and time-outs after a generation-end marker but before the end event to the service, so the outcome must follow that failure.
- Failure end events are classified because a service that swallows a mid-stream provider error (overload and similar) and ships what it received would otherwise pass as complete while the helper does not know about the failure, or the result would differ by API.
- Only an awaited read counts when deciding whether a close or cancel was a failure, because some SDKs read once more after `abort()` (openai-node 5 and 6, `@anthropic-ai/sdk` 0 and 1; openai-node 7 does not). Counting that read, however it ends, would split the same service logic into normal, time-out or a dropped connection by SDK version and chunk timing; what the SDK reads after the close is not something the service sees.
- Reading end markers, whether a marker reports a tool call, and a failure end event's error type and code is not interpreting answer content. Parsing stream content is a later feature.
- Compressed bodies are decoded because without decoding, text, usage and end events of compressed responses cannot be read and the two languages would disagree.
- The copy and the markers are updated before a chunk is handed to the SDK because updating after would miss that chunk's marker when the service leaves its read loop on that chunk.
- A remaining event or a cut `data` of a body that ended with a read error is not received: counting it would hide responses cut in the middle of their last event, because read failures after an end event are not failures.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Read the body ahead of the SDK | Moves a mid-body failure into `send`, changes the SDK's retries and the exception the service receives, and makes the service behave differently only under evaluation |
| Read a separate copy with Node `clone()` | Reads the copy to the end even when the service stops reading, so it would be taken as an answer and the two helpers would disagree on the same service |

## R5. Pick the raw answer by rule, and let the adapter choose instead of guessing

**Decision**: The raw answer is the first answer of the answer candidate calls (001 research R8). The variant model is identified by the request's model name, exactly or with only a date suffix. When the variant model calls form several branches, the helper does not guess; the adapter sets `reply_call`, and services that answer through a tool call set `answer_tool` (plan D4).

**Rationale**:

- A turn function can call the same model after the answer (memory writes, answer validation; 001 research R2) and before it (classification). Picking "the last call to the variant model" as the raw answer grades the wrong text without any error.
- When answers come from several branches, those branches' systems must be equal. A `reply_call` that is also true for the classification call would otherwise pick the classification output as the first answer; with a different system, the mistake shows as an error.
- Matching model names by prefix would treat a different model with the same prefix (`gpt-5` and `gpt-5-mini`) as the variant model and hide an adapter that does not pass the variant model.
- Comparing the render fingerprint with the real answer request's fingerprint (`render-mismatch`) also reveals a wrong render target during a run.
- The raw call is found by text when the adapter gives the raw answer, not guessed from the answer candidates: a service that receives the answer through an uncaptured transport and makes only same-model side calls through the SDK would make a side call the candidate, losing the answer's cost or overwriting the side call's tokens.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Always take the last successful call to the variant model as raw | Grades the output of side calls after the answer |
| Match the variant model by name prefix | Hides adapters that do not pass the variant model |

## R6. Discards only when the adapter declares them

**Decision**: A service exception counts as a discard only when it matches the target's `discard_on`; every other exception is an adapter error (data-model Outcome row 9).

**Rationale**: Counting an exception of unknown cause as a discard hides adapter defects, such as fake storage rejecting an unexpected query, in discard-rate changes. How such changes pass unnoticed or block falsely: [001 research R8](../001-swap-check/research.md#r8-trial-outcomes-and-the-default-gated-surface).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Count every exception after the service function ended as a discard | Adapter defects such as fake storage rejections hide in the discard rate, and paths that differ per variant cause false blocks |

## R7. Render by running the service in render mode

**Decision**: Render runs the same service function in render mode, captures the answer request and sends no captured model request to the network ([helper-api §Render Mode](contracts/helper-api.md#render-mode)).

**Rationale**:

- A service whose assembly code lives inside the turn function has no other way to get the assembly result alone (001 research R2). Without a render, anchor checks (001 User Story 2), render fingerprints (constitution VI) and input token estimates are impossible.
- The error returned to blocked requests is not retried, so render is not slowed by SDK retries.
- Normalising adapter-supplied render results the same way as captured requests keeps fingerprints comparable.
- The stored-prompt reference (`role: prompt`) is kept in the messages so that changing the stored prompt's version or variables changes the fingerprint, even though the body is not in the request.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Fingerprint adapter-supplied render results as given | Part lists or a separate system would always differ from the captured answer request's fingerprint and raise `render-mismatch` on every trial |
| Block only requests to the variant model | Other captured requests would cost money during render |

## R8. Protect stdout at import time

**Decision**: On import, the Python helper swaps file descriptor 1 to stderr and keeps a duplicate for the protocol; the Node helper redirects `process.stdout.write` and `console` and leaves the rest to the tool's contamination detection ([helper-api §stdout Protection](contracts/helper-api.md#stdout-protection)).

**Rationale**: A stray `print` on stdout is the most common adapter bug ([001 adapter-protocol §Transport](../001-swap-check/contracts/adapter-protocol.md#transport)). Python can swap descriptors, which also covers C extensions and child processes. Output printed while the service is imported is caught only when the helper is imported first.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Swap descriptor 1 in Node as in Python | Node has no API for that, so output written directly to descriptor 1 by native modules or child processes is left to the tool, which shows the offending line |

## R9. Classify errors by status and code at the HTTP layer

**Decision**: Classify by HTTP status, the error object's type, code and message, and the transport cause found along the exception chain ([helper-api §Error Classification](contracts/helper-api.md#error-classification)).

**Rationale**:

- SDK exception classes lose distinctions the HTTP layer sees. The OpenAI Python SDK raises the same `APITimeoutError` for a time-out before response headers (`timeout`) and a read time-out mid-body (`transient`). Transport backends convert or hide exceptions: the SDK's aiohttp backend raises `ConnectTimeout` for a connection closed without a response (`ServerDisconnectedError`), httpcore hides the certificate cause behind `ConnectError`, and undici raises `UND_ERR_SOCKET` both before headers and mid-body. So the helpers look at header arrival and the original exception.
- Time-outs are kept apart from `transient` because the service's time limit is production behaviour: without an answer within it, the user gets no answer in production either. The tool never retries `timeout` and counts it as a completion failure (001 data-model §Trial Outcomes). A stream sends headers first and the body as the model generates, so a time-out between events means a slow model: `timeout`. A non-stream response sends its body after the model finished, so a read time-out mid-body is a connection problem: `transient`.
- Connect and connection-pool time-outs never reached the model, so they are `transient`, not `timeout`.
- A TLS certificate failure never reached the model, but retrying does not help and it is an environment problem unrelated to the model, so it is `config` and stops at the first failure, like an authentication failure, asking to check the setup. As `transient`, every trial would be retried and the run would stop late on the transient rate with a blurred cause.
- A request URL without an `http` or `https` scheme (a `base_url` missing `http://`) is the most common setup mistake, and the helper checks the scheme before sending. As `transient`, every trial would be retried and the run would stop late with the cause blurred, so it is `config` for the same reason as a certificate failure; the request never left, so it is not billed.
- 408 is the server-side view of a request that was not fully sent, so when it remains after the SDK's retries it is `transient`, like a connection failure. 409 is not one of the transient failures of [001 data-model §Transient Failures](../001-swap-check/data-model.md#transient-failures) (429, 5xx, connection failures), so it is `permanent` after the SDK's retries, unless a cause code means a configuration problem (`config`).
- `ModelCallError` keeps `code` apart from `type` because one error object can hold both (the Anthropic SDK says to treat unknown cause codes by their type), and the error table decides by type even for codes it does not list.
- Anthropic `timeout_error` is a provider-side error that arrives over HTTP as 504, so it counts as 5xx also when it arrives as a stream `error` event.
- Python follows `__cause__` but not `__context__`, because `__context__` can hold an unrelated exception being handled; a connection refusal or a drop before headers raised inside an `except` block that handles another HTTPS call's certificate error would otherwise become a certificate failure.
- Node carries the full X509 error code table of the `tls` documentation. Listing only a few codes would let self-signed certificates, and proxies that do not send their root certificate, fall to `transient` and disagree with the Python helper in the same environment.
- Providers change the shapes of quota and billing errors. Unknown shapes make a 400 `permanent` (the candidate looks worse) and a 429 `transient` (every trial resent, the run may stop on the transient rate with exit code 3). The result page shows typical messages per error kind and variant, and the gate reason puts first the message most failures of a blocked cell share ([001 data-model §Comparison](../001-swap-check/data-model.md#comparison) `ops`, 001 data-model §Gate `dominant-error`), and new shapes are added to the table (plan Risks).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Classify by SDK exception class | Loses the timeout and transient split, and needs a table per language and SDK |
| Treat certificate failures as `transient` | Every trial is retried, the run stops late, and the cause is unclear |

## R10. When a call ended, and why stopping to wait is a time-out

**Decision**: A call ends when it failed, when its body was fully received, or, for unread responses, when the service read the last chunk; an SSE response ends when the chunk with its generation-end marker was read. A call still running when the service function returned is an unfinished call and counts as `timeout` in the answer branch ([data-model §When a Call Ended](data-model.md#when-a-call-ended), [data-model §Unfinished Calls Count as Time-Outs](data-model.md#unfinished-calls-count-as-time-outs)).

**Rationale**:

- A service that received the whole answer and re-draws at once with the same request still has the SDK read the remaining usage and end event afterwards (openai-node stream helper `content.done`). Ending SSE at the generation-end marker keeps the first stream from overlapping that re-draw; otherwise cutting the re-draw would become a recovered failure.
- That choice has the cost K27 of [data-model §Known Limits](data-model.md#known-limits).
- A service that stops waiting without cutting the request (Node `Promise.race`) must get the same result as one that cancels it, so that how a late response ended never turns the trial into a retried transient failure or a completed answer. The same reason applies when the SDK was resending a failed request. The helper cannot see when the service stopped waiting, so in the remaining cases the target function reports it ([helper-api §Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting)).
- The result is decided from what the service had received when it returned; the helper still waits for unfinished calls to learn their cost and `config` failures.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| End unread responses when the body is closed | Close time differs by SDK: openai-node cancels the body as soon as the read loop `break`s, while openai-python keeps it open until the service closes it or the stream object goes away. The same service logic would decide differently per language and per position of the closing code, and a trial that cut a late stream, resent it and hit a rate limit would split into transient, time-out and adapter error |

## R11. Identify service code by content, not by commit

**Decision**: `treeHash` hashes the current bytes of the tracked and untracked, non-ignored files of `service_dir`, excluding the tool's files, with kinds taken from the work tree and nested repositories hashed recursively ([data-model §Service Version](data-model.md#service-version)).

**Rationale**:

- A content hash looks only at the current files, regardless of commits and staging, so the same service code gives the same value. Binary files (fake storage in SQLite) are included by content.
- The options of the `dirty` command are fixed:

  | Option | Why |
  |---|---|
  | `--untracked-files=all`, `--ignore-submodules=none` | User settings (`status.showUntrackedFiles`, `diff.ignoreSubmodules`) cannot hide untracked files or submodule changes |
  | `-- .` | Only `service_dir`, not the whole repository (monorepos) |
  | `-z` | Names are not quoted |
  | `--no-optional-locks` | No index lock conflict while the user runs git in the same repository |

- File identity by device and inode, from both `lstat` and `stat`, treats links, symlinked working folders (macOS `/tmp`) and case-only path differences (macOS default file system) as the same file, so both helpers agree. Node reads inode numbers as `bigint`, because they can exceed what a JavaScript number represents exactly. Both `lstat` and `stat` are compared because when a `toolPaths` entry is a link (a case file pointing into the service folder), both the link and its target are evaluation files.
- `toolPaths` entries that do not exist now are skipped: a missing file is no file of the service folder, and treating it as a failure would drop all three values on every first run.
- Folders that are not a repository top are not entered, because inside an uninitialised submodule (an empty folder) git climbs to the parent and lists that folder itself as `./` again, and the computation would never end.
- Paths are handled as raw bytes and sorted by bytes, because Linux names need not be UTF-8, decoding would let the two helpers repair them differently, and JavaScript's default sort uses UTF-16 units and orders names with characters outside the BMP differently.
- git runs with the variables of `git rev-parse --local-env-vars` removed, because an adapter started where those are set (a git hook) would otherwise resolve every folder to that repository and break nested-repository detection and the path lists.
- When any part fails, nothing is reported: a partially counted value could differ for the same service code. When `service_dir` is ignored or is the place of an uninitialised submodule, git shows no files there, so `treeHash` would always be the empty-list value whatever the service code is.
- Equal `treeHash` for the same service code on another machine is not guaranteed: the ignore list includes the user's global `core.excludesFile`, and work-tree bytes can differ through line-ending conversion (`core.autocrlf`) (spec Assumptions).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Identify the service by commit SHA | It changes with every commit. With evaluation files inside the service repository, fixing a rule typo and committing it between segments of an interrupted run would block the resume |
| Take kinds from git modes | Replacing a file by a folder, or a link by a file, without committing makes the mode disagree with the file and reads fail |

## R12. Distribute the Python helper as one copied file

**Decision**: The Python helper is one standard-library-only file that `init --adapter python` copies next to the adapter (001 FR-033); the TypeScript helper ships as the `model-eval/adapter` subpath of the tool package (plan D7).

**Rationale**: Installing a package would mean editing the service's dependency list or setting up a separate virtual environment, while the goal is to connect without changing the service repository. Version drift is reported by lint (`helper-outdated`). The TypeScript helper comes with the tool installed as a development dependency in the adapter folder.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Publish the Python helper on PyPI | It must be installed into the service's virtual environment; a one-file copy is enough |

## R13. Make both helpers produce the same bytes

**Decision**: Wherever the two helpers must agree (the values of spec FR-024), each rule is spelled out instead of relying on the language's standard functions (plan D8).

**Rationale**:

| Point | Standard behaviour that differs | Rule |
|---|---|---|
| Whitespace trimming | `strip()` and `trim()` remove different characters (U+FEFF, U+0085, U+001C–U+001F), and the Python standard library cannot query the `White_Space` property | The 25 `White_Space` code points, written out in [001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes) ([data-model §Comparing Text](data-model.md#comparing-text)) |
| JSON writing and reading | Python `json` sorts by code point, writes `1.0`, `1e-07`, `-0.0` and large integers differently, and accepts `NaN`; `JSON.parse` rejects `NaN` and reads `1e400` as infinity | [001 data-model §Canonical JSON](../001-swap-check/data-model.md#canonical-json) |
| `retry-after` | Rounding functions disagree on ties (2.5), decimal arithmetic on 0.5005 s; asctime dates are read as local time; the Node SDK reads only the leading number (`30s` is 30 s) | [helper-api §`retryAfterMs`](contracts/helper-api.md#retryafterms) |
| Compressed bodies | Node's `fetch` decodes; the Python byte stream does not, and the standard library cannot decode br, or zstd on Python 3.13 and earlier | Decode with a separate decoder of the same kind ([helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies)) |
| SSE without a final empty line | SDKs drop or keep the last event, so following the SDK would give the same response from a compatible server an end event in one language and not the other | Accept a last event whose `data` is complete when the body ended without a read error |
| Path order in `treeHash` | JavaScript sorts by UTF-16 units | Sort by bytes (`Buffer.compare`) |
| Discard reason length | JavaScript string length counts UTF-16 units | The first 200 code points (data-model Outcome row 8) |

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Rely on each language's standard functions | They differ at every point in the table above |

## R14. Outcome decision trade-offs

**Decision**: The trial outcome follows the fixed rules of [data-model §Outcome Decision](data-model.md#outcome-decision) and [data-model §When the Adapter Gives Raw](data-model.md#when-the-adapter-gives-raw); what the helper cannot see is declared by the adapter (plan D4), and the cases the rules still decide differently from the service are accepted as [data-model §Known Limits](data-model.md#known-limits).

**Rationale**: Two aims run through the rules. Failures caused by evaluation load must not become completion failures or adapter errors that pile up and stop the run, and a case the helper cannot see must not pass as complete. The reasons per rule:

- Calls and branches:
  - Call outcome `unanswered` for failures after the request was sent without `usage`: once a response has started, the model may already have generated tokens.
  - Error-status responses as failed calls even with an unread body: counting a 429 that the SDK closed before resending as an unread response would turn evaluation-load rate limits into adapter errors or completion failures.
  - Resend comparison without `stream` and `stream_options`: besides the protocol's reason, some SDKs add `"stream": false` to non-stream requests (openai-python `.parse()`, the openai-node tool runner).
  - Reasoning items as copied output: a reasoning model's tool loop must send them back.
  - A new branch after a text answer: joining a same-model side call to the answer's branch would make its output an answer with no error or warning.
  - No answers after an `answer_tool` answer: the answer was already received.
- Outcome rows:
  - Outcome row 1: authentication, permission, quota and certificate problems mean the environment differs from production wherever they occur, and every trial meets them. Letting a side call's failure pass would compare the service with that feature skipped.
  - Outcome row 2: an exception before the model call is the likely cause, but the service may also have called the model through a transport the helper cannot capture.
  - Outcome row 3: taking the unhandled call failure as the cause keeps side-call rate limits from piling up as adapter errors and stopping the run, and shows no misleading cause such as "no request went to the variant model". Case (b) has the same reason: a side call before the answer (another model's input safety check) that failed, after which the service shipped a fixed message without requesting the answer, is that failure, not Outcome row 4 or 5.
  - Outcome row 3, failures followed by a later captured call: the service moved past them to the next call. So a trial that swallowed another model's language-detection failure and then got a refusal from a same-model classification counts as a fallback (Outcome row 5 exception) instead of being retried as that failure.
  - Outcome row 3 with another exception: the row takes the unhandled failure as the exception's cause, and leaving failures out there would let a trial that hit a 429 in the check before the answer, built an apology with another model and then ended in an exception pile up as Outcome row 4 adapter errors. An adapter that does not pass the variant model to the service still shows up as Outcome row 4 in trials without a failure.
  - Outcome row 4: when the adapter does not pass the variant model to the service, both variants run the same model and pass with "no difference"; these trials pile up as adapter errors and stop the run. A `reply_call` that selects only calls to another model (Outcome row 5) is an error for the same reason. The exception is named because it may be the cause, for example fake storage rejecting a query during assembly after another model's call before the answer.
  - Outcome row 5 exception: the fallback after a same-model classification's refusal comes from the candidate's behaviour. Excluding it as an adapter error would drop a regression in refusals from the denominator and stop the run when such trials pile up. Variant model calls exist, so the adapter did pass the variant model, and Outcome row 4 does not apply. Services that give raw follow the same rule (the uncaptured-call exception).
  - Outcome row 6: there was no model answer, so a fixed message does not undo the call failure. An SSE response that received a generation-end marker counts as an answer for the reason of data-model §Raw Cannot Be Determined row 2: a trial whose re-draw failed and that shipped the earlier answer becomes that row's adapter error asking for the raw answer, not a retried transient failure. A service that used another model's parallel answer after the candidate lost cannot use the candidate's answer in production either (the time-out reasoning of [001 data-model §Trial Outcomes](../001-swap-check/data-model.md#trial-outcomes)).
- Warnings W1 and W2:
  - W1: same-model regenerating services produce the same sentence on both variants, so the sentences group together (`adapter-warnings`). A fallback or discard after a regeneration that evaluation load rejected shows neither in the transient rate nor in the dominant error message, so its cause would be invisible. Adapters that only wrap or discard trials stopped by another call's failure, instead of throwing it, produce the same shape.
  - W1, split by "a call sent after the failure" as in Outcome row 3: that catches the common trial where a check sent with the answer failed before the first answer arrived, and leaves out failures the service moved past: a failure swallowed before the answer, an earlier attempt the SDK resent, an answer regenerated by another model. The cost is K28 of [data-model §Known Limits](data-model.md#known-limits).
  - W2, text and system: text alone misses another model's answer that went through post-processing, and system alone misses a fallback sent to another model with a changed prompt. Send order: with the same request sent to two models at once, the other model's answer may arrive first, and a memory summary built by another model after the answer differs in text and system and must not warn.
- Raw that cannot be determined:
  - Raw Cannot Be Determined row 1 with `fallback` or a discard: the service did not use that response, and an adapter error would drop a regression that calls tools without end from the denominator.
  - Raw Cannot Be Determined row 2: streams are not parsed, and an unread body has no seen end. For a stream the service cut, the helper cannot know whether the service shipped what it received, and leaving the stream out would pass the earlier answer as complete. An SSE response that failed after the generation-end marker was finished by the model, and the service may have shipped it (the same as kind `model` when raw is given).
  - Raw Cannot Be Determined row 2, failures before the marker left out: including SSE responses that failed through a provider error event or a mid-body drop would make a normal trial that refetched with a non-stream request after the stream failed into an adapter error.
- When the adapter gives raw:
  - Failure check before the raw call: a trial that got no answer and gave an empty raw answer lands on the uncaptured call. Deciding the raw call first would end it as a missing `Result(model=)` adapter error, so transient failures such as evaluation-load rate limits would pile up as adapter errors and stop the run.
  - Cut last answer before the finish-reason check: a cut trial dropped as a missing `finish_reason` adapter error would remove a time-out from the denominator.
- Cut streams:
  - View 1: a cut for content and a cut at a time limit whose text was shipped cannot be told apart, and counting the stream as a `timeout` failure keeps the second from passing as complete. Not a successful call for recovery: an answer the service did not fully receive cannot make up for another request's failure.
  - View 2: the service cut after reading the received text, and the given raw is the first answer the model produced in that stream. A fallback and a discard both fail `completed`, so trusting the adapter never turns into a pass. Content cuts only: late-cut text is not graded ([001 adapter-protocol §Streams the Service Cut](../001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut)).
  - View 3, streams that failed by time-out or were unfinished stay view 1: treating them as unread would pass text cut by the service's time limit as complete. The distinction guards only against time limits that cancel an awaited read, which is why `stopped_early` is never given for trials cut by a time limit.
  - View 5, failures followed by a later searched call: the service moved past the failure, and looking at the request it moved to would split fallback and transient by cut style (cancelling an awaited read, cutting without an awaited read, only stopping to wait). The `answers=0` check: received answers must not silently leave the raw rules. `answers=0` on a trial cut late: a fallback and a time-out both fail `completed`, so the mistake never turns into a pass.
  - Cut styles: in each case the service did not receive the whole answer, so small differences in service code must not split fallback, time-out and complete.
- Failure check and no searched calls:
  - SSE failure after the generation-end marker: with kind `model`, the model finished the answer and the adapter says the service shipped it; with a fallback or discard, the failure may have caused the fallback.
  - Failure check: without it, an empty raw answer from a service that swallowed a model call failure and shipped a fixed message would land on the uncaptured call, invent an answer call and turn a transient failure into a completion failure. It also runs when other answers exist (a classification before the answer) and raw is empty. With a non-empty raw and a captured answer, the model answered and the failure is most likely a side call's; an adapter that refined a captured answer before passing it falls here, and the uncaptured call and W4 report it.
  - Unfinished calls in the failure check: a service that stops waiting under its own time limit, without cutting the request, and gives what it received must get the same result as one that cut the request (a `timeout` failure), as in Outcome row 6.
  - No check with an unread response: a normal trial whose answer came as a stream and where only a later side call failed must not count as failed. Streams that ended in a tool call: counting them as unread responses would let earlier calls of a streaming tool loop block the check, so what was received would pass as complete even when the last call was cut or failed with a provider error. With `answer_tool`, a tool call can be the answer, and which tool was called needs the stream content, so they count. The cost is K29 of [data-model §Known Limits](data-model.md#known-limits).
  - `reply_call` and `answer_tool` when giving raw: without `reply_call` in a service whose answer comes through an uncaptured transport, every captured variant model call is an answer candidate, so a side call's failure, or a side call still running when the function returned, becomes the trial's failure (with one side-call branch that equals Outcome row 6 without raw; with two or more, Outcome row 5 without raw). Without `answer_tool`, a response that carries the final answer as a tool call is not an answer, and a same-model side call's failure becomes the trial's failure.
  - No searched calls: for Outcome row 3's reason, a trial whose side call before the answer failed and that never requested the answer must not become adapter error A7 or an empty answer. No warning: the result equals Outcome row 3 without raw and the adapter has nothing to fix. Not with a non-empty raw answer or a `Result(model=)`: they may mean the answer came through an uncaptured transport.
- Raw call:
  - Matching answer, answers only: a side call that ended only in tool calls has empty text and would match an empty raw answer. Last unread response: its text was not seen, so the matching answer cannot find it.
  - `Result(model=)` required for the uncaptured call: when only same-model side calls are captured, passing Outcome row 4 does not prove the answer went to the variant model, and both variants could be compared on the same model.
  - Uncaptured-call exception: a variant model call exists, so the adapter did pass the variant model, and an adapter error would drop a regression that calls tools without end from the denominator (data-model §Raw Cannot Be Determined row 1, the Outcome row 5 exception). Not with `Result(model=)`: the adapter then declares that the raw answer came through an uncaptured transport, so a trial that received an empty answer counts as an empty answer, not a fallback, and that call's cost is not lost.
  - W4: an adapter that refines the raw answer before passing it lands on the uncaptured call even though a captured answer exists, and the cost is counted twice; that is better than counting it too low.
  - W8: an adapter that does not pass the variant model, but gives a refined or stream-collected raw answer with `Result(model=)` set to the variant model, passes both Outcome row 4 and W2, and both variants are compared on the same model. The length condition keeps a short raw answer ("yes") that happens to appear inside another model's long summary from counting as its source; with `reply_call`, only calls it is true for are source candidates, so that a service that receives answers through an uncaptured transport and always has unrelated other-model streams can switch the warning off.
- Answer candidate calls when raw is given:
  - Branches holding an earlier unread response: an unread response cannot be joined to later requests by branch rules; without this, earlier calls of a streaming tool loop would stay side calls.
  - Outcome row 5 case 1: a streaming same-model classification before the answer would otherwise make both the render target and the fingerprint the classification request, with no error or warning. Case 2: treating a regenerated answer as a side call would decide `completed` and the regeneration rate on the first answer and never look at the shipped text (001 data-model §Trial Outcomes). Case 3: a cut streaming regeneration would otherwise pass on the first answer's finish reason and drop out of the regeneration rate. A cut stream with another first-request system may be a side-call stream still running when the function returned (a memory write).
  - The fingerprint rule: an unread response cannot be joined to later requests by branch, so taking the raw call's branch would raise `render-mismatch` on every trial of a streaming tool loop, loops whose last call alone is non-stream included. The render target rule is not used because a service with a same-model classification before the answer that passes Outcome row 5 with `Result(finish_reason=, answers=)` and no `reply_call` would make both the render target and the fingerprint the classification request, so a wrong render target would not show as `render-mismatch`.
- Cut last answer:
  - An earlier call that blocks the failure check (a same-model classification before the answer, an earlier call of a streaming tool loop with `answer_tool`, a fully received first answer) would otherwise let a cut answer pass on the finish reason the adapter gave.
  - No helper count: the helper does not read streams and cannot know whether the service shipped the earlier answer or the cut text.
  - No exception to the raw call cut condition without `reply_call`: a later response cannot be told from a same-model side call (a memory summary), and taking a side call as the re-received answer would pass cut text as complete.
  - `answers` of 2 or more: a fully received answer exists (the service cut a regeneration after fully receiving an earlier answer, or cut for content and then fully received a resent answer) and the service may have shipped it.
- Derived fields:
  - Text joining: equal to the OpenAI SDK's `output_text`, it gives both helpers the same raw answer. The last answer's finish reason: regenerating services usually ship the last answer ([001 adapter-protocol §`generate`](../001-swap-check/contracts/adapter-protocol.md#generate-required) `finishReason`); that holds for services that regenerate with a modified request, so W3 looks only at answers of the same request.
  - `Result(usage=)`: without it, stream reservations pile up on every trial and the run can stop at the default cap.
  - `calls` omitted with no captured call: an empty array means no model was called and the tool would charge 0, but the helper cannot see calls through uncaptured transports.
- Matching reported failures:
  - A12 decided by the helper, not raised at construction: raising would count it as a discard whenever `discard_on` lists the same exception type.
  - The `call` check: an adapter that passes every failed call as `call` would turn normal trials into transient failures on a 429 the SDK recovered from by resending, or on a side-call failure the service swallowed; those trials would be retried and leave the denominators.
  - Same-model side calls excluded by `reply_call` are not searched: matching one would attach the failure of an answer received through an uncaptured transport to that call, so the side-call failure the service swallowed would become the trial's result, or the answer call's cost would be lost.
  - Other models regardless of `reply_call`: the target function named that model.
  - Fit and send time rather than the last call: a different call sent to the same model at the same time (a safety check) that failed first would otherwise turn an overload of the answer stream into that call's request rejection, and a classification stream that ended earlier would take the failure of the answer call sent after it.
  - Started response, no stream with a generation-end marker: it is a finished answer, and attaching the failure there would lose the cost of the uncaptured answer call. No recovered failures: the service did not receive them.
  - Matching-failure candidate: it covers a target function that converts an SDK exception the service raised. Using the call's kind avoids counting one failure twice and keeps the classification the helper made at the HTTP layer, which the SDK exception loses (R9). The unfinished-call candidate keeps the same request from being counted twice in cost. A corrected call failed after its response started, so without `usage` it may have been billed.
  - W10 flags an adapter that picked an earlier attempt the SDK resent and recovered from the third argument and turned a normal trial into a transient failure. `kind` `timeout` is left out because the target function builds it to report a service time limit; a correct throw would look matched whenever an earlier resent attempt ended without an error response. Not filtering by `reply_call` keeps the warning away from trials that threw a side-call failure the service did receive. Trials with no call true for `reply_call` are left out because, in services that receive the answer through an uncaptured transport, a correctly thrown answer failure can look like the recovered earlier attempt of a side call excluded by `reply_call`.
- Outside the trial context and after the function returned:
  - A waiting trial is not in progress: requests after the function returned never join a trial. Two or more trials in progress: stopping is better than grading another trial's answer.
  - No wait for bodies with a generation-end marker or a failure end event: the model finished, what remains is usage and the end event, and stream content is not parsed, so waiting would learn nothing. No wait for a body nobody is reading: a body the service discarded after seeing the headers must not hold the trial until the time limit. One microtask on Node is not enough: the official SDKs await several times after `fetch` resolves before they start reading the body.
  - The service never received the responses of unfinished calls, so how a late response ended must not change the result.
  - Requests first sent after the function returned: joining would make the number of branches and Outcome row 5 depend on how long the helper waited. No error kind when the wait ends: the helper stopped waiting; the model did not fail. Waiting at `shutdown` includes the background cost of the last trials of a run.
- Finish reasons, content first: Responses that ended in a tool call still have `status` `completed`, so the status alone would say `stop`. Looking only at `function_call` would make the earlier responses of a loop over custom tools empty answers and the later requests new branches; counting provider-run tools as tool calls would stop an answer produced through such a tool from being an answer.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Leave a cut stream out when the adapter gives no raw | Passes the earlier answer as complete |
| Decide the raw call before the failure check | Evaluation-load failures with an empty raw pile up as missing-`model` adapter errors and stop the run |
| Use the helper's own answer count for a cut last answer | The helper does not read streams and cannot know whether the cut text or an earlier answer was shipped |
| Base W1 on the first answer instead of "a call sent after the failure" | Misses the common trial where a check sent with the answer failed before the first answer arrived |
