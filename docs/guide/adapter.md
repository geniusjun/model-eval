# Writing an adapter

model-eval does not know how your service builds prompts or cleans up answers. An adapter is a
small program, in any language, that runs your service's own turn function for one model and
reports what happened. The tool starts it as a child process and talks to it over stdin and
stdout with [adapter protocol v1](../../specs/001-swap-check/contracts/adapter-protocol.md).

The adapter should call the code your service runs in production: the same prompt assembly, the
same model client with its retries and time limits, the same post-processing. A swap check is
only as good as that path. If the adapter rebuilds the prompt by hand, the check tests the copy.

[`examples/pogo/adapter.mjs`](../../examples/pogo/adapter.mjs) is a complete adapter in plain
Node that stands in for a model. The protocol contract ends with a
[minimal Python adapter](../../specs/001-swap-check/contracts/adapter-protocol.md#minimal-adapter-python-without-the-helper).

## How the tool runs it

The config names the command:

```yaml
adapter:
  command: [python, -m, eval_adapter] # an array; no shell is involved
  cwd: . # relative to the config file
  env: {} # extra variables; never API keys
  timeoutMs: 120000 # how long the tool waits for one trial
```

- The tool starts one process per variant and tells it the variant once, in `initialize`. Every
  later request of that process uses that model.
- Each message is one JSON-RPC 2.0 object on one line. stdout carries nothing else. Write logs to
  stderr; `--verbose` shows them. A stray `print` on stdout is the most common adapter bug, and the
  tool restarts the process when it sees one.
- The tool may send several `generate` requests before the first answer arrives, up to the
  smaller of your `maxConcurrency` and `run.concurrency`. Answers may come back in any order; they
  are matched by `id`.
- At the end the tool sends `shutdown`, waits for the response and closes stdin. Exit within 5
  seconds.

API keys come from the environment the tool was started in, which the adapter inherits. The tool
never reads or records them.

## `initialize`

The request carries the variant (`id`, `model`, optional `params` from the config) and
`timeoutMs`. Keep the model and params, then describe the adapter. The Pogo adapter answers:

```json
{
  "protocolVersion": "1",
  "adapter": { "name": "pogo-chat", "version": "0.1.0" },
  "targets": [
    {
      "name": "chat",
      "languages": ["ko", "en", "ja"],
      "inputSchema": {
        "type": "object",
        "required": ["user"],
        "additionalProperties": false,
        "properties": {
          "user": { "type": "string", "minLength": 1 },
          "nickname": { "type": "string", "minLength": 1 },
          "state": {
            "type": "object",
            "properties": { "wearing": { "type": "array", "items": { "type": "string" } } }
          },
          "mood": {
            "type": "object",
            "required": ["label"],
            "properties": { "label": { "type": "string" } }
          }
        }
      }
    }
  ],
  "capabilities": { "render": true, "stages": true, "postprocess": true, "maxConcurrency": 4 }
}
```

- `targets` are the service functions the adapter can run. Cases name a target, and `lint` checks
  each case's `input` against the target's `inputSchema`. A target with several languages needs
  `lang` on every case.
- Add `service` for a real service, since the adapter version alone does not show changed
  post-processing: `{"version": "<commit SHA>", "dirty": false, "treeHash": "sha256:…"}`, with
  fields you cannot compute left out. Runs record it, comparisons warn with `versions-differ`
  when two runs used different code, and resume refuses to mix code versions. When you hash the
  service files, leave out the paths listed in `toolPaths` of the request: the config, rule and
  case files and the output directory.
- `capabilities`: `render` and `cancel` default to `false`, `postprocess` to `true`. Declare
  `postprocess: false` when the shipped text is always the raw answer; reports then say so.

## `render`

`render` returns the messages the service would send for a case, without calling a model. For
the case `argue-ja` the Pogo adapter returns:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "あなたはポゴ。ユーザーの友だちとして短く答える。\n日本語だけで話す。\n絵文字を使わない。\n聞かれるまで自分の服や部屋、していることを話さない。"
    },
    { "role": "user", "content": "友だちとけんかした。" }
  ],
  "inputTokens": 73,
  "maxOutputTokens": 256
}
```

It is optional, but without it the tool cannot check anchors (`lint --render`), cannot fingerprint
the prompt of each case and has to estimate input tokens from `estimate.inputTokens`. Assemble the
messages exactly as production does. Do not put secrets in them.

## `generate`

`generate` runs one trial. The request has `target`, `lang`, `input`, `caseId`, `repeat` and a
per-trial `seed` (pass it to providers that accept one). The result reports two texts:

- `raw`: the first answer the model gave, before any post-processing.
- `final`: the text the service sends to the user, with `finalKind` saying what it is: `model`
  (a model answer after post-processing, possibly a regenerated one), `fallback` (a fixed message
  or another model's answer) or `discarded` (the service threw the answer away; no `final`).

Rules are graded on both. The default gated surface is `raw`, because post-processing that strips
other scripts or emoji makes a rule hold on the shipped text however often the model breaks it.

The `next` variant of Pogo answers `argue-ja`, repeat 0, with a Korean word in a Japanese answer:

```json
{
  "raw": "そうなんだ。 もっと聞かせて。 화이팅",
  "finalKind": "model",
  "final": "そうなんだ。 もっと聞かせて。 화이팅",
  "stages": [{ "name": "collapse-spaces", "text": "そうなんだ。 もっと聞かせて。 화이팅" }],
  "usage": { "input": 73, "output": 17 },
  "latencyMs": 358,
  "finishReason": "stop",
  "modelSnapshot": "model-b-v1",
  "calls": [
    {
      "model": "model-b",
      "responseModel": "model-b-v1",
      "outcome": "ok",
      "branch": "answer",
      "usage": { "input": 73, "output": 17 },
      "finishReason": "stop",
      "latencyMs": 358
    }
  ]
}
```

`raw`, `finalKind`, `latencyMs` and `finishReason` are required. Map the provider's finish reason
to `stop`, `length`, `content_filter` or `other`. Report `usage` in the buckets `input`,
`cachedInput`, `cacheWrite` and `output` (reasoning included), and leave out buckets the provider
does not report rather than writing 0. `stages` is optional and lists the text after each
post-processing stage.

Send `calls`, one record per model call the trial made, side calls included. The tool prices each
call with the config's `pricing`; without `calls` it cannot tell whether a model was called and
charges the attempt its full reservation.

When the service regenerates, picks between several answers, or cuts streams, `raw` and the
`answers` count follow precise rules; see
[§Answers](../../specs/001-swap-check/contracts/adapter-protocol.md#answers) and
[§Streams the Service Cut](../../specs/001-swap-check/contracts/adapter-protocol.md#streams-the-service-cut).

## Failures

A failed model call is a normal result with an `error`, not a JSON-RPC error, because the kind of
failure is itself compared between models:

```json
{
  "error": { "kind": "transient", "message": "429 rate limited", "retryAfterMs": 2000 },
  "latencyMs": 30012,
  "calls": [
    { "model": "model-b", "outcome": "failed", "errorKind": "transient", "branch": "answer" }
  ]
}
```

| `kind`      | Use it for                                                       | The tool                              |
| ----------- | ---------------------------------------------------------------- | ------------------------------------- |
| `transient` | Rate limits, 5xx, connection failures and drops                  | Retries up to `run.retries` times     |
| `timeout`   | No answer within the service's own time limit and retries        | Counts a completion failure; no retry |
| `permanent` | The provider rejected the request shape                          | Counts a completion failure; no retry |
| `config`    | Authentication, unknown model, quota or billing, TLS certificate | Stops the run with exit code 4        |

Keep the service's retry policy and time limits as they are; they are production behaviour.
Return a JSON-RPC `error` only for bugs in the adapter itself, such as unreadable input or an
exception the service does not define. Those count as adapter errors, and too many of them stop
the run. If you turned provider exceptions into JSON-RPC errors, a burst of rate limits would stop
the run instead of being retried.

When the service swallows a failure and ships a fallback, report the failure; the rules for that
and for regenerations are in
[§Reporting Model Failures](../../specs/001-swap-check/contracts/adapter-protocol.md#reporting-model-failures).

## Time limits

Set `adapter.timeoutMs` longer than one service call can take, SDK retry waits included, so the
service's own time limit fires first. When the tool's limit fires instead, the trial is abandoned
as an adapter error and the comparison warns with `abandoned-trials`. The tool never resends a
trial whose response did not come back, since the provider may already have billed it.

## Background calls and logs

- Model calls that finish after `generate` returned (memory writes, analytics) go in a `calls`
  notification with the request `id`. On `shutdown`, wait for such calls and send their
  notifications before responding, so their cost is counted.
- A `log` notification (`{"level": "warn", "message": "…"}`) goes to the run's `adapter.log`; at
  the end of a run, `warn` and `error` messages are shown with counts.
- A sentence about one trial's result goes in that result's `warnings` array; comparisons group
  them as `adapter-warnings`.

## Checking an adapter

From the folder of the config file:

```bash
model-eval lint --render
```

This starts the adapter for every variant, renders every case, checks anchors and reports
protocol problems, including output on stdout, as `adapter-failed` with exit code 4.

Then run one case once and read the record:

```bash
model-eval run --variant current --cases greet-ko --repeats 1
```

The run is written to `.model-eval/runs/<runId>/`. Check that `raw`, `usage` and `finishReason`
are filled in on the line of `trials.jsonl`. Raw trial records are not redacted, so keep the
output directory out of version control; `init` adds it to `.gitignore`.

## Running untrusted configs

Every command except `init`, `grade`, `compare`, `report` and `lint --no-adapter` runs the command
in the config file. Treat the config like code and do not run adapter-starting commands for pull
requests from forks in a job that holds API keys. See [Running in CI](ci.md).
