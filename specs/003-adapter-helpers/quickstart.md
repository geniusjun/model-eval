# Quickstart: Adapter Helpers

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

`examples/python-service` is a small synthetic chat service that calls the model through the OpenAI SDK, with an adapter written with the Python helper. Its model calls go to the local mock API server in `adapters/python/mock_api`, so nothing here calls a real model. The expected result of every contract scenario is in [contracts/helper-scenarios.md](contracts/helper-scenarios.md).

## Prerequisites

Node 22.17 or later, Python 3.10 or later, and the repository built as in [001 quickstart](../001-swap-check/quickstart.md) step 0.

```bash
cd examples/python-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
python3 ../../adapters/python/mock_api/server.py --port 8787 &   # mock OpenAI API; logs every request it receives
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
alias model-eval="node ../../dist/cli.js"
```

## Verify: Example Python Service (SC-001, SC-004)

1. Look at the adapter.

   ```bash
   wc -l adapter.py
   git diff --stat -- service/
   ```

   Done when the adapter has at most 30 lines and the service folder has no change (SC-001).

2. Render without a model call.

   ```bash
   model-eval lint --render
   ```

   Done when it exits 0 and the mock server's request log is empty (User Story 2).

3. Run the swap check on the same example cases as `examples/pogo`.

   ```bash
   model-eval swap --from current --to next
   ```

   Done when it finishes like the Node mock adapter's run, and `trials.jsonl` has `raw`, `usage`, `finishReason` and `calls` filled for every trial (SC-004).

## Verify: Contract Tests (SC-002)

```bash
pnpm test:contract -- helper                      # TypeScript helper
cd adapters/python && python3 -m pytest tests     # Python helper
```

Done when every combination passes: helper language × SDK and major version ([helper-api §Supported SDKs](contracts/helper-api.md#supported-sdks)) × API (Chat Completions, Responses, Messages) × Python sync, async and aiohttp backend, and every scenario of [contracts/helper-scenarios.md](contracts/helper-scenarios.md) outside [helper-scenarios §Two-Language Parity](contracts/helper-scenarios.md#two-language-parity) and [helper-scenarios §Uncaptured Calls](contracts/helper-scenarios.md#uncaptured-calls) passes. The mock servers are selected with `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`, no service code is changed, and no request leaves the machine.

## Verify: Two-Language Parity (SC-003)

```bash
pnpm test:parity     # runs test/fixtures/helper/parity through both helpers and compares the results byte for byte
```

Done when every scenario in [helper-scenarios §Two-Language Parity](contracts/helper-scenarios.md#two-language-parity) passes.

## Verify: Uncaptured Calls (SC-005)

These scenarios run with the contract tests above. Done when every scenario in [helper-scenarios §Uncaptured Calls](contracts/helper-scenarios.md#uncaptured-calls) passes and none records an empty raw answer in a normal trial.

## Connect a Python Service

1. In an empty folder, run `model-eval init --adapter python`. It creates a config, an adapter skeleton that uses the copied helper, and example rules and cases ([001 quickstart §Connect Your Own Service](../001-swap-check/quickstart.md#connect-your-own-service)).
2. In the target function, call the service function and return its shipped text, with the helper import above the service import ([helper-api §Python](contracts/helper-api.md#python-model_eval_adapterpy)). For OpenAI and Anthropic SDK calls, the helper fills raw, tokens and finish reason.
3. Set the target options ([helper-api §Target Options](contracts/helper-api.md#target-options)): `discard_on` for the exceptions the service raises when it discards an answer, leaving fake-storage exceptions out so harness mismatches surface as adapter errors; `reply_call` when the service calls the same model besides the answer; `answer_tool` when it receives its final answer as a tool call.
4. When the answer arrives through an uncaptured transport (Bedrock, the Claude Agent SDK), report per [helper-api §Uncaptured Transports](contracts/helper-api.md#uncaptured-transports), even when no error appears.
5. When the service streams its answer, regenerates or picks one of several answers, or uses one message for several causes, report per [helper-api §What the Target Function Reports](contracts/helper-api.md#what-the-target-function-reports).
6. When the service hits its own time limit, report per [helper-api §Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting).
7. When another call's failure made the service cut the answer request, ship something else instead of a received answer, or discard it, report per [helper-api §Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure).
8. When an input check sent with the answer answered "block" and the service cut the answer request, report per [helper-api §Trials Stopped by a Parallel Check's Refusal](contracts/helper-api.md#trials-stopped-by-a-parallel-checks-refusal).
9. Run one case with `model-eval run --variant current --cases <caseId> --repeats 1` and check `raw`, `usage`, `finishReason` and `calls` in `trials.jsonl`, then `lint --render`, `swap --dry-run` and `swap`.

Done when a comparison of your own baseline and candidate variants opens.

## Troubleshooting

Message IDs are listed in [helper-api §Messages](contracts/helper-api.md#messages); "Outcome row N" is a row of [data-model §Outcome Decision](data-model.md#outcome-decision).

| Symptom | What to do |
|---|---|
| A1 "No model request was captured" | In Node, put the helper import above the service import. Check that the service does not hand the SDK another transport (a `fetch` option, a client other than httpx or httpx2). For uncaptured APIs (Bedrock, Vertex AI) or a child process (Claude Agent SDK), report per [helper-api §Uncaptured Transports](contracts/helper-api.md#uncaptured-transports), including a refusal by a same-model call before the answer. Give `usage` 0 for unbilled failures (rejected requests, connection failures), or reservations pile up ([helper-api §`ModelCallError`](contracts/helper-api.md#modelcallerror)) |
| A2 "No request went to the variant model" | Check that the target function passes `variant.model` to the service; otherwise both variants run on the same model. If a service exception is in the message (fake storage rejecting a query), look at it first. Then follow the message ([helper-api §Adapter Error Messages](contracts/helper-api.md#adapter-error-messages) A2): for a call before the answer that failed or that the service stopped waiting for, see [helper-api §Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure) rule 1; for another model's refusal before the answer, see [helper-api §Conditions and Notes](contracts/helper-api.md#conditions-and-notes) |
| A3 "Cannot choose the answer call" | Set `reply_call` for the same-model calls besides the answer (classification, memory writes, validation; a validation call that continues the conversation is its own branch, [data-model §Call Branches](data-model.md#call-branches)). When a classification before the answer refused and the service shipped a fixed message, wrap it with `fallback` (the Outcome row 5 exception, [data-model §Outcome Decision](data-model.md#outcome-decision)). For the other causes, follow the message ([helper-api §Adapter Error Messages](contracts/helper-api.md#adapter-error-messages) A3). A changed system is a row of [helper-api §What the Target Function Reports](contracts/helper-api.md#what-the-target-function-reports) |
| A4 "Every answer call ended in a tool call" | Set `answer_tool` with the tool name and the argument key |
| A5 "Streaming responses are not parsed yet" | Pass what the service collected per [helper-api §When to Give `raw`](contracts/helper-api.md#when-to-give-raw) and the stream rows of [helper-api §What the Target Function Reports](contracts/helper-api.md#what-the-target-function-reports). Give `usage=`, or raise `--max-cost-usd`: without it stream calls are charged their reservation ([data-model §Derived Result Fields](data-model.md#derived-result-fields)). Mid-stream provider error events need no report |
| A7 "Cannot find the call that produced the raw answer" | Give a captured answer unchanged; for an uncaptured transport give `Result(model=)`. For the other causes, follow the message ([helper-api §Adapter Error Messages](contracts/helper-api.md#adapter-error-messages) A7) and [helper-api §Uncaptured Transports](contracts/helper-api.md#uncaptured-transports) item 2 |
| A10 "A model request was made outside any trial context" | Run with `--concurrency 1`, or have the service pass the context to the thread ([data-model §Outside the Trial Context](data-model.md#outside-the-trial-context)) |
| A11 "Could not reach the render target request" (exit 4, render failed) | When a call to another model before the answer is blocked in render and the service stops, return the assembly result with `@adapter.render`. Remove cases on paths that never call a model, such as input blocks ([helper-api §When Render Fails](contracts/helper-api.md#when-render-fails)) |
| W1 "In a trial that received an answer, a call … failed transiently" | Act on the case the sentence names ([helper-api §Trial Warnings](contracts/helper-api.md#trial-warnings) W1). When many trials carry it, lower `--concurrency` and run again |
| W2 "The shipped text may be another model's answer" | Wrap the shipped text with `fallback` |
| W4 "No captured answer has the raw answer's text" | Pass the raw answer unrefined, or exclude a same-model side call that answers in text with `reply_call` |
| W5 "Decided by a captured call's failure instead of the given raw answer" | When the answer request failed (a provider error, a rate limit, a dropped connection, also mid-stream), the result is right. Otherwise follow the sentence ([helper-api §Trial Warnings](contracts/helper-api.md#trial-warnings) W5) |
| W6 "Decided as a time-out instead of the given raw answer" | When the service's time limit cut the trial and no earlier answer was fully received, the time-out is right. After a fully received answer, give `answers=` counting the cut answer and `finish_reason=`. Otherwise follow the sentence ([helper-api §Trial Warnings](contracts/helper-api.md#trial-warnings) W6) |
| W10 "The thrown failure may belong to an earlier attempt that was resent" | Throw the failure with `retried` false that the service received |
| An adapter error shows the service's time-out exception | Catch it in the target function and throw `ModelCallError(kind="timeout")`, which counts as a time-out |
| Exit 4, authentication, model or billing error | Check keys, model names and balances ([001 quickstart §Troubleshooting](../001-swap-check/quickstart.md#troubleshooting)) and the Anthropic cause codes of [helper-api §Error Classification](contracts/helper-api.md#error-classification): a suspended organisation, an unusable customer-managed encryption key, an API-key creator who left the organisation, a Claude Code version that is too old. Check side calls too (classification, memory writes): their failure also stops the run (Outcome row 1) |
| Exit 4, resume or adapter restart refused because the service version changed during a run | Put files the service creates while running (logs, caches) in the git ignore list; seen as untracked files they change `treeHash`. During a run use `.git/info/exclude`, since `.gitignore` is itself a service file ([001 quickstart §Troubleshooting](../001-swap-check/quickstart.md#troubleshooting)) |
| Slow adapter start-up on a large repository | Every file of `service_dir` is read for `treeHash`, and the tool waits up to `adapter.timeoutMs` for the `initialize` response ([001 adapter-protocol §Time Limits and Recovery](../001-swap-check/contracts/adapter-protocol.md#time-limits-and-recovery)). In a monorepo, narrow `service_dir` to the service code and put large data files in the ignore list |
| Warning `render-mismatch` | With a same-model classification before the answer, set `reply_call`. For the other causes, see [helper-api §When the Render Target Differs From the Answer Request](contracts/helper-api.md#when-the-render-target-differs-from-the-answer-request) |
| Warning `regeneration-rate-increase` | Besides the reading in 001 quickstart: a late response to a request the service stopped waiting for is not an answer. Report per [helper-api §Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting) rule 3 and [helper-api §When to Give `raw`](contracts/helper-api.md#when-to-give-raw) item 4 |
| Regeneration rate near 100% on both variants | Make `reply_call` true only for answer calls, not for validation or memory-write calls after the answer. Count `Result(answers=)` per [helper-api §`Result`](contracts/helper-api.md#result); when the first answer came as a stream, a regeneration stream cut because a parallel request failed counts one more (K10 of [data-model §Known Limits](data-model.md#known-limits)). Services that pick among `n` > 1 answers are normal ([helper-api §What the Target Function Reports](contracts/helper-api.md#what-the-target-function-reports)) |
| Many completion failures from time-outs | If trials carry W6, read that row first. A service that cuts the rest when one parallel request fails (`asyncio.TaskGroup` and similar) reports per [helper-api §Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure); a service whose parallel input check blocks reports per [helper-api §Trials Stopped by a Parallel Check's Refusal](contracts/helper-api.md#trials-stopped-by-a-parallel-checks-refusal) |
