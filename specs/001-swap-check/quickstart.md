# Quickstart: Model Swap Check

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

The synthetic example `examples/pogo` uses a mock adapter (`adapter.mjs`) that needs only Node and never calls a model. Its `model-b` breaks the Japanese script rule on purpose, so the result always points the same way. Someone new to the repository should finish steps 0–4 within 10 minutes (SC-006).

## Verify: Example Swap Check (SC-001, SC-006)

0. Prepare. Node 22.17 or later is required.

   ```bash
   git clone <repository> && cd <repository>
   pnpm install && pnpm build
   cd examples/pogo
   alias model-eval="node ../../dist/cli.js"   # after release: npm i -D model-eval, then npx model-eval
   ```

   Done when `model-eval --version` prints a version.

1. Lint the files and the adapter.

   ```bash
   model-eval lint --render
   ```

   Done when it exits 0 with the one `anchor-missing` warning planted in the example, and exits 1 with `--max-warnings 0`.

2. Look at the cost and the sample plan first.

   ```bash
   model-eval swap --from current --to next --dry-run
   ```

   Done when it shows call counts, expected and conservative cost with their basis, the reservation per attempt, and planned and minimum trials per gated cell, without calling a model.

3. Run the swap check.

   ```bash
   model-eval swap --from current --to next
   ```

   Done when it exits 1 (block) and the decision summary starts with the Japanese `script-ja` cell.

4. Read the result: `.model-eval/comparisons/<comparisonId>/report.md`, or `report.html` in a browser (feature 002).

   Done when the report alone says which rule, language and prompt sentence caused the block.

## Verify: Determinism (SC-002)

```bash
model-eval compare <baseRunId> <candRunId> --json > a.json
model-eval compare <baseRunId> <candRunId> --json > b.json
```

Done when the two files are identical apart from the volatile fields listed in [data-model §Identifiers and Hashing](data-model.md#identifiers-and-hashing).

## Connect Your Own Service

1. In an empty folder, run `model-eval init --adapter python` (or `node`). It creates a config, an adapter skeleton that uses the helper, and example rules and cases.
2. In the adapter's target function, call the service function and return its shipped text. Helper details, including what to report for fallbacks, cut streams and transports the helper cannot capture, are in [feature 003's quickstart](../003-adapter-helpers/quickstart.md).
3. Start with three deterministic rules: `completed`, a script rule and a forbidden-phrase rule.
4. Write at least 10 cases per gated cell (rule × language), or 30 to use the default settings. Lint says when there are too few.
5. Run one case first: `model-eval run --variant current --cases <caseId> --repeats 1`, and check that `raw`, `usage` and `finishReason` are filled in the run's `trials.jsonl`.
6. Run `lint --render`, then `swap --dry-run`, then `swap`.

Done when a comparison of your own baseline and candidate variants opens.

## Troubleshooting

| Symptom | What to check |
|---|---|
| "stdout is reserved for the protocol" | Helpers prevent it. In a hand-written adapter, send `print` and `console.log` output to stderr |
| Exit 4, adapter failed to start | `adapter.command` is an array and runs in `cwd`; use `--verbose` |
| Exit 4, authentication, model or billing error | The API key in the adapter's environment, the variant's model name, the account balance and spending limits. A failing side call (classification, memory) also stops the run. Provider-specific causes: [003 helper-api §Error Classification](../003-adapter-helpers/contracts/helper-api.md#error-classification) |
| Exit 4, certificate error | The TLS certificate of the model API could not be verified. Behind a company proxy, make the adapter's environment trust its certificate (Node: `NODE_EXTRA_CA_CERTS` pointing to the certificate; Python httpx and httpx2: `SSL_CERT_FILE` pointing to a bundle that contains it) and check the service's `base_url` |
| Exit 4, render failed | Some case cannot render at the start. `lint --render` shows the same error as `render-failed`. Remove cases on paths that never call a model, such as input blocks |
| Exit 4, resume refused or run stopped (service code differs) | The service files changed between segments or during the run (a commit alone does not count). Run `git status --short` in the service folder. Files the service creates while running (logs, caches) go into `.git/info/exclude`, then resume. `.gitignore` is a service file too, so edit it only after the run. Editing only rule files never blocks a resume |
| Exit 4, finished runs cannot be resumed | Resume only finishes stopped runs; start a new run |
| Exit 4, unpriced model | The service calls a model other than the variant's. Add its price to `pricing` and resume with `--resume` |
| Exit 4, input tokens cannot be estimated | The adapter cannot render or the service uses stored prompts. Set `estimate.inputTokens` to the rough token count of the whole prompt |
| Warning `abandoned-trials` | The tool gave up waiting. For time-outs, make `adapter.timeoutMs` longer than one service call can take, SDK retry waits included. When the message lists transient errors, see [003 helper-api §SDK Retries and `adapter.timeoutMs`](../003-adapter-helpers/contracts/helper-api.md#sdk-retries-and-adaptertimeoutms) for how much to add. Resume keeps the old value, so start a new run. For restarts, use `--verbose` to see why the adapter died |
| Systematic failures inside a `completed` regression | One case failed with transient or adapter errors on every repeat of the candidate only (the cell's `systematic`). Read the typical error message: fix the adapter for harness causes such as fake storage, lower `--concurrency` for rate limits |
| Warning `resume-config-ignored` | Resume keeps the first run's variant, seed, repeats, retries and adapter time limit. Start a new run to use new values |
| Warning `versions-differ` | The two runs used different service code or adapters. To isolate the model, run both variants again with one version (`swap`) |
| Warning `resume-unverified` | The service version or render fingerprints were missing on resume. Give the helper `service_dir` and enable rendering |
| Warning `render-mismatch` | The request the render captured differs from the request that produced the first answer, so anchor checks may not match the real request. Usual causes: [003 helper-api §When the Render Target Differs From the Answer Request](../003-adapter-helpers/contracts/helper-api.md#when-the-render-target-differs-from-the-answer-request) |
| Warning `regeneration-rate-increase` | The service filters the candidate's first answers more often. Read the raw cells, the masked rate and the empty-answer rate together |
| Warning `adapter-warnings` | Each sentence names its cause; what to do for each helper warning: [003 helper-api §Trial Warnings](../003-adapter-helpers/contracts/helper-api.md#trial-warnings) |
| Exit 3, adapter error rate | Read the adapter's stderr with `--verbose` and `error.message` in `trials.jsonl`. Exceptions that mean the service discarded the answer belong in `discard_on` |
| Exit 3, transient error rate | Provider outages or rate limits. Resuming does not resend the trials that ended in errors, so the sample shrinks. After an outage, start a new run; for rate limits, start a new run with a lower `--concurrency`. A typical message about usage limits or billing means a limit shape the tool does not know: fix the limit, then start a new run |
| Exit 5 before the start | The expected cost exceeds the cap; see `--dry-run`. On a first run (basis `structure`), set `estimate.outputTokens` to the service's usual answer length; the default 600 assumes short reasoning and inflates short chat answers several times. Otherwise reduce cases or repeats, or raise `--max-cost-usd` |
| Exit 5 after the first batch or a repeat round | The re-estimated total exceeds the cap: long outputs or fewer cache hits. Read the outcome distribution next to it; many candidate time-outs or rejections are a candidate problem, not a cap problem. Start a new run to reduce cases or repeats, or resume with a larger `--max-cost-usd` |
| Exit 5 during the run | The next attempt's reservation would cross the cap. Resume with a larger `--max-cost-usd`; the cap includes earlier spend |
| After cancelling a CI job | Repeated signals leave in-flight trials `stopped`; a kill after the grace period leaves the run `running`. With the output folder still there, `--resume` resends only the cut trials |
| Many completion failures from time-outs | The candidate misses the service's time limit, as it would in production. How to report services that cut streams or cancel parallel requests: [003 helper-api §What the Target Function Reports](../003-adapter-helpers/contracts/helper-api.md#what-the-target-function-reports) |
| Exit 2 again and again | Start a new run with the suggested `--repeats`, or add cases when the result asks for cases |
| Transient-rate warning | Lower `--concurrency`; it is most likely a provider rate limit |
| Warning that all repeats are identical | The provider honours the seed. Stop passing the seed in the adapter, or check the temperature |
