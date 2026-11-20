# Tasks: Adapter Helpers

**Input**: Design documents from `/specs/003-adapter-helpers/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md; feature 001's contract freeze (001 T022, T023), adapter client, `lint` and `init`

**Tests**: Required (constitution IX). Every test name carries `003 FR-###` or `003 SC-###` for the requirement it checks: vitest names as written, pytest function names as `test_003_FR_###_…` (T003 reads both). Tests call no model: they run against the local mock API servers, with dummy API keys.

**Organization**: Tasks are grouped by user story, in priority order: User Stories 1, 2 and 4 (P1) build the Python helper, User Story 3 (P2) the TypeScript helper. User Story 1 is the MVP: the Python helper connects the example Python service. Each task ends with the requirements it serves.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- Python helper: one file, `adapters/python/model_eval_adapter.py`. Its pytest tests are in `adapters/python/tests/`, scenario services in `adapters/python/tests/services/`, and the mock OpenAI and Anthropic API servers in `adapters/python/mock_api/`, laid out as [plan §Project Structure](plan.md#project-structure)
- TypeScript helper: `src/helper/`, built to `dist/helper/` and exported as `model-eval/adapter`. Its vitest contract tests are in `test/contract/helper/`, with Node scenario services in `test/contract/helper/services/` that import `model-eval/adapter` through the package's self-reference and load the SDK named by `MODEL_EVAL_SDK` (an alias of T001) with `await import(...)`
- Shared by both helpers: `test/fixtures/helper/`, holding `scenario.schema.json`, `scenarios/` (the mock server script and the expected result per scenario ID of [contracts/helper-scenarios.md](contracts/helper-scenarios.md), one file per test file that adds them, such as `scenarios/capture.json` for `test_capture.py`), `parity/`, `messages.json`, `recorded/` and `tls/`
- Example: `examples/python-service/`, tested by `test/example/python-service.test.ts` in its own vitest project `example`
- Processes the vitest tests spawn (Node scenario services, the CLI) run from `pnpm build` output, as in 001. pytest runs from `adapters/python/` in an environment built from one file of `adapters/python/tests/requirements/`
- A scenario row runs in both helpers unless it names one language. Rows, or the parts of rows, in which the target function returns `Result` or throws `ModelCallError` belong to User Story 4; §Side Calls rows S-SIDE-05 to S-SIDE-36 are tested whole in User Story 4, next to the reports they contrast with. The other rows belong to the story whose task lists them. Each row runs for every API it applies to and, in Python, under the sync, async and aiohttp backends (SC-002)
- Python services that need Python 3.11 (`asyncio.TaskGroup`, `except*`, `asyncio.timeout`) live in their own modules `adapters/python/tests/services/py311_*.py`, and their tests are marked `skipif(sys.version_info < (3, 11))`; on Python 3.10 every other row still runs
- Feature 001 owns `init --adapter` (001 T123, T124), `helper-outdated` and the bundled helper version `BUNDLED_HELPER_VERSION` in `src/lint/helper-version.ts` (001 T125); this feature supplies the helpers they use and keeps both helpers on that version

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Package entries, layout, SDK matrix and the coverage check for pytest names

- [ ] T001 Update `package.json` and `vitest.config.ts`: `exports` `./adapter` with types `./dist/helper/index.d.ts` and default `./dist/helper/index.js`; `files` adds `adapters/python/model_eval_adapter.py`; scripts `test:contract` and `test:parity` that build and then run vitest, checked so that `pnpm test:contract -- helper` reaches vitest as a file filter, as [quickstart.md](quickstart.md) runs them; a vitest project `example` for `test/example/`, run by a new script `test:example`, while `test` runs every other project (`unit`, `contract`, `e2e` and 002's `viewer`); development dependencies under the aliases `openai-5-first` (5.0.0), `openai-5`, `openai-6`, `openai-7` (last releases), `anthropic-sdk-0-first` (`@anthropic-ai/sdk` 0.50.1), `anthropic-sdk-0` and `anthropic-sdk-1` (last releases), per [helper-api §Supported SDKs](contracts/helper-api.md#supported-sdks); no entry added to `dependencies` (FR-025, SC-002)
- [ ] T002 [P] Create the layout of plan §Project Structure: `src/helper/{index,protocol,capture,context,outcome,errors,render,stdout,service}.ts` as empty modules; `adapters/python/model_eval_adapter.py` empty; `adapters/python/{tests,tests/services,tests/requirements,mock_api}/` and `adapters/python/pyproject.toml` with the pytest settings only; `test/contract/helper/{support,services}/`; `test/fixtures/helper/{scenarios,parity,recorded,tls}/`; `test/example/`; `examples/python-service/`; `.gitignore` entries for `.venv/` and `__pycache__/`, and `**/.venv/` in the ignores of `eslint.config.js` (plan §Project Structure)
- [ ] T003 [P] Extend `scripts/check-spec-coverage.ts` to read pytest tests in `adapters/python/tests/**/test_*.py`, and add a case for each rule below to `test/unit/check-spec-coverage.test.ts` (constitution IX):
  - Tests are `def test_…` and `async def test_…` functions at module level and in classes whose name starts with `Test`.
  - A name counts for every ID it carries: `NNN` followed by one or more `_FR_###` or `_SC_###` parts, so `test_003_FR_009_FR_010_x` counts for `003 FR-009` and `003 FR-010`. SC IDs are listed and not enforced, as for vitest names.
  - A test does not count when it, its class or its module is skipped: a `pytest.mark.skip` or `pytest.mark.xfail` decorator on the function or the class, or a module-level `pytestmark` that is or contains `pytest.mark.skip`. `pytest.mark.skipif` counts, as `skipIf` does for vitest.
  - 003 is among the checked features once T005 is done.
- [ ] T004 [P] Create `adapters/python/tests/requirements/` with one file per tested SDK release of helper-api §Supported SDKs: `openai` 1 and 2 (last releases, httpx), `openai` 3.0.0 and the last 3 (httpx2), `anthropic` 0 (last, httpx), `anthropic` 1.0.0, the last 1 and the last 2 (httpx2). Each file pins the SDK release (with its `aiohttp` extra) and `pytest`, and nothing else, so pip picks the transitive packages for each Python version. The `openai` 2 file (httpx) and the `anthropic` 2 file (httpx2) also install the decoder modules of their transport's `brotli` and `zstd` extras. `both-transports.txt` holds the last `openai` 2 with its `httpx2` extra and the last `anthropic` 1, so `httpx` and `httpx2` are installed together (S-UNC-02) (SC-002)
- [ ] T005 [P] Set `**Status**` in `specs/003-adapter-helpers/spec.md` to `In Progress`, so `scripts/check-spec-coverage.ts` requires a test for every FR of this feature (constitution IX)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The scenario fixture format, mock API servers, shared fixtures and test harnesses both helpers are tested against, and the values both helpers must produce byte for byte. Tests T012 to T014 are written first and fail before T015.

**CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T006 Define `test/fixtures/helper/scenario.schema.json` (JSON Schema 2020-12) and `test/unit/helper/scenario-fixtures.test.ts`, which validates every file of `test/fixtures/helper/scenarios/` against it with ajv. A fixture file maps scenario IDs to one or more cases; a case has a name (the part of the row it checks), the languages, APIs, backends and SDK aliases or requirements files it applies to (all when absent), the service behaviour and its parameters, the target options as data, the mock server script per request in send order (status, headers, JSON body or SSE events with chunking and delays, compression, connection behaviour), and `expect`: the fields of the `generate` result the row names (status and error kind, `finalKind`, `raw`, `final`, `answers`, `finishReason`, `discardReason`, `fingerprint` equal to the render fingerprint, adapter error ID and warning IDs with the values of their placeholders, per-call `model`, `outcome`, `branch`, `errorKind` and `retryAfterMs`), `calls` and `log` notifications, and the requests the mock server received. Add one example fixture per API (Chat Completions, Responses, Messages) in `test/fixtures/helper/scenarios/example.json` (SC-002)
- [ ] T007 [P] Implement the mock API server in `adapters/python/mock_api/server.py`, standard library only: POST `/v1/chat/completions`, `/v1/responses` and `/v1/messages` with OpenAI and Anthropic response and error bodies; a script per request in the format of T006, loaded through a control path the helpers never capture (status, headers including `retry-after` and `retry-after-ms`, JSON body, SSE events with per-chunk delays and several events per chunk, gzip, br and zstd bodies stored pre-compressed and sent only when the request's `accept-encoding` names them, delay before headers, holding a response, chunks by index, or the rest of a stream after a text until a number of requests arrived, matching by request headers, close without a response, drop mid-body, no final empty line or line end, TLS with the certificates of T008); `--port`; a request log readable through the control path and printed by `--log`. With no script loaded it runs an example mode, added by T037 ([quickstart.md](quickstart.md) Prerequisites; plan D10). `adapters/python/tests/test_mock_api.py` checks the server on its own with the standard library's HTTP client, so a broken server is not mistaken for a helper bug: each listed behaviour, including that an encoding is served only when `accept-encoding` names it, per-chunk delays arrive as separate chunks, and each certificate of T008 gives its expected verification result (FR-005, SC-002)
- [ ] T008 [P] Create test certificates in `test/fixtures/helper/tls/` with `test/fixtures/helper/tls/make.sh` (openssl), which states the validity of each: a root, an intermediate and server certificates valid for 50 years; a self-signed one; one for another hostname; an expired one with a fixed validity range in the past; and a chain whose intermediate the server does not send. Commit the output (S-CONN-01) (FR-017)
- [ ] T009 [P] Create `test/fixtures/helper/messages.json`: every message ID of [helper-api §Messages](contracts/helper-api.md#messages) (adapter errors A1 to A16, failure messages F1 to F3, trial warnings W1 to W10, log warnings L1 to L3), each with its sentence as fixed there, its variants (the "The target function raised <exception>." forms of A1, A2 and A3; the A2 form for `Result(model=)`; the four A3 causes and the three raw-given A3 sentences; the Outcome row 9 message with its `discard_on` guidance; the W5 and W6 forms when §Cut Last Answer decided, with the regeneration sentence; the W6 forms with `stopped_early` ignored and honoured) and its placeholders marked, including `<models>` as `none`; both helpers' tests read it (FR-020, plan D11)
- [ ] T010 Implement the Python test harness: `adapters/python/tests/conftest.py` starts the mock servers of T007 on free ports, sets `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` to them and `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` to fixed dummy values, replacing any inherited values, and fails before spawning an adapter when a base URL is not a loopback address; it loads `test/fixtures/helper/scenarios/` and parametrises each case by the installed SDK and major version, API and backend (sync, async, aiohttp). `adapters/python/tests/protocol_client.py` spawns an adapter from `adapters/python/tests/services/`, speaks JSON-RPC over its stdio, fails on any stdout line that is not JSON, collects `calls` and `log` notifications and stderr, and compares results with `expect` as the Notes say. `adapters/python/tests/test_harness.py` checks the harness's own safeguards, since no later test takes their failure paths: non-loopback base URLs refused and loopback ones accepted, inherited keys replaced and proxy and token variables removed, a non-JSON stdout line failing the trial (FR-001, SC-002)
- [ ] T011 [P] Implement the vitest harness in `test/contract/helper/support/`: `driver.ts` spawns a Python adapter or a Node service of `test/contract/helper/services/` with `MODEL_EVAL_SDK` set, sends `initialize`, `render`, `generate`, `cancel` and `shutdown`, and validates every message with the schemas of `src/adapter/protocol.ts`; it sets the base URLs and dummy API keys and refuses non-loopback base URLs as T010 does; Python adapters run with the interpreter of `MODEL_EVAL_PYTHON` (default `python3`), which must belong to an environment built from a file of `adapters/python/tests/requirements/`, and a test fails with a message saying so when the SDK is missing there; `mock-api.ts` starts and stops the server of T007; `scenarios.ts` loads `test/fixtures/helper/scenarios/` and runs each Node case for every SDK alias in `MODEL_EVAL_NODE_SDKS` (all aliases of T001 when unset). `test/unit/helper/harness.test.ts` checks the same safeguards as T010's and the missing-SDK message (FR-001, SC-002)
- [ ] T012 [P] Write the shared value vectors in `test/fixtures/helper/parity/values.json` (whitespace at either end with U+FEFF, U+0085 and U+001F and emptiness; canonical JSON of `1.0`, `1e-07`, `-0.0`, an integer above 2^53, keys U+FF01 and U+1F600, lone surrogates; JSON text that is not JSON, `NaN` and `1e400`; discard reasons over 200 code points with emoji; `retry-after-ms` and `retry-after` values of S-PAR-09, S-PAR-10 and S-PAR-12 with a fixed "now"), and `test/unit/helper/values.test.ts`, which checks the whitespace and canonical JSON vectors against `src/adapter/canonical-json.ts` and `isEmptyText` of `src/grade/outcome.ts`, so the fixture agrees with the tool ([data-model §Comparing Text](data-model.md#comparing-text), [001 data-model §Canonical JSON](../001-swap-check/data-model.md#canonical-json), [helper-api §`retryAfterMs`](contracts/helper-api.md#retryafterms)) (FR-024)
- [ ] T013 Write `adapters/python/tests/test_values.py`: the Python helper's whitespace trimming, emptiness, canonical JSON writing and reading, `sha256:` hashing, discard reason truncation and `retry-after` reading give the expected values of `test/fixtures/helper/parity/values.json` (S-PAR-01 to S-PAR-06, S-PAR-09, S-PAR-10, S-PAR-12) (FR-024)
- [ ] T014 [P] Write `test/unit/helper/version.test.ts`: the header of `adapters/python/model_eval_adapter.py` declares `HELPER_VERSION` equal to `BUNDLED_HELPER_VERSION` of `src/lint/helper-version.ts` and `PROTOCOL_VERSION` equal to `PROTOCOL_VERSION` of `src/adapter/protocol.ts`, read from the file as text ([helper-api §Distribution](contracts/helper-api.md#distribution), [001 data-model §Validation Rules](../001-swap-check/data-model.md#validation-rules), Bundled helper version) (FR-004, FR-025)
- [ ] T015 Implement in `adapters/python/model_eval_adapter.py` the file header with `HELPER_VERSION` and `PROTOCOL_VERSION`, the 25 `White_Space` code points and the trimming and emptiness built on them, canonical JSON writing and reading per 001 data-model §Canonical JSON, `sha256:` hashing, discard reason truncation to 200 code points, and `retry-after` reading per helper-api §`retryAfterMs`, without the language's own trim, `json` number formatting or date parsing ([research R13](research.md#r13-make-both-helpers-produce-the-same-bytes)) (FR-004, FR-024)

**Checkpoint**: Fixture format, mock servers, fixtures and harnesses ready; the shared values agree with the tool. User story work can begin.

---

## Phase 3: User Story 1 - Connect a Python service without changing it (Priority: P1) MVP

**Goal**: An adapter written with the Python helper answers protocol v1, captures the service's OpenAI and Anthropic calls on httpx and httpx2, and derives raw answer, shipped text, tokens, finish reason and error kinds by the fixed rules, with stdout protected and the service version reported.

**Independent Test**: Connect the example Python service with an adapter of at most 30 lines and run the swap check on the example cases against the mock API server. It finishes without calling a real model.

### Tests for User Story 1

> Write these tests first and make sure they fail before the implementation.

- [ ] T016 [P] [US1] Write protocol tests in `adapters/python/tests/test_protocol.py` per [helper-api §Python](contracts/helper-api.md#python-model_eval_adapterpy), §Adapter Options, §Target Options and §Target Function: the `initialize` result (`adapter` name and version, `adapter.helper` `{language: "python", version: HELPER_VERSION}`, `protocolVersion` `PROTOCOL_VERSION`, targets with languages and input schemas, `capabilities.stages` and `cancel` true, `render` as declared, `postprocess` default true and false when set, `maxConcurrency`); the `initialize` part of S-RESP-15 (`capabilities.render` and `capabilities.postprocess` true for mixed targets); concurrent `generate` requests answered in any order and matched by `id`; synchronous targets through `asyncio.to_thread` and asynchronous targets; `case` and `variant` fields; the third argument with the call fields of §Target Function; `shutdown` (FR-001, FR-004)
- [ ] T017 [P] [US1] Write stdout tests in `adapters/python/tests/test_stdout.py` per [helper-api §stdout Protection](contracts/helper-api.md#stdout-protection): `print`, `os.write(1, …)` and a child process's output go to stderr; protocol lines stay intact; output printed while the service module is imported after the helper goes to stderr; the `print` part of S-RESP-09 (acceptance scenario 4) (FR-002)
- [ ] T018 [P] [US1] Write service version tests in `adapters/python/tests/test_service_version.py` per [data-model §Service Version](data-model.md#service-version), each in a temporary git repository: S-RV-04 to S-RV-07 and S-RV-09 to S-RV-19 (S-RV-08 needs both helpers and is T070's; the non-UTF-8 names of S-RV-13 on Linux only, since macOS file systems refuse them); the full SHA of 40 characters, and 64 in a SHA-256 repository; `dirty`; `treeHash` equal to a value the test builds itself from the bytes of data-model §`treeHash` step 5 over the files it wrote; a relative `service_dir` resolved from the adapter's working folder; none of the three without `service_dir`; log warning L1 when a part fails (FR-003)
- [ ] T019 [P] [US1] Write capture tests in `adapters/python/tests/test_capture.py` per [helper-api §Captured Requests](contracts/helper-api.md#captured-requests) and §Reading Response Bodies: S-UNC-01, S-UNC-02, S-UNC-03, S-UNC-05, S-UNC-07; S-RESP-01; POST, path suffix and body `model` matching, also behind a changed `base_url`, with every other request untouched; `httpx` and `httpx2` absent from `sys.modules` after the helper import; an SDK imported inside the service function is captured; S-CONN-22; the Python part of S-PAR-07, `with_streaming_response` included, taking the expected encodings from the `accept-encoding` each request sent, as the mock server log shows it, and asserting that each advertised encoding was served and decoded, and that br and zstd were both exercised in the environments of T004 that install the decoders; a `stream=False` caller gets the whole body and a closed response on a read failure (acceptance scenario 1) (FR-005, FR-012, SC-005)
- [ ] T020 [P] [US1] Write call record tests in `adapters/python/tests/test_records.py`: per-call fields of [data-model §Captured Call](data-model.md#captured-call) in send order with latency (S-RESP-18); [§Usage Buckets](data-model.md#usage-buckets) for the three APIs on synthetic responses, with W9 and 0 for a negative difference (S-PAR-08); every row of [§Finish Reasons](data-model.md#finish-reasons) and its Responses tool-call items (S-RESP-05); [§Call Outcome](data-model.md#call-outcome) for each failure shape; `retryAfterMs` on failed calls; `branch` absent under Outcome rows 4 and 5 (FR-007, FR-020)
- [ ] T021 [P] [US1] Write context tests in `adapters/python/tests/test_contexts.py` per [data-model §Outside the Trial Context](data-model.md#outside-the-trial-context) and [§After the Function Returned](data-model.md#after-the-function-returned): helper-scenarios §Contexts rows S-CTX-01 to S-CTX-11 and S-CTX-18 to S-CTX-24, without the throwing parts of S-CTX-19 and S-CTX-20; S-RESP-10; the wait ending at `timeoutMs` minus the time spent minus 5 s; requests sent after the result as `calls` notifications; log warning L2 (FR-006, FR-008, FR-015)
- [ ] T022 [P] [US1] Write answer tests in `adapters/python/tests/test_answer_calls.py` per [data-model §Call Branches](data-model.md#call-branches), §Answers and §Raw Cannot Be Determined: helper-scenarios §Answer Calls rows S-ANS-01 to S-ANS-16, S-ANS-18, S-ANS-19, S-ANS-21 to S-ANS-24, the run part of S-ANS-25, S-ANS-26 to S-ANS-28 without raw, S-ANS-30 to S-ANS-37 and S-ANS-42 to S-ANS-46; S-RESP-03, S-RESP-04, S-RESP-06, S-RESP-12 (A6), S-RESP-16; each of the A3 causes (a) to (d) of [helper-api §Adapter Error Messages](contracts/helper-api.md#adapter-error-messages); warning W1 in both forms (a variant model call, S-ANS-36; another model's call, S-ANS-33), W2 and W3; acceptance scenarios 10 and 11 (FR-009, FR-010, FR-012, FR-014, FR-015, FR-016, FR-020)
- [ ] T023 [P] [US1] Write outcome tests in `adapters/python/tests/test_outcome.py` per [data-model §Outcome Decision](data-model.md#outcome-decision): each of Outcome rows 1 to 9, row 3 when only (b) holds, the row 5 exception; S-RESP-07, S-RESP-08, S-RESP-13, S-RESP-14 (non-text return, A14), S-RESP-17 (decision failure, A16); S-EXC-01, S-EXC-02; §Side Calls rows S-SIDE-01 to S-SIDE-03 and S-SIDE-38 to S-SIDE-40, and the parts of S-SIDE-04, S-SIDE-09 and S-SIDE-37 without `Result` or `ModelCallError`; `discard_on` as a list of classes and as a function; `discardReason` from `type(e).__name__` and `str(e)`; `capturedRaw`; the "The target function raised <exception>." forms of A1, A2 and A3 and the Outcome row 9 message, A14 and A16, with the whitespace and period rules of `<exception>`; acceptance scenarios 2, 3 and the run part of 8 (A2) (FR-011, FR-012, FR-013, FR-014)
- [ ] T024 [P] [US1] Write error tests in `adapters/python/tests/test_status_codes.py` and `adapters/python/tests/test_connections.py` per [helper-api §Error Classification](contracts/helper-api.md#error-classification) and §Transport Exceptions: every row of helper-scenarios §Status Codes; §Connections and Time rows S-CONN-01 to S-CONN-19, S-CONN-21 and S-CONN-23 to S-CONN-27 (Python parts) on the httpx and httpx2 default transports and the aiohttp backend; acceptance scenarios 6 and 7 (FR-007, FR-017)
- [ ] T025 [P] [US1] Write cancel tests in `adapters/python/tests/test_cancel.py` per [helper-api §Cancel](contracts/helper-api.md#cancel): S-RESP-11, S-COST-09; one failure result per cancelled trial, sent as soon as the function has ended and at once for a `cancel` during the wait after it returned: `config` with that call's failure when a `config` failure was seen, else `timeout` with F2, calls not ended joined as `unanswered` at the call reservation; cut calls `unanswered` and unclassified; later captured requests of that trial fail as never arrived and appear neither in `calls` nor in notifications; a synchronous target runs to its end and an asynchronous one is cancelled; log warning L3 (FR-023)
- [ ] T026 [P] [US1] Write message tests in `adapters/python/tests/test_messages.py`: every A, F, W and L message User Story 1 emits equals its sentence in `test/fixtures/helper/messages.json` with the placeholders filled as helper-api §Messages fixes, in English whatever the tool's `--lang`; a trial that carries a warning has the outcome of the same trial without the warning's condition. The messages of the `Result`, `ModelCallError` and render paths are added to `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` by T038 and T043 to T047 (FR-020)
- [ ] T027 [P] [US1] Write distribution tests in `adapters/python/tests/test_distribution.py` per helper-api §Distribution: `model_eval_adapter.py` imports and answers `initialize` under `python3 -I -S` with no site packages; after the import, `sys.modules` holds only modules of `sys.stdlib_module_names` besides the helper (FR-025)
- [ ] T028 [P] [US1] Write the example test in `test/example/python-service.test.ts`, using `examples/python-service/.venv` created as in quickstart.md Prerequisites (missing, the test fails with that command), with the mock API server of T007, `OPENAI_BASE_URL` set to it and `OPENAI_API_KEY` set to a dummy value, replacing inherited ones: `adapter.py` has at most 30 lines and no file under `examples/python-service/service/` imports the helper or changes during the test (SC-001); `swap --from current --to next` ends with exit 0 or 1, every trial is `ok` with `raw`, `usage`, `finishReason` and `calls` filled, and the server received requests only from the adapter ([quickstart §Verify: Example Python Service](quickstart.md#verify-example-python-service-sc-001-sc-004) steps 1 and 3) (SC-001, SC-004)

### Implementation for User Story 1

- [ ] T029 [US1] Implement stdout protection in `adapters/python/model_eval_adapter.py` at import: duplicate descriptor 1 for protocol output and point descriptor 1 at stderr (FR-002)
- [ ] T030 [US1] Implement the protocol server and public API in `adapters/python/model_eval_adapter.py`: `Adapter(name, version, service_dir, max_concurrency)`, `@adapter.target(...)` with the options of helper-api §Target Options, `adapter.run()`, `fallback`; line-based JSON-RPC on the kept descriptor, `initialize` with `adapter.helper` `{language: "python", version: HELPER_VERSION}`, concurrent `generate` matched by `id`, synchronous targets through `asyncio.to_thread`, the third argument, `log` and `calls` notifications, `shutdown` per [001 adapter-protocol §Transport](../001-swap-check/contracts/adapter-protocol.md#transport) (FR-001, FR-004)
- [ ] T031 [US1] Implement the service version in `adapters/python/model_eval_adapter.py` per data-model §Service Version: `toolPaths` identity by `lstat` and `stat` device and inode, the fixed `git status` options, `treeHash` paths as bytes sorted by bytes, kinds from `lstat`, nested repositories, git environment variables of `git rev-parse --local-env-vars` removed, none reported on any failure with L1 (FR-003)
- [ ] T032 [US1] Implement capture in `adapters/python/model_eval_adapter.py`: class-level wrapping of `Client.send` and `AsyncClient.send` of `httpx` and `httpx2` for loaded modules and through an import hook, once when aliased; request matching; `send` with `stream=True` for header arrival; the wrapped byte stream that copies what the SDK reads, decoded with a new decoder of the response's kind; SSE line splitting, end events and generation-end markers updated before each chunk is handed on; awaited reads and body closing tracked per helper-api §Reading Response Bodies and [§End Events](contracts/helper-api.md#end-events) (FR-005, FR-007)
- [ ] T033 [US1] Implement trial contexts in `adapters/python/model_eval_adapter.py`: `contextvars` per trial, requests outside a context per data-model §Outside the Trial Context (adapter error A10 with two or more trials in progress), unfinished calls awaited after the function returned with one `asyncio.sleep(0)` before the reading check, late and later requests as `calls` notifications, waiting at `shutdown`, L2 for unhandled asyncio task exceptions (FR-006, FR-008)
- [ ] T034 [US1] Implement error classification in `adapters/python/model_eval_adapter.py`: the table of helper-api §Error Classification on status, error `type`, code and message; the transport cause along `__cause__` and `args`, not `__context__`, with `ssl.SSLCertVerificationError` as the certificate row; header arrival for not-reached, before-headers and mid-body; call `outcome` per data-model §Call Outcome; `retryAfterMs` (FR-007, FR-017)
- [ ] T035 [US1] Implement the outcome in `adapters/python/model_eval_adapter.py`: variant model calls, call branches, answer candidate calls with `reply_call` and `answer_tool`, answers and first answer, successful calls and unrecovered failures, Outcome rows 1 to 9 with the row 3 and row 5 exceptions and §Outcome Row 6 Details, §Raw Cannot Be Determined, [§Derived Result Fields](data-model.md#derived-result-fields), usage buckets and finish reasons, warnings W1, W2, W3 and W9, and every message of helper-api §Messages embedded as constants equal to `test/fixtures/helper/messages.json`, never read from it at run time (FR-007, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-020)
- [ ] T036 [US1] Implement cancel in `adapters/python/model_eval_adapter.py`: cut the trial's calls as `unanswered`, cancel asynchronous targets, fail that context's later captured requests before sending without recording or notifying them, L3 (FR-023)
- [ ] T037 [P] [US1] Create the example in `examples/python-service/`: `service/`, a small synthetic chat service that calls Chat Completions through the OpenAI SDK with prompts holding every anchor of `examples/pogo/rules/`, creating its client with `base_url` from `OPENAI_BASE_URL` (default the loopback address of quickstart.md) and `api_key` from `OPENAI_API_KEY` (default a fixed dummy value); `adapter.py` of at most 30 lines with the helper import above the service import; `requirements.txt`; `model-eval.config.yaml` with `files` globs reading `../pogo/rules` and `../pogo/cases`, variants `current` (`model-a`) and `next` (`model-b`) with prices, `adapter.command` `[.venv/bin/python, adapter.py]` and `adapter.env` `PYTHONPATH: ../../adapters/python`; and the example mode of `adapters/python/mock_api/server.py`, its default when no script is loaded, which answers every Chat Completions request with a short fixed reply per model in the script of the last user message, with usage (SC-001, SC-004)

**Checkpoint**: The Python helper connects the example service.

---

## Phase 4: User Story 2 - Render the production prompt without a model call (Priority: P1)

**Goal**: `lint --render` gets the assembled prompt by running the service function in render mode, with every captured request blocked, and `generate` results carry fingerprints that compare directly with the render fingerprint.

**Independent Test**: Run `lint --render` on the example Python service against the mock API server. Lint passes and the server received no request.

### Tests for User Story 2

> Write these tests first and make sure they fail before the implementation.

- [ ] T038 [P] [US2] Write render tests in `adapters/python/tests/test_render.py` per [helper-api §Render Mode](contracts/helper-api.md#render-mode): items 1 to 3; each rule of the render result on Chat Completions, Responses and Anthropic requests (system first, roles kept, text parts joined with `\n`, non-text parts as `[image]`, `[file]`, `[audio]`, tool-call, tool-result and reasoning parts as canonical JSON lines, non-message input items, a string `input`, Anthropic system blocks, a Responses `prompt` placed after the leading system and developer messages); `maxOutputTokens` from each of the three keys; every captured request, outside a context and to other models included, gets one non-retried HTTP 400 `render_only` without an `x-should-retry` header and the mock server log stays empty; `case.rendering` with repeat 0; a `render` function and `@adapter.render` normalised the same way; the render target with `reply_call`; S-RV-01 to S-RV-03, S-RV-20, S-RV-21, S-CTX-25, the render part of S-RESP-09 and of S-RESP-15 (A15), the lint part of S-ANS-25, S-ANS-29; the render part of User Story 1 acceptance scenario 8 (A11, so lint reports `render-failed`); acceptance scenarios 1 to 6; the A11 and A15 messages in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` (FR-021)
- [ ] T039 [P] [US2] Write fingerprint tests in `adapters/python/tests/test_fingerprint.py` per data-model §Derived Result Fields `fingerprint`: taken from the first request of the branch that produced the first answer, the first answer candidate request when there is no answer; equal to the render fingerprint in S-ANS-04; different when the service resent a modified request after the first failed (render-mismatch cause 1 of [helper-api §When the Render Target Differs From the Answer Request](contracts/helper-api.md#when-the-render-target-differs-from-the-answer-request)) (FR-022)
- [ ] T040 [P] [US2] Write `test/contract/helper/render-fingerprint.test.ts` with the driver of T011 on Python adapters: each render `fingerprint` equals `renderFingerprint` of `src/run/hashes.ts` called on that render's `messages` and `tools` with `fingerprint` removed, for renders with tools and without them (the tool hashes `tools: null`); the `generate` fingerprint of S-ANS-04 equals it (FR-021, FR-022)
- [ ] T041 [US2] Add to `test/example/python-service.test.ts`: `lint --render` in `examples/python-service` exits 0 and the mock server log is empty, and the swap of T028 raises no `render-mismatch` (quickstart.md §Verify: Example Python Service step 2) (FR-021, SC-004)

### Implementation for User Story 2

- [ ] T042 [US2] Implement render mode in `adapters/python/model_eval_adapter.py`: answer `render` by running the target with `case.rendering`, block every captured request with a non-retried 400 `render_only`, record the render target, build the render result whatever the function's end, normalise adapter-supplied render results, adapter error A11 when the target is not reached; and the `fingerprint` of `generate` results in the render shape (FR-021, FR-022)

**Checkpoint**: `lint --render` works on the example Python service.

---

## Phase 5: User Story 4 - Report what the helper cannot see (Priority: P1)

**Goal**: The adapter declares what the helper cannot see through `Result`, `ModelCallError`, `reply_call` and `answer_tool`, and the helper decides streamed, cut, uncaptured and reported trials by [data-model §When the Adapter Gives Raw](data-model.md#when-the-adapter-gives-raw) and [§Matching Reported Failures](data-model.md#matching-reported-failures), with warnings on values that look wrong.

**Independent Test**: Run the raw-given, stream and uncaptured-transport scenarios against the mock API servers and compare each trial's outcome with the expected one.

### Tests for User Story 4

> Write these tests first and make sure they fail before the implementation.

- [ ] T043 [P] [US4] Write tests in `adapters/python/tests/test_streaming_raw.py` for helper-scenarios §Streaming Services That Give Raw rows S-STR-01 to S-STR-16 (S-STR-09 with the same logic in Python) and S-STR-20 to S-STR-35, per data-model §Cut Streams views 1, 2, 3 and 5, §Failure Check, §No Searched Calls and §Cut Last Answer; warnings W5, W6 and W7, with W6 as the failure check decides it and as §Cut Last Answer decides it, and with `stopped_early` ignored (W7 attached) and honoured; acceptance scenarios 1 to 5; the W5, W6 and W7 messages in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` (FR-018, FR-019, FR-020)
- [ ] T044 [P] [US4] Write tests in `adapters/python/tests/test_regeneration_raw.py` for helper-scenarios §Regeneration in Streaming Services That Give Raw rows S-REGEN-01, S-REGEN-02 and S-REGEN-04 to S-REGEN-20, and the Python part of S-REGEN-03, per data-model §Answer Candidate Calls When Raw Is Given and §Cut Last Answer; W5 and W6 with the regeneration sentence when §Cut Last Answer decides; the raw-given A3 forms; these messages in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` (FR-018, FR-019, FR-020)
- [ ] T045 [P] [US4] Write tests in `adapters/python/tests/test_other_raw.py` for helper-scenarios §Other Raw-Giving Scenarios, S-UNC-06, and the `Result` parts of S-ANS-17, S-ANS-18, S-ANS-20, S-ANS-26 and S-ANS-38 to S-ANS-41, per data-model §Raw Call; the uncaptured-call exception; S-RAW-12 (A9); S-RAW-13 (the `final` defaults of a `Result` without `final`, and A14 for `final=None`); warnings W4 and W8; the A2 form for a `Result(model=)` that names another model; A7 with `<models>` `none` when no call was captured (S-RAW-11); acceptance scenarios 6 and 11, and acceptance scenario 9 of User Story 1 (S-RAW-03); the A2 `Result(model=)` form, A7, A9, W4 and W8 in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` (FR-018, FR-020, SC-005)
- [ ] T046 [P] [US4] Write tests in `adapters/python/tests/test_model_call_error.py` for every row of helper-scenarios [§`ModelCallError`](contracts/helper-scenarios.md#modelcallerror), per helper-api [§`ModelCallError`](contracts/helper-api.md#modelcallerror), [§The `call` Check](contracts/helper-api.md#the-call-check) and data-model §Matching Reported Failures: A12 also with `ValueError` in `discard_on`, S-MCE-26, S-MCE-27, A13, W10, `retry_after_ms` of -1 or NaN not recorded (S-PAR-11); acceptance scenario 7; A12, A13 and W10 in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py` (FR-017, FR-018, FR-020)
- [ ] T047 [P] [US4] Write tests in `adapters/python/tests/test_side_calls.py` for every part of helper-scenarios §Side Calls rows S-SIDE-05 to S-SIDE-36, reported and unreported (for example S-SIDE-05 not thrown, S-SIDE-10 not given, S-SIDE-36 not thrown and with `asyncio.wait_for`), and the parts of S-SIDE-04, S-SIDE-09 and S-SIDE-37 where the target function returns `Result` or throws, per helper-api [§Trials Stopped by Another Call's Failure](contracts/helper-api.md#trials-stopped-by-another-calls-failure) and [§Trials Stopped by a Parallel Check's Refusal](contracts/helper-api.md#trials-stopped-by-a-parallel-checks-refusal); the `asyncio.TaskGroup` and `except*` services of S-SIDE-06 and S-SIDE-07 in `py311_` modules; A8, also in `test/fixtures/helper/scenarios/messages.json` and `test_messages.py`; acceptance scenarios 8, 9 and 10 (FR-014, FR-015, FR-016, FR-018, FR-019)
- [ ] T048 [P] [US4] Write tests in `adapters/python/tests/test_cost.py` for helper-scenarios §Cost rows S-COST-01 to S-COST-08, and add to `adapters/python/tests/test_contexts.py` rows S-CTX-12 to S-CTX-17 and the throwing parts of S-CTX-19 and S-CTX-20, per data-model §Derived Result Fields `usage` and `calls` and helper-api [§Services That Stopped Waiting](contracts/helper-api.md#services-that-stopped-waiting) (FR-007, FR-015, FR-018)

### Implementation for User Story 4

- [ ] T049 [US4] Implement `Result` and `ModelCallError` in `adapters/python/model_eval_adapter.py` with the fields of helper-api [§`Result`](contracts/helper-api.md#result) and §`ModelCallError`, `kind="discarded"` treated like a `discard_on` exception, and adapter error A12 decided by the helper without consulting `discard_on` (FR-018)
- [ ] T050 [US4] Implement data-model §When the Adapter Gives Raw in `adapters/python/model_eval_adapter.py`: the order of checks, searched calls, the cut stream views and cut styles, the `answers=0` check (A8), the failure check, no searched calls, the raw call with the uncaptured call and its exception, answer candidate calls and fingerprint when raw is given, the finish-reason check (A9), the cut last answer, warnings W4 to W8 (FR-018, FR-019, FR-020)
- [ ] T051 [US4] Implement data-model §Matching Reported Failures in `adapters/python/model_eval_adapter.py`: the started-response, matching-failure and unfinished-call candidates, corrected and added calls with their `errorKind` and `outcome`, `config` from a thrown value, the `call` check (A13), W10 (FR-017, FR-018, FR-020)

**Checkpoint**: The Python helper is complete. The real integration of 001 T128 can start with it for a Python service (001 plan §Delivery step 3).

---

## Phase 6: User Story 3 - Connect a TypeScript service (Priority: P2)

**Goal**: A Node service connects with `model-eval/adapter`, using the same options and return values as in Python, and both helpers give the values of FR-024 byte for byte.

**Independent Test**: Run the contract scenarios against the TypeScript helper with the shared fixtures. Results match the Python helper byte for byte.

### Tests for User Story 3

> Write these tests first and make sure they fail before the implementation. Each test runs Node services of `test/contract/helper/services/` through the driver of T011 against the scenario fixtures the Python test tasks wrote, for every SDK alias of T001. Sub-cases with no Node form (the connection-pool wait time-out of S-CONN-02, S-CONN-07, S-CONN-19, the httpcore `WriteTimeout` of S-CONN-27, the aiohttp parts, the time limit firing while the SDK waits before resending in S-CTX-20, the integers written with a fraction (`2.0`, `1.0`, `300.0`) in S-ANS-18, S-RESP-09 and S-RV-26, and the mid-body read time-out from the SDK's time limit in S-MCE-13 and S-MCE-19) run only in Python. `JSON.stringify` writes such integers without the fraction. The Node SDK's `timeout` stops once the headers arrive, and the Node SDK does not resend after a body read failure, so the `bodyTimeoutMs` cases stand in for these scenes in Node.

- [ ] T052 [P] [US3] Write `test/contract/helper/protocol.test.ts`: the checks of T016 on the TypeScript helper per [helper-api §TypeScript](contracts/helper-api.md#typescript-model-evaladapter), with `defineAdapter({...}).listen()`, camelCase options and `generate(c, variant, calls)`; `adapter.helper` is `{language: "typescript", version: BUNDLED_HELPER_VERSION}` with the constant of `src/lint/helper-version.ts`, and `protocolVersion` equals `PROTOCOL_VERSION` of `src/adapter/protocol.ts` (FR-001, FR-004)
- [ ] T053 [P] [US3] Write `test/contract/helper/stdout.test.ts`: `process.stdout.write` and `console` output go to stderr and the protocol stays intact (acceptance scenario 3); a service that writes with `fs.writeSync(1, …)`, and a child process sharing descriptor 1, are reported by 001's `src/adapter/client.ts` as stdout contamination (acceptance scenario 4) (FR-002)
- [ ] T054 [P] [US3] Write `test/contract/helper/service-version.test.ts`: the checks of T018 on the TypeScript helper, with inode numbers read as `bigint` and paths ordered by `Buffer.compare` (FR-003)
- [ ] T055 [P] [US3] Write `test/contract/helper/capture.test.ts` per helper-api §Captured Requests and §Reading Response Bodies (Node): S-UNC-01, S-UNC-04 (adapter error A1 with its guidance), S-UNC-05, S-UNC-07; `node --import model-eval/adapter`; two copies of one SDK; a body stream that never reads ahead, passes cancellation and the request `signal`, keeps status, headers and `url`, and has no body for 204, 205 and 304; the Node part of S-PAR-07; acceptance scenarios 1 and 2 (FR-005, SC-005)
- [ ] T056 [P] [US3] Write `test/contract/helper/records.test.ts`: the checks of T020 on the TypeScript helper (FR-007, FR-020)
- [ ] T057 [P] [US3] Write `test/contract/helper/contexts.test.ts`: the rows of T021 on the TypeScript helper, with one `setImmediate` before the reading check and L2 for unhandled promise rejections (FR-006, FR-008, FR-015)
- [ ] T058 [P] [US3] Write `test/contract/helper/answer-calls.test.ts`: the rows of T022 on the TypeScript helper, S-RESP-12 (A6) included (FR-009, FR-010, FR-012, FR-014, FR-015, FR-016, FR-020)
- [ ] T059 [P] [US3] Write `test/contract/helper/outcome.test.ts`: the checks of T023 on the TypeScript helper, with `discardReason` and `<exception>` from `e.constructor.name` and `e.message`, and from `String(e)` for values that are not `Error` (FR-011, FR-012, FR-013, FR-014)
- [ ] T060 [P] [US3] Write `test/contract/helper/messages.test.ts`: the checks of T026 on the TypeScript helper (FR-020)
- [ ] T061 [P] [US3] Write `test/contract/helper/status-codes.test.ts` and `test/contract/helper/connections.test.ts`: the rows of T024 on the TypeScript helper, plus the Node parts of S-CONN-10 and S-CONN-23 and S-CONN-20; every code of the X509 certificate error code table of the Node `tls` documentation and `ERR_TLS_CERT_ALTNAME_INVALID` classified `config` (FR-017)
- [ ] T062 [P] [US3] Write `test/contract/helper/cancel.test.ts`: the checks of T025 on the TypeScript helper, with `cancel` aborting the trial's `fetch` calls (FR-023)
- [ ] T063 [P] [US3] Write `test/contract/helper/render.test.ts`: the checks of T038 to T040 on the TypeScript helper (FR-021, FR-022)
- [ ] T064 [P] [US3] Write `test/contract/helper/streaming-raw.test.ts`: the rows of T043 on the TypeScript helper, plus the Node-only rows S-STR-17 to S-STR-19 and the Node part of S-STR-09 on the SDK versions they name (FR-018, FR-019, FR-020)
- [ ] T065 [P] [US3] Write `test/contract/helper/regeneration-raw.test.ts`: the rows of T044 on the TypeScript helper, plus the Node part of S-REGEN-03 (FR-018, FR-019, FR-020)
- [ ] T066 [P] [US3] Write `test/contract/helper/other-raw.test.ts`: the rows of T045 on the TypeScript helper, S-RAW-12 (A9) included (FR-018, FR-020, SC-005)
- [ ] T067 [P] [US3] Write `test/contract/helper/model-call-error.test.ts`: the rows of T046 on the TypeScript helper (FR-017, FR-018, FR-020)
- [ ] T068 [P] [US3] Write `test/contract/helper/side-calls.test.ts`: the rows of T047 on the TypeScript helper, with `Promise.race` for the services that only stop waiting (FR-014, FR-015, FR-016, FR-018, FR-019)
- [ ] T069 [P] [US3] Write `test/contract/helper/cost.test.ts`: the rows of T048 on the TypeScript helper (FR-007, FR-015, FR-018)
- [ ] T070 [P] [US3] Write `test/contract/helper/parity.test.ts` with parity drivers `adapters/python/tests/services/parity.py` and `test/contract/helper/services/parity.mjs`: every row of [helper-scenarios §Two-Language Parity](contracts/helper-scenarios.md#two-language-parity) through both helpers, comparing raw answers, shipped texts, fingerprints, `treeHash`, discard reasons and `retryAfterMs` byte for byte with each other and with `test/fixtures/helper/parity/values.json`; S-RV-08 and S-RV-13; both helpers' render fingerprints equal `renderFingerprint` of `src/run/hashes.ts` on `{messages, tools}` without `fingerprint`; acceptance scenario 5 (FR-003, FR-022, FR-024, SC-003)
- [ ] T071 [P] [US3] Write `test/contract/helper/distribution.test.ts`: the `pnpm pack` tarball holds `dist/helper/index.js`, its types and `adapters/python/model_eval_adapter.py`; installed with an SDK into a temporary folder, `model-eval/adapter` exports exactly `defineAdapter`, `fallback`, `result` and `ModelCallError`; the static import graph of `dist/helper/index.js` reaches only `node:` built-ins and files under `dist/`, never `zod`, `ajv` or `yaml`; `package.json` `dependencies` are unchanged (FR-025)

### Implementation for User Story 3

- [ ] T072 [P] [US3] Move `JsonValue`, `JsonObject`, `isJsonArray` and `isJsonObject` from `src/adapter/json-value.ts` into a new zod-free `src/adapter/json-types.ts`, re-export them from `src/adapter/json-value.ts` so its importers do not change, and import them in `src/adapter/canonical-json.ts` from the new module, so the helper's runtime import chain holds no zod ([plan §Technical Context](plan.md#technical-context), Primary Dependencies) (FR-025)
- [ ] T073 [P] [US3] Implement stdout protection in `src/helper/stdout.ts`: at import, send `process.stdout.write` and `console` output to stderr and keep a writer for the protocol (FR-002)
- [ ] T074 [P] [US3] Implement the service version in `src/helper/service.ts` per data-model §Service Version, with `lstat` and `stat` `{ bigint: true }`, `Buffer` paths and `Buffer.compare` order (FR-003)
- [ ] T075 [P] [US3] Implement error classification in `src/helper/errors.ts`: the table of helper-api §Error Classification, the `cause` chain with the undici codes of §Transport Exceptions and the full X509 code list, call `outcome`, `retryAfterMs` (FR-007, FR-017)
- [ ] T076 [US3] Implement capture in `src/helper/capture.ts`: the `globalThis.fetch` wrapper installed at import, request matching, the pass-through body stream with highWaterMark 0 that copies what the SDK reads, SSE end events and markers updated before each chunk is handed on, awaited reads tracked through the request `signal` and the copy stream's cancel (FR-005, FR-007)
- [ ] T077 [US3] Implement trial contexts in `src/helper/context.ts` with `AsyncLocalStorage`: requests outside a context, unfinished calls, late and later requests, waiting at `shutdown`, L2 (FR-006, FR-008)
- [ ] T078 [US3] Implement the outcome in `src/helper/outcome.ts`: the rules of T035, T050 and T051 on the same fixtures, with `canonicalJson`, `parseJsonText` and `hashValue` of `src/adapter/canonical-json.ts`, and every message of helper-api §Messages embedded as constants equal to `test/fixtures/helper/messages.json` (FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-018, FR-019, FR-020, FR-024)
- [ ] T079 [US3] Implement render mode and normalisation in `src/helper/render.ts` per helper-api §Render Mode, and the `fingerprint` of `generate` results (FR-021, FR-022)
- [ ] T080 [US3] Implement the protocol server in `src/helper/protocol.ts` and the public API in `src/helper/index.ts`: `defineAdapter`, `fallback`, `result`, `ModelCallError`; `adapter.helper` `{language: "typescript", version: BUNDLED_HELPER_VERSION}` with the constant imported from `src/lint/helper-version.ts`; concurrent requests; `cancel` aborting the trial's `fetch` calls and blocking later ones, L3; the import order that installs stdout protection and the `fetch` wrapper before any service module (FR-001, FR-004, FR-023, FR-025)

**Checkpoint**: Both helpers pass the contract and parity scenarios. 001 T123 and T124 can build `init --adapter python` and `init --adapter node` on them.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: CI matrix, recorded fixtures, docs

- [ ] T081 Extend `.github/workflows/ci.yml` (SC-002, SC-003, SC-004). A push to main and a manual run take the full breadth below; a pull request takes the narrower one in brackets:
  - A Python job whose matrix is Python 3.10 and the newest Python 3 release × each file of `adapters/python/tests/requirements/`, with the `openai` 1 file on Python 3.13 instead of the newest release (helper-api §Supported SDKs) [`openai-2` and `anthropic-0` on 3.10, `openai-3`, `anthropic-2` and `both-transports` on the newest, so each SDK's httpx and httpx2 transport runs at one end of the supported Pythons], and `fail-fast: false`; each entry builds its environment and runs `python3 -m pytest -n 2` (pytest-xdist, pinned in every requirements file; two workers on four vCPUs leave room for each case's adapter process and the mock API server) in `adapters/python/`, with a 45-minute job limit; an `anthropic` file splits its tests over two entries and an `openai` file, with about twice the cases, over four, through `MODEL_EVAL_SHARD` (`i/n`, read by `adapters/python/tests/conftest.py`).
  - In the Node job on Node 22, 24 and 26 [22 and 26], an environment built from the `openai` 2 and `anthropic` 2 files of `adapters/python/tests/requirements/`, with `MODEL_EVAL_PYTHON` pointing at its interpreter, for the mock servers, the Python adapters and the parity drivers; the contract tests with every SDK alias on Node 22 [`openai-5-first` and `anthropic-sdk-0-first`] and `MODEL_EVAL_NODE_SDKS` set to `openai-7` and `anthropic-sdk-1` on the other versions. Checks that do not depend on the Node version (typecheck, lint, format, spec coverage, the SC-003 simulation, the package checks) run on Node 22 only.
  - After the Python job, a step that collects the pytest results of every matrix entry and fails when a scenario ID of `test/fixtures/helper/scenarios/` ran in no entry, so a filter bug that skips a case everywhere is caught (pytest marks an empty parameter set as skipped, `empty_parameter_set_mark = "skip"` in `adapters/python/pyproject.toml`).
  - A separate step that creates `examples/python-service/.venv` and runs `vitest run --project example` with `timeout-minutes: 5`, so the 3-minute limit of 001's example step (SC-001) keeps its meaning.
  - A concurrency group per ref that cancels a pull request's earlier run when a new commit arrives.
- [ ] T082 [P] Create `.github/workflows/helper-sdk-latest.yml`: a weekly scheduled run of both helpers' contract tests against the latest release of each SDK, installed without the lockfile and the pins of `adapters/python/tests/requirements/` ([plan D10](plan.md#d10-contract-tests-against-mock-api-servers)) (SC-002)
- [ ] T083 (manual, needs real keys, not for agents) Record OpenAI Chat Completions and Responses responses that report cache hits and cache writes, with synthetic prompts, into `test/fixtures/helper/recorded/`, removing response IDs and organisation headers (constitution V) (FR-007)
- [ ] T084 Write the recorded-usage checks in `adapters/python/tests/test_records.py` and `test/contract/helper/records.test.ts`: the buckets of data-model §Usage Buckets on every response of `test/fixtures/helper/recorded/`, OpenAI input totals including cache writes (S-RESP-02) (FR-007)
- [ ] T085 [P] Add the helpers to `docs/guide/adapter.md`: a Python and a TypeScript adapter per helper-api §Python and §TypeScript, `init --adapter`, and links to [contracts/helper-api.md](contracts/helper-api.md) and the troubleshooting table of quickstart.md (FR-025)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Depends on 001 T022 and T023. T002 to T005 follow T001.
- **Foundational (Phase 2)**: Depends on Setup. Blocks all user stories. Inside it: T006 first; then T007, T008 and T009; T010 and T011 after T006 and T007; T012 before T013; tests T012 to T014 before T015.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Tests depend on Foundational; T042 depends on T030, T032 and T035.
- **User Story 4 (Phase 5)**: Tests depend on Foundational; T049 to T051 depend on User Story 1, and T050 on T042 (fingerprint when raw is given).
- **User Story 3 (Phase 6)**: Tests depend on Foundational and on the scenario fixtures the Python test tasks (T019 to T025, T038, T039, T043 to T048) wrote; T073 to T080 depend on the Python rules they port (T032 to T036, T042, T049 to T051).
- **Polish (Phase 7)**: T081 depends on T004, T011 and T037; T084 on T083; T085 on T080.
- **Feature 001 handoffs**: 001 T123 and T124 need both helpers, so they follow Phase 6. 001 T128 can start after Phase 5 for a Python service (001 plan §Delivery step 3); otherwise it follows 001 T123 to T125, as 001 tasks.md says.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational. No dependency on other stories.
- **User Story 2 (P1)**: Its implementation builds on the capture and protocol of User Story 1.
- **User Story 4 (P1)**: Its implementation builds on User Story 1's outcome and User Story 2's render shape.
- **User Story 3 (P2)**: Ports the rules of User Stories 1, 2 and 4 to TypeScript against the same fixtures.

### Within Each User Story

- Tests are written and fail before implementation.
- `adapters/python/model_eval_adapter.py` is edited by T015, T029 to T036, T042 and T049 to T051; those tasks run one after another.
- `test/example/python-service.test.ts` is edited by T028 and T041, `adapters/python/tests/test_contexts.py` and `test/fixtures/helper/scenarios/contexts.json` by T021 and T048, `test/fixtures/helper/scenarios/contexts.json` also by T038, `adapters/python/tests/test_records.py` by T020 and T084, `test/contract/helper/records.test.ts` by T056 and T084, `adapters/python/mock_api/server.py` by T007 and T037, and `test/fixtures/helper/scenarios/messages.json` and `adapters/python/tests/test_messages.py` by T026, T038 and T043 to T047; those tasks run one after another.
- In User Story 3: T072 before T078; T075 before T076; T076 and T077 before T078; T078 before T079; T080 last.
- Commit after each task or logical group.

### Parallel Opportunities

- T002 to T005 in Setup.
- In Foundational, T007, T008 and T009 after T006; then T011, T012 and T014.
- In User Story 1, tests T016 to T028; T037 alongside T029 to T036 once T007 is done.
- In User Story 2, tests T038 to T040.
- In User Story 4, tests T043 to T047; T048 after T021.
- In User Story 3, tests T052 to T071; then T072 to T075.
- User Story 3's tests can be written while Phases 4 and 5 are implemented, once their test tasks have written the fixtures.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write protocol tests in adapters/python/tests/test_protocol.py"
Task: "Write service version tests in adapters/python/tests/test_service_version.py"
Task: "Write capture tests in adapters/python/tests/test_capture.py"
Task: "Write the example test in test/example/python-service.test.ts"

# The Python helper is one file, so its implementation tasks run in order (T029 to T036),
# while the example is built alongside:
Task: "Create the example in examples/python-service/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: the example Python service runs `swap` through its helper adapter against the mock API server.

### Incremental Delivery

1. Setup and Foundational: fixture format, mock servers, shared fixtures, harnesses and shared values.
2. User Story 1: the Python helper connects a service (MVP).
3. User Story 2: render and fingerprints; `lint --render` on the example.
4. User Story 4: raw-given, stream, uncaptured and reported trials; the Python helper is ready for a real Python integration (001 T128).
5. User Story 3: the TypeScript helper and two-language parity; then `init --adapter` (001 T123, T124).
6. Polish: CI matrix, weekly SDK job, recorded fixtures, docs.

### Parallel Team Strategy

1. The team completes Setup and Foundational together.
2. One person on the Python helper (User Stories 1, 2 and 4 in order); others write the test tasks of those stories, which also produce the shared scenario fixtures.
3. Once the fixtures exist, another person writes User Story 3's tests and ports each Python rule after it lands.

---

## Notes

- [P] tasks touch different files and depend on no incomplete task.
- [Story] labels map tasks to user stories in spec.md.
- Each rule, table and message has one home in data-model.md or the contracts; tasks point to it and do not copy it. Expected results live once, in `test/fixtures/helper/scenarios/`, so both helpers are held to the same values.
- A result matches a case when every field its `expect` lists equals the actual value as canonical JSON; fields it does not list are not compared. Adapter errors and warnings are compared by their full sentence from `test/fixtures/helper/messages.json` with the placeholders filled.
- Rows whose requests start after the function returned are checked by sending `shutdown` only after the mock server has received those requests.
- Verify that tests fail before implementing.
- Stop at any checkpoint to validate a story on its own.

## Requirement Coverage

Every FR and SC of [spec.md](spec.md) and the tasks that serve it. Test tasks are the ones whose description starts with "Write" (T083 is manual).

| Requirement | Tasks |
|---|---|
| FR-001 | T010, T011, T016, T030, T052, T080 |
| FR-002 | T017, T029, T053, T073 |
| FR-003 | T018, T031, T054, T070, T074 |
| FR-004 | T014, T015, T016, T030, T052, T080 |
| FR-005 | T007, T019, T032, T055, T076 |
| FR-006 | T021, T033, T057, T077 |
| FR-007 | T020, T024, T032, T034, T035, T048, T056, T069, T075, T076, T083, T084 |
| FR-008 | T021, T033, T057, T077 |
| FR-009 | T022, T035, T058, T078 |
| FR-010 | T022, T035, T058, T078 |
| FR-011 | T023, T035, T059, T078 |
| FR-012 | T019, T022, T023, T035, T058, T059, T078 |
| FR-013 | T023, T035, T059, T078 |
| FR-014 | T022, T023, T035, T047, T058, T059, T068, T078 |
| FR-015 | T021, T022, T035, T047, T048, T057, T058, T068, T069, T078 |
| FR-016 | T022, T035, T047, T058, T068, T078 |
| FR-017 | T008, T024, T034, T046, T051, T061, T067, T075 |
| FR-018 | T043, T044, T045, T046, T047, T048, T049, T050, T051, T064, T065, T066, T067, T068, T069, T078 |
| FR-019 | T043, T044, T047, T050, T064, T065, T068, T078 |
| FR-020 | T009, T020, T022, T026, T035, T043, T044, T045, T046, T050, T051, T056, T058, T060, T064, T065, T066, T067, T078 |
| FR-021 | T038, T040, T041, T042, T063, T079 |
| FR-022 | T039, T040, T042, T063, T070, T079 |
| FR-023 | T025, T036, T062, T080 |
| FR-024 | T012, T013, T015, T070, T078 |
| FR-025 | T001, T014, T027, T071, T072, T080, T085 |
| SC-001 | T028, T037 |
| SC-002 | T001, T004, T006, T007, T010, T011, T081, T082 |
| SC-003 | T070, T081 |
| SC-004 | T028, T037, T041, T081 |
| SC-005 | T019, T045, T055, T066 |
