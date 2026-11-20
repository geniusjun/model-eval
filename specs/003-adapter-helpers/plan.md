# Implementation Plan: Adapter Helpers

**Branch**: `003-adapter-helpers` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-adapter-helpers/spec.md`

## Summary

Two adapter helpers, one Python file and one TypeScript subpath of the tool package, that speak adapter protocol v1 ([001 adapter-protocol](../001-swap-check/contracts/adapter-protocol.md)) for the adapter author. They wrap the HTTP client layer the official OpenAI and Anthropic SDKs use, record every Chat Completions, Responses and Messages call of a trial without changing what the service receives, and derive the trial result from those calls and the service function's result by fixed rules. Where the helper cannot see what happened (side calls with the same model, streams, uncaptured transports, a service that stopped waiting), the adapter declares it through `reply_call`, `answer_tool`, `discard_on`, `Result` and `ModelCallError` instead of the helper guessing. Render mode runs the same service function with every captured request blocked.

The Python helper is the first target and the TypeScript helper follows; if the first real integration ([001 plan §Validation Against a Real Service](../001-swap-check/plan.md#validation-against-a-real-service)) uses only the Python helper, it starts before the TypeScript helper is done ([001 plan §Delivery](../001-swap-check/plan.md#delivery), step 3).

## Technical Context

**Language/Version**: Python 3.10 or later for `model_eval_adapter.py`; TypeScript 5.x with the settings of 001 for `src/helper/`

**Primary Dependencies**: None. Python standard library only; Node built-in modules only (`node:async_hooks`, `node:stream`, `node:fs`, `node:child_process`)

**Storage**: None. Call records live in memory per trial context until the result is sent

**Testing**: pytest (Python helper) and vitest (TypeScript helper) contract tests against local mock API servers selected with `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`; shared fixtures for two-language parity

**Target Platform**: macOS and Linux; Node 22.17 or later; Python 3.10 or later; the SDK major versions of [helper-api §Supported SDKs](contracts/helper-api.md#supported-sdks)

**Project Type**: Part of the single npm package (subpath `model-eval/adapter`) plus one Python file shipped in the package and copied by `init`

**Performance Goals**: No added latency on the service's model calls beyond copying chunks as the SDK reads them; start-up includes reading every file of `service_dir` for `treeHash` (a few seconds on a large repository)

**Constraints**: No change to service code and no change to what the SDK or the service receives (bodies are never read ahead). The default CI path calls no real model (constitution IX). The values of spec FR-024 are byte-identical across the two helpers

**Scale/Scope**: Up to the adapter's `maxConcurrency` trials in parallel per process; 3 APIs, 2 providers, 2 languages, 11 SDK major versions

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Grade What the Service Actually Ships | PASS | The helper only observes calls the service already makes and never builds prompts. Raw is the first answer of the answer calls; `finalKind` follows the service's return, `fallback()` or a declared discard. `postprocess` is reported |
| II. No Conclusion From a Single Sample | PASS | No statistics here. Failures caused by evaluation load are classified `transient` so they leave denominators instead of counting against the candidate |
| III. Deterministic Checks First | PASS | Not affected |
| IV. People Set Policy, the Tool Shows Evidence | PASS | Ambiguous cases (which call is the answer, which tool carries it, which exceptions are discards) are declared by the adapter author, not decided by the helper |
| V. Real User Data Stays Out of the Repository | PASS | The example service and fixtures are synthetic. Service output goes to stderr, which the tool redacts (001 FR-031) |
| VI. Same Records, Same Conclusion | PASS | `treeHash`, helper version and render fingerprints are recorded. Both helpers produce the same bytes (D8) |
| VII. Know the Cost Before Starting, Stay Under the Cap | PASS | Every captured call is reported with its usage, or as `unanswered` so the tool charges a reservation; calls after the function returned are reported through `calls` notifications |
| VIII. Humans and Agents Read the Same Result | PASS | Helper messages and warnings are English sentences inside the protocol result and the comparison JSON (D11) |
| IX. Every Requirement Has a Test | PASS | Contract tests carry `003 FR-###` and run against mock API servers; CI calls no model |
| X. Stay Small | PASS | No runtime dependency in either helper |

Re-checked after Phase 1 design (data-model, contracts): no change.

## Project Structure

### Documentation (this feature)

```text
specs/003-adapter-helpers/
├── spec.md
├── plan.md              # This file
├── research.md          # R1–R14
├── data-model.md        # Calls, branches, answers, outcome decision, service version, mappings, known limits
├── quickstart.md        # Example service, test commands, connecting a service, troubleshooting
├── contracts/
│   ├── helper-api.md        # Python and TypeScript API, capture, errors, render, what the adapter reports, messages, SDKs
│   └── helper-scenarios.md  # Expected results of the contract, parity and uncaptured-call scenarios
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks), not created by /speckit.plan
```

### Source Code (repository root)

```text
src/helper/
├── index.ts          # model-eval/adapter: defineAdapter, fallback, result, ModelCallError
├── protocol.ts       # stdio JSON-RPC server: initialize, render, generate, cancel, shutdown, calls, log
├── capture.ts        # globalThis.fetch wrapper, pass-through body stream, SSE end markers
├── context.ts        # AsyncLocalStorage trial contexts, requests outside a context, after-return waiting
├── outcome.ts        # branches, answers, outcome decision, raw-given checks, failure matching
├── errors.ts         # error table, transport causes, retryAfterMs
├── render.ts         # render mode and normalisation
├── stdout.ts         # stdout protection
└── service.ts        # version, dirty, treeHash

adapters/python/
├── model_eval_adapter.py   # the whole Python helper, standard library only
├── tests/                  # pytest contract tests
└── mock_api/               # mock OpenAI and Anthropic API servers (responses, errors, SSE, compression, fixtures)

examples/python-service/    # small service that uses the OpenAI SDK, with its helper adapter (SC-001, SC-004)
test/contract/helper/       # vitest contract tests for the TypeScript helper against the same mock API servers
test/fixtures/helper/       # recorded responses and parity cases shared by both helpers
```

**Structure Decision**: The TypeScript helper lives in `src/helper/` and is exported as the `model-eval/adapter` subpath, a layer on top of the protocol types in `src/adapter/` (001 plan). The Python helper is one file in `adapters/python/`, packaged with the tool so `init --adapter python` can copy it. Both test suites read the same fixtures in `test/fixtures/helper/`, so a rule cannot drift between languages without a failing test.

## Design Decisions

### D1. Two helpers with one API

Python and TypeScript helpers expose the same options, return values and errors under each language's naming convention ([contracts/helper-api.md](contracts/helper-api.md)). `init --adapter python|node` creates an adapter skeleton that uses them (001 FR-033). Other languages use the protocol directly. See research R1.

### D2. Capture at the HTTP client layer

Python wraps `Client.send` and `AsyncClient.send` of `httpx2` and `httpx` at class level, immediately for loaded modules and through an import hook for later ones, without importing them. Node wraps `globalThis.fetch`, so the helper import goes before the service's SDK clients are created. Requests are matched by POST, path suffix and a JSON body with `model`. See research R2 and R3.

### D3. Never change what the service receives

Bodies are read only as the SDK reads them: Python copies from the wrapped byte stream, Node hands the SDK a pass-through stream with highWaterMark 0. Signals, status, headers and `url` pass through unchanged. Stream content is not parsed; end events and generation-end markers are read before each chunk is handed on. See research R4 and [helper-api §Reading Response Bodies](contracts/helper-api.md#reading-response-bodies).

### D4. Fixed outcome rules, adapter declarations for what the helper cannot see

The trial result follows [data-model §Outcome Decision](data-model.md#outcome-decision) and, when the adapter gives raw, [data-model §When the Adapter Gives Raw](data-model.md#when-the-adapter-gives-raw). The helper never guesses between several same-model branches, never counts an undeclared exception as a discard, and never records an empty raw answer for a call it did not capture. The adapter fills the gaps with `reply_call`, `answer_tool`, `discard_on`, `Result` and `ModelCallError`, and helper warnings flag combinations that look wrong. See research R5, R6, R10 and R14.

### D5. Render mode runs the service with captured requests blocked

Every captured request gets a non-retried HTTP 400 `render_only`, and the first answer-candidate request is normalised into the protocol's `render` shape. Adapter-supplied render results are normalised the same way. See research R7.

### D6. stdout protection at import

Python swaps file descriptors; Node redirects JavaScript-level output and relies on the tool's contamination detection for the rest. See research R8.

### D7. Distribution

The Python helper is one standard-library file copied by `init --adapter python`, with the helper and protocol versions in its header; `lint` reports `helper-outdated` when the tool bundles a newer one. The TypeScript helper ships with the tool package. Both report `adapter.helper` in `initialize`. See research R12.

### D8. Byte parity between the helpers

Text trimming, canonical JSON, `retry-after` parsing, decompression, SSE parsing and `treeHash` path order follow rules written out in the contracts, not each language's standard functions. Parity scenarios run the same fixtures through both helpers. See research R13.

### D9. Service version by content

`version`, `dirty` and `treeHash` describe `service_dir` minus the tool's files, so rule edits never block a resume and a commit alone does not change the service identity. See research R11 and [data-model §Service Version](data-model.md#service-version).

### D10. Contract tests against mock API servers

One mock server, `adapters/python/mock_api/server.py`, answers both the OpenAI and the Anthropic paths; tests start as many instances as they need (plain and TLS). It imitates OpenAI and Anthropic responses and error formats and is selected with `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`, so no service code changes and no real model is called. The matrix is language × SDK and major version × API × Python sync, async and aiohttp backend, with the scenarios of [contracts/helper-scenarios.md](contracts/helper-scenarios.md). CI runs it for every supported SDK major version on each push to main and, on pull requests, for one release of each SDK on the lowest and the newest runtime, and a weekly scheduled job runs it against each SDK's latest release.

### D11. Helper messages are English sentences

Helper adapter error messages (A1–A16), failure messages (F1–F3), trial warnings (W1–W10) and log warnings (L1–L3) are English sentences whatever `--lang` says, because the adapter process writes them into trial records and logs, which are language-independent data. The tool's own messages follow `--lang` (001 plan D11). See [helper-api §Messages](contracts/helper-api.md#messages).

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| An SDK changes its default transport or its response JSON (for example the Python SDKs' move from httpx to httpx2) | The helper misses calls | Contract tests per supported SDK major version, and a weekly scheduled job against the latest releases. Uncaptured calls end as adapter errors, never as empty raw answers |
| Providers change the shape of quota and billing errors | Classified as `permanent`, so the candidate looks worse; or `transient`, so the run stops on the transient rate | Known shapes in contract tests; typical messages per error kind on the result page and a dominant message first in the gate reason (research R9) |
| The service calls the same model for more than the answer | Side-call output graded as raw | Several branches are an adapter error until `reply_call` is set; answers from branches with different systems are an error; render fingerprint compared with the first-answer request (`render-mismatch`) |
| The service streams its answer | Stream calls are charged reservations and the run can stop at the default cap | `Result(raw=, finish_reason=, usage=)`; troubleshooting entry A5 in quickstart |
| The two helpers decide differently on the same service | Results depend on the adapter language | Rules written out in the contracts; parity scenarios on shared fixtures (SC-003) |
| A copied Python helper falls behind the tool | Old classification or outcome rules | Version in the file header and in `initialize`; `helper-outdated` lint warning |
| The service hands work to threads without the trial context | Calls cannot be tied to a trial | One trial in progress takes the call; two or more end as adapter errors with the advice to run with `--concurrency 1` |
