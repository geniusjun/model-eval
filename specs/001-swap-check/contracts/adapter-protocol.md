# Adapter Protocol v1 Contract

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

An adapter is a separate process that assembles the prompt with the service's code, calls the given model and returns the result after the service's post-processing. The tool starts it as a child process and talks over stdio. Adapters can be written in any language; Python and TypeScript services can use the helpers of feature 003 and never handle these messages directly.

## Transport

1. The tool runs `adapter.command` (an array, no shell) in `adapter.cwd` (relative to the config file) with `adapter.env` added.
2. Each message is one [JSON-RPC 2.0](https://www.jsonrpc.org/specification) object on one line, UTF-8, ending in `\n`. Messages contain no raw newline; `\n` escapes inside JSON strings are fine.
3. stdout is reserved for the protocol; debug output goes to stderr. The tool shows stderr with `--verbose` and attaches its last 50 lines to failure reports, redacted in both cases, because adapter stderr easily contains case input and model output. A stray `print` on stdout is the most common adapter bug; the helpers redirect service output to stderr.
4. The tool starts one adapter process per variant. The variant is given once in `initialize` and applies to every request of that process.
5. The tool may send requests without waiting. Concurrent requests per process never exceed the smaller of the adapter's `maxConcurrency` and `run.concurrency`. Responses may arrive in any order and are matched by `id`.
6. Shutdown: the tool sends `shutdown`, waits for its response and closes stdin. The adapter must exit within 5 seconds or receives a termination signal.

`initialize`, `generate` and `shutdown` are required. `render` and `cancel` are used only when declared in `capabilities`.

**Done when**: the adapter answers the required methods and writes nothing else to stdout. `model-eval lint --render` checks both.

## Methods

### `initialize` (tool → adapter, required)

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1","client":{"name":"model-eval","version":"0.1.0"},"variant":{"id":"next","model":"model-b","params":{"reasoning":"none"}},"timeoutMs":120000,"toolPaths":["/work/eval/model-eval.config.yaml","/work/eval/rules/base.yaml","/work/eval/cases/chat-ko.yaml","/work/eval/cases/chat-ja.yaml","/work/eval/.model-eval"]}}
```

- `toolPaths` are the absolute paths the tool uses: the config file, the files matched by the rule and case globs, and the output directory. On restarts and resumes the globs are matched again and earlier paths of the run are added (data-model §Resume and Locking). When an adapter computes the service's dirty flag and `treeHash`, it excludes these files and everything below them, compared by file identity rather than path text, so editing rules inside the service repository does not block a resume. Matched files are sent instead of globs because a glob without a fixed prefix (`**/rules/*.yaml`) turned into a folder could exclude the whole repository.
- `timeoutMs` is `adapter.timeoutMs`, so an adapter that waits for leftover model requests after the service function returned stays within it.

Result:

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"1",
  "adapter":{"name":"pogo-chat","version":"0.3.0","helper":{"language":"python","version":"0.1.0"}},
  "service":{"version":"0123456789abcdef0123456789abcdef01234567","dirty":false,"treeHash":"sha256:…"},
  "targets":[{"name":"chat","languages":["ko","en","ja"],"inputSchema":{"type":"object","required":["user"],"properties":{"user":{"type":"string"}}}}],
  "capabilities":{"render":true,"stages":true,"postprocess":true,"cancel":true,"maxConcurrency":4}
}}
```

- A different major `protocolVersion` makes the tool send `shutdown` and end as a configuration error (exit code 4).
- `service` describes the service code, recorded because the adapter version alone does not reveal changed post-processing. Unknown fields are omitted.
  - `version`: a version string; helpers use the full commit SHA (40 characters for SHA-1 repositories, 64 for SHA-256).
  - `dirty`: whether there are uncommitted changes.
  - `treeHash`: hash of the service file contents ([003 data-model §`treeHash`](../../003-adapter-helpers/data-model.md#treehash) defines how helpers compute it).
  - Resume and adapter restarts compare `treeHash` when present, otherwise `version` and `dirty`, so a new commit with identical content is the same service.
- `adapter.helper` is present only when a helper is used; lint reports `helper-outdated` when it is older than the bundled helper.
- `postprocess: false` means `final` always equals `raw`, and reports say so.

### `render` (optional, when `capabilities.render`)

Returns the assembled messages without calling a model, assembled the same way as in production. Used for anchor checks, render fingerprints and cost estimates.

```json
{"jsonrpc":"2.0","id":2,"method":"render","params":{"target":"chat","lang":"ko","input":{"user":"안녕"},"caseId":"greet-ko","repeat":0,"seed":235035669}}
```

Result: `{"messages":[{"role":"system","content":"…"},{"role":"user","content":"안녕"}],"fingerprint":"sha256:…","inputTokens":4120,"maxOutputTokens":1024}`

- `caseId`, `repeat` and `seed` equal those of repeat 0 of the case in `generate`, so an adapter that picks fake-storage fixtures by case uses the same fixtures. All three are optional and may be ignored.
- `messages` is a list of `{role, content}` with the system message first when there is one; `content` is a string. Optional `tools` holds the tool definitions of the request.
- Without `fingerprint`, the tool computes it from `{messages, tools}` as the render fingerprint of the data model; adapters that compute it themselves use the same rule. [003 helper-api §Render Mode](../../003-adapter-helpers/contracts/helper-api.md#render-mode) defines how non-text parts are normalised.
- `inputTokens` is optional; without it the tool estimates from length (data-model §Cost).
- `maxOutputTokens` is optional: the output limit the service sets on the request, reasoning included. When present, reservations use it.
- Runs store only the fingerprint. Renders must not contain service secrets.

### `generate` (required)

```json
{"jsonrpc":"2.0","id":3,"method":"generate","params":{"target":"chat","lang":"ko","input":{"user":"안녕"},"caseId":"greet-ko","repeat":0,"seed":235035669}}
```

Result:

```json
{"jsonrpc":"2.0","id":3,"result":{
  "raw":"안녕! 오늘 어땠어?",
  "finalKind":"model",
  "final":"안녕! 오늘 어땠어?",
  "stages":[{"name":"strip-symbols","text":"안녕! 오늘 어땠어?"}],
  "usage":{"input":152,"cachedInput":3968,"cacheWrite":0,"output":18,"reasoning":0},
  "latencyMs":812,
  "finishReason":"stop",
  "modelSnapshot":"model-b-2026-10-01",
  "fingerprint":"sha256:…",
  "calls":[{"model":"model-b","responseModel":"model-b-2026-10-01","outcome":"ok","usage":{"input":152,"cachedInput":3968,"cacheWrite":0,"output":18},"finishReason":"stop","latencyMs":790}]
}}
```

| Field | Required | Meaning |
|---|---|---|
| `raw` | yes | The first answer, verbatim (§Answers). May be empty |
| `answers` | no | Number of answers the service received, integer ≥ 0, default 1 (§Answers) |
| `finalKind` | yes | `model`: the service shipped a model answer after post-processing, possibly a regenerated one. `fallback`: it shipped other text instead (a fixed message, another model's answer); a fallback caused by a failed model call is reported as that failure (§Reporting Model Failures). `discarded`: the service threw the answer away, used only when the adapter knows it did (an exception or value that means discard). Unknown service exceptions are adapter errors (JSON-RPC `error`), so a mismatched adapter does not hide in the discard rate |
| `final` | when not `discarded` | Text the service sends to the user |
| `discardReason` | no | Why it was discarded, for example the exception type and the start of its message |
| `stages` | no | `[{name, text}]` per post-processing stage |
| `usage` | no | Non-overlapping buckets: `input` (uncached input), `cachedInput` (cache hits), `cacheWrite` (input billed as cache writes), `output` (reasoning included); `reasoning` is the reasoning part of `output`, for information. Sum over calls when there are several. Unknown buckets are omitted, not 0; omit `cacheWrite` when the provider does not report writes |
| `latencyMs` | yes | Duration of the whole service function in milliseconds |
| `finishReason` | yes | For the shipped text: `stop`, `length`, `content_filter` or `other`. For a regenerated answer, that answer's; for a picked answer, the picked one's. A structured final answer the service accepted as complete (for example an answer delivered as a tool call) is `stop`. Adapters map provider values (`end_turn`, `tool_calls`, …) to this scale |
| `modelSnapshot` | no | Model of the response that produced `raw` |
| `fingerprint` | no | Render fingerprint of the first request of the branch that produced the first answer, converted to the `render` shape first. A mismatch with the case's render fingerprint raises `render-mismatch` |
| `calls` | no | Per-call records in send order (data-model §Trial). The tool then prices each call. An empty array means no model was called and costs 0, so omit `calls` unless every call is known |
| `warnings` | no | Sentences the reader of this result needs, for example "the call that produced raw was not captured, so its cost may be counted twice". Stored on the attempt and grouped by the comparison as `adapter-warnings`. Allowed on failure results too |

`seed` is the per-trial seed; pass it to providers that accept one and ignore it otherwise.

#### Answers

An **answer** is the response to a call the service made with the variant model to get its reply, including regenerations, re-draws and duplicates sent in parallel. Each item of a response with several `choices` is an answer. These are not answers:

- Responses to calls to another model, even when they are regenerations or parallel duplicates. Shipping one is `fallback`.
- Responses to side calls such as classification, validation or memory writes.
- Responses that ended in a tool call, except a tool call the service accepts as its final answer (the helper's `answer_tool`).
- A response that arrived after the service had stopped waiting for it, stream or not.

A **secured answer** is a fully received answer, or the non-empty text the service received before cutting a stream for content (cut reason 2). Content-cut text that is empty counts like cut reason 1.

`answers` counts answers as follows:

1. Each fully received answer counts one.
2. Cut streams that count as answers (below) count one in total, however many there are and even without text. So `answers` 1 on a trial with such a stream means no answer was fully received.
3. `0` means the trial ended without a model answer: `finalKind` must be `fallback` or `discarded`; `0` with `model` is a protocol violation recorded as an adapter error. `2` or more means the service regenerated or picked.

Examples: a first answer received in full, then a regeneration stream cut before its first character: 2. Cutting a late stream and resending, again and again, without ever receiving a full answer: 1, so the trial stays a time-out. A content cut followed by a resent request that was also cut: 1, so it is missing from the regeneration rate, a limit of this count.

`raw` is the text of the first answer:

- In a tool loop, that is the response that ended the loop.
- A cut stream that counts as an answer contributes the text received up to the cut. One whose received text is empty (nothing left after trimming whitespace, data-model §Trial Outcomes) is not chosen as the first answer.
- Content-cut text that is the first answer is graded, so violations the service masked count on raw rules.
- Cut streams that are not answers (cut reasons 1, 4 and 5) are never the first answer and never supply the no-answer text below.
- With no answer (`answers` 0), `raw` is the text of the last response the service received from a variant-model call made to get its reply, or the empty string.

#### Streams the Service Cut

A stream the service stopped reading before the model finished counts by the reason it was cut. Generic helpers cannot know the reason and treat every cut as reason 1; the adapter reports reasons 2 to 5 ([003 helper-api §What the Target Function Reports](../../003-adapter-helpers/contracts/helper-api.md#what-the-target-function-reports)).

| # | Reason | Counts as |
|---|---|---|
| 1 | Late: a time limit, or a parallel request (to any model) answered first | Not an answer when a secured answer exists from the time it was being received or later. Otherwise it is an answer (for example a regeneration cut after a secured answer) |
| 2 | Content check on the received text | The received text is an answer, even when another answer was received after it |
| 3 | Deliberate stop at a configured string | The received text is a fully received answer |
| 4 | A parallel request failed (a duplicate or a side call sent with the answer) | Not an answer. If the service shipped no answer, the trial is that failure |
| 5 | A parallel input check refused (the input safety check sent with the answer answered "block" instead of failing; also when a non-stream answer request was cancelled or abandoned) | Not an answer and its text is not graded. Report what the service shipped (`fallback` for a message, `discarded` for a discard) with `answers` 0 |

Reason 1:

- It covers using the first of several parallel requests (same or modified request, for example with "answer briefly" added; a request that differs only in streaming is the same request) and cutting the rest, and cutting a slow stream to resend the same or a modified request.
- It counts like a non-stream request that timed out and was resent, whose earlier attempt has no text. Slow, cut text is never graded on raw rules, just as the cut text of a timed-out trial is not. The user got an answer, so it is not a failure; the delay and the extra call show in latency and cost.
- No secured answer: the trial is the last failure that finished; a cut alone is `timeout` (§Reporting Model Failures).
- A secured answer: the regeneration rule applies (§Reporting Model Failures, rule 4). Exception: when the service shipped the cut regeneration text unchanged, the reported result and `answers` stand only if a fully received answer exists. If the only secured answer is content-cut text, the trial is `timeout`, because late-cut text is never graded.
- When the service used another model's parallel response and cut the candidate's stream without a secured candidate answer, the trial is `timeout`: in production that service cannot use the candidate's answer either.

Reason 5:

- It counts the same as a check called before the answer that refused, so the answer was never requested. If the check uses another model, the path has nothing to do with the swap; remove the case or change its input.
- A check that reads the received text (an output check) is reason 2, not 5.
- When an earlier stream was cut late and the check cut the last one, the trial is reason 5: the last event decides. A late-cut stream after a secured answer is still an answer under reason 1.
- With non-empty content-cut text before the check, it is not reason 5: it is `fallback` (or `discarded`) with that text counted as a received answer. `raw` and `answers` follow the rules above; without a fully received answer, `raw` is that text and `answers` is 1.
- With an answer fully received before the check refused, it is not reason 5: it is `fallback` (or `discarded`) instead of the received answer, and `raw` and `answers` follow the rules above (with no other answer, `raw` is that answer and `answers` is 1).

#### Reporting Model Failures

A model call failure is a normal `result`, because the kind of failure is itself a comparison metric. The failure result has `error: {kind, message, retryAfterMs?}`, where `retryAfterMs` (integer ms ≥ 0) belongs to the call that decided the outcome:

```json
{"jsonrpc":"2.0","id":3,"result":{"error":{"kind":"transient","message":"429 rate limited","retryAfterMs":2000},"latencyMs":30012,"calls":[{"model":"model-b","outcome":"failed","errorKind":"transient","retryAfterMs":2000,"branch":"answer","latencyMs":30010}]}}
```

Failure results may carry `calls` and `usage` and are priced like normal results. Without either, whether a model was called is unknown and the attempt is charged its reservation. A candidate rejected with HTTP 400 every time would then pile up reservations and stop on the cap (exit 5) instead of blocking (exit 1), so failure results should carry `calls`; the helpers always do.

| `kind` | Meaning | Examples | Tool behaviour |
|---|---|---|---|
| `transient` | May succeed on retry | Rate limits, 5xx, connection failures and drops (complete list: data-model §Transient Failures) | Retried `run.retries` times, waiting `retryAfterMs` up to 120 s |
| `timeout` | No model answer within the service's time limit, including a late stream the service stopped reading without a secured answer | A time limit that expired before response headers after the service's and the SDK's retries, a time limit between stream events, a stream cut without a secured answer (not reasons 4 and 5) | Not retried; completion failure |
| `permanent` | The request shape was rejected | An unsupported parameter combination, malformed input | Not retried; completion failure |
| `config` | A setup problem unrelated to model behaviour | Authentication, permission, unknown model, quota or billing exhausted, TLS certificate failure | The run stops with exit code 4 |

1. Keep the service's own retry policy and time limits as they are; both are production behaviour. No answer within them is `timeout`.
2. A stream cut without a secured answer is reported as the last failure that finished, whether the service answered with the received text or a fixed message. The cut stream counts as a `timeout` failure that finished when the service stopped reading, not when it closed the stream. Reporting it as a normal result with an empty `raw` would make it an empty answer.
   - Cut only, or the resent request also hit a time limit: `timeout`.
   - Cut late, and the resent request hit a rate limit: `transient`, the same as a failure left after the service's and the SDK's retries.
   - A parallel request failed and the service cut the rest (reason 4): that failure, leaving out the cut request.
   - Not failures: a deliberate stop (reason 3) and a refusing input check (reason 5), which report what the service shipped. For a content cut (reason 2), give the first answer as `raw` (the cut text when no answer was fully received) and report what the service shipped even when a resent request later failed (rule 4). With fully received answers, report `answers`.
3. When a failed model call left the service without an answer, report that failure. The user missed the model's answer because of it, and reporting a fallback or a time-out would turn rejections caused by evaluation load into completion failures of the candidate. This includes:
   - The answer request failed after the service's and the SDK's retries without a secured answer, and the service swallowed it and shipped a fixed message or another model's answer (the candidate call hit a rate limit and the service asked another model).
   - Another call failed (a parallel duplicate, or a side call before, after or alongside the answer), and the service did not send the answer request, cut it, shipped a fixed message or another model's answer instead of the received answer, or discarded it.
   - When the service uses the same message or discard for other reasons too and the adapter cannot know about the failure, report what the service shipped.
4. When the service filtered a secured answer and the regeneration request (to the same or another model) failed, and the service shipped the earlier answer, a fixed message or another model's answer, or raised a discard, report what it shipped (`model`, `fallback` or `discarded`), not the failure. The model did answer; the user missed it because the service filtered it. Retrying on that failure would drop the filtered first answer from raw rules and give a candidate whose first answers get filtered more chances under load. The price is that fallbacks and discards after regenerations rejected by evaluation load count as completion failures; the helpers warn on such trials. If the service raised a non-discard exception and shipped nothing, report the failure (rule 3).
5. When the service swallowed a failure and shipped the model's answer, the result stands and the failure stays in `calls`.
6. When any call of the trial failed with kind `config`, report the trial as `config`, whatever rules 1–5 say. Authentication, permission and quota problems mean the environment differs from production, and any other outcome would keep resume from resending the trial after the fix. The tool enforces this from `calls` in results, failure results and JSON-RPC error `data`. Calls after the result (`calls` notification) and late responses to abandoned requests (`cancel`) never change the outcome; they only stop the run.
7. JSON-RPC `error` responses are only for problems of the adapter itself (unparseable input, internal exceptions, unknown service exceptions) and are recorded as kind `adapter`. Raising provider SDK exceptions as JSON-RPC errors would turn rate limits into adapter errors and stop the run.
8. The `data` of a JSON-RPC error may carry `usage`, `calls` and `capturedRaw`, since tokens were billed if the model had answered. When the adapter knows for certain that the failure happened before any model call, it gives `data.calls` as an empty array. Pricing follows failure results; `capturedRaw` is stored for debugging and never graded.

### `cancel` (notification, tool → adapter, optional)

`{"jsonrpc":"2.0","method":"cancel","params":{"id":3}}` means the tool no longer waits for request 3. With `capabilities.cancel`, the adapter stops the work and, if it stopped, responds with that `id`. The tool never grades that response. It uses its `usage` and `calls` to correct the cost (§Time Limits and Recovery) and its calls for the `abandoned-trials` message, and stops the run as a configuration error when a call failed with `config` or used an unpriced model while a cap is set, like a `calls` notification.

### `shutdown` (required)

`{"jsonrpc":"2.0","id":99,"method":"shutdown"}` → `{"jsonrpc":"2.0","id":99,"result":null}`

When model calls that no result included are still running, the adapter waits for them, sends their `calls` notifications first and then responds. The tool waits up to `adapter.timeoutMs`, then sends a termination signal; calls not reported by then are not counted. This keeps background calls of the last trials in the cost.

### `log` (notification, adapter → tool, optional)

`{"jsonrpc":"2.0","method":"log","params":{"level":"warn","message":"cache miss"}}` has no `id`. The tool redacts it and writes it to the run's `adapter.log`. At the end of a run, `warn` and `error` logs are grouped by message and shown with counts, so environment problems the helpers report (for example exceptions in background work) are visible without `--verbose`. Warnings about one trial's result belong in that result's `warnings`, since `log` only reaches `adapter.log` and not the comparison or `--json`.

### `calls` (notification, adapter → tool, optional)

`{"jsonrpc":"2.0","method":"calls","params":{"id":3,"calls":[{"model":"model-b","outcome":"ok","branch":"side","usage":{"input":900,"output":40}}]}}`

- Reports model calls that no result included, after they finish: the service's background work (memory writes, analytics) that calls a model after returning.
- `id` is the `generate` request the calls belong to; omit it when unknown.
- The adapter sends it after the response for that `id`. The tool holds a notification that arrives first until the attempt line is written, so the cost is neither lost nor counted entirely as overrun.
- The tool never grades these calls. It prices them like results and appends them as cost lines (data-model §Trial). They were not reserved at send time, so they go into the overrun when the attempt exceeds its reservation. A `config` failure, or an unpriced model while a cap is set, stops the run as a configuration error; the trial outcome does not change.

## Time Limits and Recovery

The tool never resends trials whose adapter response never came (tool time-out, adapter restart), because the provider may already have billed the request. They stay adapter errors and resume does not resend them either. The tool resends only trials the adapter reported as `transient`.

| Situation | Tool behaviour |
|---|---|
| No response within `adapter.timeoutMs` (default 120000) | Record the attempt as an `adapter` error with `abandoned: "timeout"`, charge its reservation, send `cancel` when supported, and add `abandoned-trials` to the result. Set `timeoutMs` longer than one service call can take. Applies while stopping too |
| Slot of an abandoned request | Stays counted against concurrency until the adapter responds with that `id`. A late response is never graded; like a response after `cancel`, it only corrects cost (as a cost line) and is checked for warnings and configuration errors. When every slot holds an abandoned request and `timeoutMs` passes once more, the adapter is restarted |
| The adapter process dies | Record in-flight attempts as `adapter` errors with `abandoned: "restart"`, charge their reservations and restart. Three deaths in a row stop the run as `partial` with exit code 3 |
| A non-JSON line on stdout | Show its first 200 characters and "stdout is reserved for the protocol", record in-flight attempts as `abandoned: "restart"`, charge their reservations and restart |
| Adapter error rate above `run.maxAdapterErrorRate` (default 0.05) after 20 finished trials | Stop as `partial` with exit code 3 |
| Start failure, `initialize` failure or no response within `adapter.timeoutMs`, major version mismatch | Configuration error, exit code 4 |
| A restarted adapter declares a different adapter or helper version or service code (compared as in `initialize`) | Stop as a configuration error (exit code 4), since one run would mix trials of two code versions. For changed service code, the message suggests `git status --short` in the service folder; files the service creates while running belong in the ignore list, after which the run can be resumed |

## Compatibility

- Both sides ignore unknown fields. New features are added only as optional fields or `capabilities` entries.
- Changing a field's meaning or adding a required field bumps the major version.

## Minimal Adapter (Python, without the helper)

The helpers are recommended for Python and TypeScript. This is the minimal shape for other languages:

```python
import json, sys, time
from my_service import build_messages, call_model, RateLimited, ModelTimeout, BadRequest, AuthError

def handle(method, params, state):
    if method == "initialize":
        state["model"] = params["variant"]["model"]
        return {"protocolVersion": "1", "adapter": {"name": "my-service", "version": "0.1.0"},
                "targets": [{"name": "chat", "inputSchema": {"type": "object"}}],
                "capabilities": {"render": True, "postprocess": False, "maxConcurrency": 1}}
    if method == "render":
        return {"messages": build_messages(params["input"])}
    if method == "generate":
        started = time.monotonic()

        def failure(kind, exc, outcome="failed"):  # send the call record, or the cost piles up as reservations
            call = {"model": state["model"], "outcome": outcome, "errorKind": kind, "branch": "answer"}
            return {"error": {"kind": kind, "message": str(exc)}, "calls": [call]}

        try:
            text, usage, reason = call_model(state["model"], build_messages(params["input"]))
        except RateLimited as exc:
            return failure("transient", exc)
        except ModelTimeout as exc:
            return failure("timeout", exc, outcome="unanswered")
        except BadRequest as exc:
            return failure("permanent", exc)
        except AuthError as exc:
            return failure("config", exc)
        return {"raw": text, "finalKind": "model", "final": text, "usage": usage,
                "finishReason": reason, "latencyMs": int((time.monotonic() - started) * 1000)}
    if method == "shutdown":
        return None
    raise ValueError(f"unknown method {method}")

state = {}
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:  # notifications such as cancel are ignored here
        continue
    try:
        reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(msg["method"], msg.get("params", {}), state)}
    except Exception as exc:  # only adapter problems become JSON-RPC errors
        reply = {"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32603, "message": str(exc)}}
    sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    if msg["method"] == "shutdown":
        break
```

- This example handles one request at a time (`maxConcurrency: 1`); concurrency (asyncio or similar) is up to the adapter.
- With post-processing, capture `raw` at the model call and return the post-processed result and the discard or fallback decision as `finalKind`.

## Security

- The tool runs the command written in the config file, and so does every command that starts the adapter, including `lint` unless `--no-adapter`. Treat the config file like code. Never run adapter-starting commands for untrusted changes, such as pull requests from forks, in CI that holds secrets: an arbitrary command would run next to the keys. Run only `lint --no-adapter` for those.
- API keys are read in the adapter's environment. The tool never receives or records them.
- Raw trial records (`trials.jsonl`) are not redacted, because checks must read the original text. `init` adds the output directory to `.gitignore`. Every other written surface is redacted (FR-031).
