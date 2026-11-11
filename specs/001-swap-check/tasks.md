# Tasks: Model Swap Check

**Input**: Design documents from `/specs/001-swap-check/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required (constitution IX). Every test name carries `001 FR-###` or `001 SC-###` for the requirement it checks, and tests call no model: they use the mock adapter or the example's Node adapter.

**Organization**: Tasks are grouped by user story. User Story 1 is the MVP: `swap` end to end against the mock adapter. Each task ends with the requirements it serves.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- Single npm package at the repository root, laid out as [plan §Project Structure](plan.md#project-structure)
- Library and CLI: `src/<area>/`, with the bin entry `src/cli.ts` built to `dist/cli.js`
- Tests: `test/unit/`, `test/contract/`, `test/e2e/`, shared data in `test/fixtures/`
- Generated JSON Schemas: `schemas/`; scripts: `scripts/`; SC-003 simulation: `bench/`; synthetic example: `examples/pogo/`; docs: `docs/guide/`, `docs/reference/`
- vitest runs every test from source. Processes the tests spawn, the CLI and the mock adapter, run from `pnpm build` output (`dist/cli.js`, `dist/adapter/mock.js`), so the `contract` and `e2e` projects run after `pnpm build`. `scripts/` and `bench/` run with `tsx`
- `viewer/` (feature 002), `src/helper/` and `adapters/python/` (feature 003) are not part of these tasks

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and tooling

- [X] T001 Create `package.json` and `pnpm-lock.yaml`: name `model-eval`, `"type": "module"`, `engines.node` `>=22.17`, `bin` `model-eval` to `dist/cli.js`, `exports` `.` to `dist/index.js` with types, `files` with `dist` and `schemas`; runtime dependencies `zod`, `ajv` and `yaml` only; development dependencies TypeScript 5.x, `@types/node`, vitest, `tsx`, ESLint, typescript-eslint, Prettier, publint and `@arethetypeswrong/cli`; scripts `build`, `typecheck`, `lint`, `format`, `format:check`, `test` (build, then every vitest project), and `schemas` through `tsx` (D3)
- [X] T002 [P] Create `tsconfig.json` (type-check of `src`, `test`, `scripts`, `bench`) and `tsconfig.build.json` (emit `src` to `dist`) with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `module` and `moduleResolution` `NodeNext`, ESM only (constitution X)
- [X] T003 [P] Create `eslint.config.js` with typescript-eslint strict type-checked rules and Prettier compatibility, plus `.prettierrc.json` and `.prettierignore` (plan §Technical Context)
- [X] T004 [P] Create `vitest.config.ts` with projects `unit` (`test/unit`), `contract` (`test/contract`) and `e2e` (`test/e2e`), and `passWithNoTests` so CI passes before tests exist (constitution IX)
- [X] T005 [P] Create the layout of plan §Project Structure: `src/{config,adapter,run,checks,grade,stats,compare,report,lint,messages,cli,cli/templates}/`, empty `src/index.ts` and `src/cli.ts`, `test/{unit,contract,e2e,fixtures}/`, `schemas/`, `scripts/`, `bench/`, `examples/pogo/`, `docs/{guide,reference}/`, and `.gitignore` for `node_modules/`, `dist/` and `.model-eval/` (plan §Project Structure)
- [X] T006 [P] Create `.github/workflows/ci.yml`: Node 22, 24 and 26, `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `build`, `test`; no secrets and no model calls, so tests run only against the mock adapter (SC-001, constitution IX)
- [X] T007 [P] Set `**Status**` in `specs/001-swap-check/spec.md` to `In Progress`, so `scripts/check-spec-coverage.ts` requires a test for every FR of this feature (constitution IX)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schemas, loader, adapter client, output layer, and the contract freeze that features 002 and 003 build against. Tests T008 to T012 are written first and fail before the implementation.

**CRITICAL**: No user story work can begin until this phase is complete. T018 to T023 are the contract freeze of plan §Delivery step 1: features 002 and 003 start once `schemas/` and `test/fixtures/contracts/` are committed.

- [X] T008 [P] Write tests for canonical JSON and hashes in `test/unit/canonical-json.test.ts` per [data-model §Canonical JSON](data-model.md#canonical-json) and [§Identifiers and Hashing](data-model.md#identifiers-and-hashing): key order, string escapes, lone surrogates, numbers, values that cannot be canonical, `sha256:` notation and 12-hex IDs (FR-014)
- [X] T009 [P] Write loader tests in `test/unit/config/load.test.ts`: every `schema` problem reported with file, line, column and the level of [data-model §Validation Rules](data-model.md#validation-rules); the field constraints of data-model §Rule, §Check, §Case and §Identifiers and Hashing and of [contracts/config.md](contracts/config.md); defaults; relative paths and globs resolved from the config folder (FR-001)
- [X] T010 [P] Write contract tests in `test/contract/schemas.test.ts`: `pnpm schemas` output equals the committed `schemas/`; every file in `test/fixtures/contracts/` validates against its schema; the trial schema rejects an `ok` attempt line without `raw` or `finalKind` (constitution I); `src/report/schema.ts` imports no `node:` module (FR-010, FR-030)
- [X] T011 [P] Write output-layer tests in `test/unit/cli/output.test.ts`: `--json` writes exactly one envelope with `schemaVersion` to stdout and progress to stderr; exit code names and overlap order of [contracts/cli.md §Exit Codes](contracts/cli.md#exit-codes); `en.json` and `ko.json` have the same keys and `--lang` or config `lang` selects one; stdout and stderr pass the `redact` rules (FR-030, FR-031, FR-034)
- [X] T012 [P] Write adapter client tests in `test/contract/adapter/client.test.ts` against the mock adapter: `initialize`, `render`, `generate` and `shutdown` per [contracts/adapter-protocol.md §Transport](contracts/adapter-protocol.md#transport); responses matched by `id` in any order; the concurrency limit; shutdown and exit; a different major `protocolVersion` ends as a configuration error (FR-007)
- [X] T013 [P] Implement canonical JSON, SHA-256 hashing in `sha256:` notation and 12-hex ID prefixes in `src/adapter/canonical-json.ts`, used by runs, grade sets, comparisons and the feature 003 helper (FR-014)
- [X] T014 [P] Define zod schemas for the config, rule and case files, including the Check sum type, in `src/config/schema.ts` per [contracts/config.md](contracts/config.md) and data-model §Target, §Variant, §Rule, §Anchor, §Check and §Case (FR-001, FR-017)
- [X] T015 [P] Define zod schemas for adapter protocol v1 in `src/adapter/protocol.ts`: `initialize` params and result, `render`, `generate` result, failure result, JSON-RPC error `data`, and the `cancel`, `calls` and `log` notifications; this file is the only home of the call record schema (FR-007)
- [X] T016 Implement the YAML loader in `src/config/load.ts`: parse with `yaml` keeping positions, map zod issues to diagnostics `{code, level, message, file, line, column}`, expand `files` globs with `node:fs` `glob`, resolve `adapter.cwd`, `files` and `output.dir` from the config folder, apply defaults (FR-001)
- [X] T017 [P] Implement case path references (`input.…`, `params.…`) in `src/config/paths.ts` per [data-model §Check](data-model.md#check) (FR-002, FR-017)
- [X] T018 [P] Define zod schemas for the trial record in `src/run/records.ts`: send, attempt and cost lines per [data-model §Trial](data-model.md#trial), importing the call record from `src/adapter/protocol.ts`; `raw` and `finalKind` required when `status` is `ok` (FR-010)
- [X] T019 [P] Define zod schemas for `manifest.json` and `swaps/<swapId>.json` in `src/run/manifest.ts` per [data-model §Manifest](data-model.md#manifest) and §Run, including the adapter `capabilities` and every `costProfile` field (FR-014, SC-007)
- [X] T020 [P] Define zod schemas for Comparison, Cell, Rate and Gate per [data-model §Cell](data-model.md#cell), [§Comparison](data-model.md#comparison) and [§Gate](data-model.md#gate), including `rules[]`, versions and `postprocess` of `baseline` and `candidate`, and `config`, plus the `comparison` and `list` page payloads of [002 page-data §Payloads](../002-report-viewer/contracts/page-data.md#payloads), in `src/report/schema.ts`; no `node:` imports, because the feature 002 viewer bundles this module (FR-021, FR-022, FR-025, FR-028)
- [X] T021 Define the `--json` envelope and one `result` schema per command (`init`, `lint`, `run`, `grade`, `compare`, `swap`, `report`) per [contracts/cli.md §`--json` Output](contracts/cli.md#--json-output) in `src/cli/results.ts` (FR-030)
- [X] T022 Implement `scripts/generate-schemas.ts`: convert the zod schemas of T014, T015 and T018 to T021 to JSON Schema and write `schemas/config.schema.json`, `rules.schema.json`, `cases.schema.json`, `protocol.schema.json`, `trial.schema.json`, `manifest.schema.json`, `swap-record.schema.json`, `comparison.schema.json`, `page-data.schema.json`, `schemas/<command>.schema.json` and `schemas/envelope.schema.json`; commit the output (FR-030, D3)
- [X] T023 Write the synthetic contract fixtures in `test/fixtures/contracts/`: `manifest.json`; `trials.jsonl` with send, attempt and cost lines covering every row of [data-model §Trial Outcomes](data-model.md#trial-outcomes) and `stopped`; `comparison-block.json`, `comparison-undecided-partial.json` and `comparison-no-gate.json`, whose model texts include `</script>`, `<!--`, `$&`, HTML tags and backtick runs; a `comparison` page payload for each and `page-list.json`, a `list` payload; `template.html`, a stub page template with the data placeholder. Commit them with `schemas/`; this completes the contract freeze (FR-010, FR-025, FR-028, FR-031)
- [X] T024 [P] Create `src/messages/en.json`, `src/messages/ko.json` and the lookup in `src/messages/index.ts`: select by `--lang`, then config `lang`, else `en`; placeholders; a missing key fails in tests (FR-034, D11)
- [X] T025 [P] Implement redaction in `src/report/redact.ts`: apply the config `redact` rules to strings and to every string in a JSON value (FR-031)
- [X] T026 Implement the CLI frame: argument parsing with `node:util` `parseArgs` and the common options in `src/cli/main.ts`, exit codes and names in `src/cli/exit-codes.ts`, the envelope, stdout and stderr writers with `styleText`, `--no-color` and `NO_COLOR`, every write passing redaction, in `src/cli/output.ts`, and `--version` through the bin entry `src/cli.ts` (FR-030, FR-031, FR-034)
- [X] T027 Implement the stdio JSON-RPC client in `src/adapter/client.ts`: spawn `adapter.command` without a shell in `adapter.cwd` with `adapter.env` added, send `toolPaths` and `timeoutMs` in `initialize`, one message per line, match responses by `id`, hold the concurrency limit, validate every message with `src/adapter/protocol.ts`, pass `log` and `calls` notifications to callbacks, and end start, `initialize` and version-mismatch failures as configuration errors (FR-007, D1)
- [X] T028 [P] Implement the mock adapter in `src/adapter/mock.ts`, spawned from `dist/adapter/mock.js` and driven by scenario files in `test/fixtures/mock/`: per variant, rule violations with fixed probabilities from the per-trial seed, any outcome row of data-model §Trial Outcomes, `answers`, `stages`, usage and `calls`, latency, `render` with fingerprints, `modelSnapshot` (FR-007, SC-001)

**Checkpoint**: Contracts frozen and foundation ready. Features 002 and 003 can start; user story work can begin.

---

## Phase 3: User Story 1 - Check a candidate model with deterministic rules (Priority: P1) MVP

**Goal**: `model-eval swap --from <id> --to <id>` runs both variants against an adapter, grades deterministic rules on raw, final and trial surfaces, judges every cell, applies the gate, and writes `comparison.json` and `report.md` with the published exit codes. `model-eval run` records and grades one variant.

**Independent Test**: Run `swap` against the mock adapter with a scenario that breaks rules with known probabilities. Cell verdicts, exit code and report match the expected values, and no model is called.

### Tests for User Story 1

> Write these tests first and make sure they fail before the implementation.

- [ ] T029 [P] [US1] Write check tests in `test/unit/checks/` (one file per type): fail conditions and exact semantics of [data-model §Check](data-model.md#check) for `script`, `emoji`, `pattern`, `phrases`, `overlap`, `length` and `json`; `all`, `any` and `not` cannot contain `completed` or `review`; `…From` references; same text and definition give the same result every time (FR-017)
- [ ] T030 [P] [US1] Write outcome and grading tests in `test/unit/grade/outcome.test.ts` and `test/unit/grade/grade.test.ts`: every row of data-model §Trial Outcomes with its `completed`, raw and final columns; the empty-text definition; `answers` 0 and 2 or more; a `config` call overriding the reported result; applicable rules (`global`, `listed`, `retired`); evidence on failures (FR-009, FR-018)
- [ ] T031 [P] [US1] Write statistics tests in `test/unit/stats/` per [data-model §Statistics](data-model.md#statistics): Wilson, normal quantile, case-weighted rates, ñ, design effect, Newcombe bounds with z_L and z_U; every verdict row; the n_min values, notes and trials-needed messages given there; 100% compliance on both sides is `insufficient` below n_min and `non-inferior` above (FR-021, FR-022, FR-024)
- [ ] T032 [P] [US1] Write cell and metric tests in `test/unit/compare/cells.test.ts` and `test/unit/compare/ops.test.ts`: common cases and `droppedCases`, systematic failures per [data-model §Systematic Failures](data-model.md#systematic-failures), masked rate, `failRatio` `null` when the baseline has no failure, pooled aggregates without verdict, each operational metric with its denominator and Wilson interval, `discard-rate-increase`, `regeneration-rate-increase`, `latency-p95-ratio` and `cost-ratio` at their thresholds and never changing the exit code (FR-009, FR-021, FR-023)
- [ ] T033 [P] [US1] Write gate and summary tests in `test/unit/compare/gate.test.ts` and `test/unit/compare/summary.test.ts`: each row of [data-model §Gate](data-model.md#gate); none of every-trial-missing, partial, `running`, low baseline completion, gated rule without judged cell, or empty gate gives `pass`; an empty gate gives `no-gate` with exit 0 when none of rows 1 to 3 matches; `review` rules go to `excluded[]` with `excluded-from-gate`; `partial-run`; `dominant-error` and `abandoned-in-systematic` leave the outcome unchanged; summary order and `review` samples (FR-020, FR-025, FR-026, FR-028)
- [ ] T034 [P] [US1] Write cost tests in `test/unit/run/cost.test.ts` per [data-model §Cost](data-model.md#cost): price lookup, buckets, expected, conservative and reservation estimates, billed calls per attempt, input token estimate, `history` and `structure` basis, `costProfile` including `inputTokensMean` and `cacheHitRatio`, the cap check before every attempt including retries, re-estimates, overrun with `budget-overrun`, unpriced models with and without a cap with `unpriced-model`, `cached-input-unpriced`, `estimate-low-accuracy`, and a missing `estimate.inputTokens` (FR-011, FR-012, SC-005, SC-007)
- [ ] T035 [P] [US1] Write send-order and retry tests in `test/unit/run/order.test.ts` and `test/unit/run/retry.test.ts`: the per-trial seed example of data-model §Identifiers and Hashing; first batch, repeat-major order, repeat r only after r − 1 finished, both variants in the same order with neither ahead by the concurrency limit per [§Send Order](data-model.md#send-order); retries of `src/run/retry.ts` per [§Transient Failures](data-model.md#transient-failures) and the retry column of §Trial Outcomes (FR-009, FR-016, FR-032)
- [ ] T036 [P] [US1] Write report writer tests in `test/contract/report/markdown.test.ts` and `test/contract/report/page-data.test.ts` on the fixtures of T023: `report.md` sections in the order of FR-029, with low-baseline cells from `config.report`, anchors and origins from `rules[]`, versions and post-processing from `baseline` and `candidate`; every model or service string in a fence longer than its longest backtick run; redaction of `report.md`, `comparison.json` and page payloads; page data escapes `<` as `\u003c` and fills `test/fixtures/contracts/template.html` with a replacer function (FR-029, FR-031)
- [ ] T037 [P] [US1] Write storage tests in `test/unit/run/writer.test.ts`, `test/unit/grade/grade-set.test.ts` and `test/contract/report/write.test.ts`: the send line is flushed before its attempt is sent; manifest, swap record, grade sets and comparison folders are written per [plan D6](plan.md#d6-runs-are-files-and-grading-is-separate-from-running), including an existing comparison folder; `index.html` and `priorComparisons` scans skip `.tmp-` names; an existing grade set is reused and a changed input gives a new `gradeSetId` (FR-010, FR-014, FR-018, D6)
- [ ] T038 [P] [US1] Write sample-plan and lock tests in `test/unit/lint/sample-plan.test.ts` and `test/unit/run/lock.test.ts`: `few-cases`, `margin-unreachable`, planned trials and n_min per gated cell from the functions the gate and the verdict use; lock contents, refusal of a live owner or another host with the lock path, takeover when the owner is gone, release at the end ([data-model §Resume and Locking](data-model.md#resume-and-locking), Lock) (FR-006, FR-013)
- [ ] T039 [P] [US1] Write end-to-end verdict tests in `test/e2e/swap-verdicts.test.ts`: acceptance scenarios 1, 2, 6, 7, 12 and 13 of User Story 1; `run` records and grades; `swap --json` and `run --json` validate against `schemas/swap.schema.json` and `schemas/run.schema.json` (FR-021, FR-022, FR-024, FR-025, FR-030, FR-032)
- [ ] T040 [P] [US1] Write end-to-end cost tests in `test/e2e/swap-cost.test.ts`: acceptance scenarios 3, 4 and 10; a run refused by the pre-start cost check sends no `generate` request and leaves no directory; every send stays within the cap; `conservative-over-budget` once per swap; `--dry-run` output and exit codes; an unpriced variant model before start and an unpriced call during the run with a cap end with exit 4 (FR-011, FR-012)
- [ ] T041 [P] [US1] Write end-to-end outcome tests in `test/e2e/swap-outcomes.test.ts`: acceptance scenarios 5, 8, 9, 11 and 14; transient failures retried, excluded, raising `transient-rate` and stopping above `run.maxTransientRate`; a case failing transiently on every repeat of one variant becomes a systematic completion failure (FR-009, FR-018)
- [ ] T042 [P] [US1] Write end-to-end record tests in `test/e2e/swap-records.test.ts`: per-trial fields of FR-010; manifest fields of FR-014; a render failure at start ends with exit 4 before any `generate`; `render-mismatch`, `identical-repeats`, `response-model-changed` and `same-response-model`; `calls` notifications after a result land as cost lines; a secret planted in mock output appears in no written surface except `trials.jsonl` (FR-007, FR-010, FR-014, FR-015, FR-016, FR-031)

### Implementation for User Story 1

- [ ] T043 [P] [US1] Implement the `script` and `emoji` checks with `\p{Script=…}` and `\p{Extended_Pictographic}` in `src/checks/script.ts` and `src/checks/emoji.ts` (FR-017)
- [ ] T044 [P] [US1] Implement the `pattern` and `phrases` checks in `src/checks/pattern.ts` and `src/checks/phrases.ts` (FR-017)
- [ ] T045 [P] [US1] Implement the `overlap`, `length` (`Intl.Segmenter` for graphemes) and `json` (ajv, JSON Schema 2020-12) checks in `src/checks/overlap.ts`, `src/checks/length.ts` and `src/checks/json.ts` (FR-017)
- [ ] T046 [US1] Implement `all`, `any`, `not` and the non-grading `review` check, and the registry that dispatches by `type`, in `src/checks/combinators.ts`, `src/checks/review.ts` and `src/checks/registry.ts` (FR-017, FR-020)
- [ ] T047 [P] [US1] Implement trial outcome classification and the `completed` check in `src/grade/outcome.ts` per data-model §Trial Outcomes (FR-009, FR-018)
- [ ] T048 [US1] Implement per-surface grading in `src/grade/grade.ts`: applicable rules, raw rules on the first answer, final rules on shipped text, discarded and substituted shipped text not graded, empty output judged only by `completed`, evidence, and `skip` for cases whose hash changed (FR-018)
- [ ] T049 [US1] Implement grade sets in `src/grade/grade-set.ts`: `gradeSetId` from its inputs, `grades/<gradeSetId>.jsonl` written atomically, an existing grade set reused (FR-018, D6)
- [ ] T050 [P] [US1] Implement the normal quantile and the Wilson interval in `src/stats/quantile.ts` and `src/stats/wilson.ts` (FR-021, D4)
- [ ] T051 [US1] Implement case-weighted rates, ñ, the design effect and the Newcombe difference interval with z_L and the corrected z_U for gated cells in `src/stats/interval.ts` (FR-021, D4)
- [ ] T052 [US1] Implement the verdict order, cell notes and n_min in `src/stats/verdict.ts`, with n_min exported for the sample plan (FR-022)
- [ ] T053 [US1] Implement trials-needed estimates and their messages in `src/stats/needed.ts` (FR-024)
- [ ] T054 [US1] Implement cell building in `src/compare/cells.ts`: common unchanged cases, `droppedCases`, systematic failures applied across both runs, masked rate, `failRatio`, per-rule aggregates over languages (FR-009, FR-021)
- [ ] T055 [US1] Implement operational metrics in `src/compare/ops.ts` with the intervals of `src/stats/wilson.ts`: rates and their denominators, discard reasons, top messages per error kind, side-call failures, abandoned trials per cause, finish reasons, latency, tokens and cost per trial, response snapshots, and `discard-rate-increase`, `regeneration-rate-increase`, `latency-p95-ratio` and `cost-ratio` (FR-023)
- [ ] T056 [US1] Implement the gate in `src/compare/gate.ts`: gated rules and gated cells (exported for the sample plan), completion rate, the row order of data-model §Gate, `blocking[]`, `undecided[]`, `excluded[]` with `excluded-from-gate`, `partial-run`, and the `dominant-error` and `abandoned-in-systematic` reasons (FR-025, FR-026)
- [ ] T057 [US1] Implement the decision summary and `samples` in `src/compare/summary.ts`: `worse[]`, `improved[]`, `unknown[]` with `needed`, `ops[]`, `scope`; `review` samples and failing examples per data-model §Comparison (FR-020, FR-028)
- [ ] T058 [US1] Implement comparison warnings in `src/compare/warnings.ts` per [data-model §Warnings](data-model.md#warnings): run warnings re-raised from both runs on common cases, manifest warnings copied under their variant, `same-response-model`, grouping per code, rule, language, variant and sentence (FR-015, FR-016, FR-023)
- [ ] T059 [US1] Assemble the Comparison in `src/compare/comparison.ts`: `baseline` and `candidate` with versions and `postprocess`, `rules[]`, cells, gate, `coverage` (common cases, cases in one run only, cases dropped for a changed hash), `comparisonId`, `stats` and `config` copies, `priorComparisons` from the output directory skipping `.tmp-` names (FR-021, FR-024, FR-025, FR-027, FR-029)
- [ ] T060 [P] [US1] Implement `runId`, `swapId` and per-trial seeds in `src/run/ids.ts` (FR-016)
- [ ] T061 [P] [US1] Implement pricing, the three estimates and `costProfile` in `src/run/cost.ts` per data-model §Cost, raising `unpriced-model`, `cached-input-unpriced` and `estimate-low-accuracy` (FR-011, FR-012, SC-005, SC-007)
- [ ] T062 [US1] Implement the cap in `src/run/cap.ts`: the [§Cap Check](data-model.md#cap-check) before every attempt over both runs of a swap, re-estimates into `estimate.projected[]`, overrun into `totals.overrunUsd` with `budget-overrun` (FR-011)
- [ ] T063 [P] [US1] Implement send order and variant interleaving in `src/run/order.ts` per data-model §Send Order (FR-032, D8)
- [ ] T064 [P] [US1] Implement the retry policy in `src/run/retry.ts`: which outcomes retry, `run.retries`, the wait and its ceiling, and retries counted per key across attempts (FR-009)
- [ ] T065 [US1] Implement the run directory writer in `src/run/writer.ts`: `trials.jsonl` append with the send line flushed before each send, attempt and cost lines, `manifest.json` and `swaps/<swapId>.json` written through `.tmp-` names and rename, warnings rewritten at the points data-model §Manifest lists (FR-010, FR-014, D6)
- [ ] T066 [P] [US1] Implement `run.lock` in `src/run/lock.ts`: acquire at the start of `run` and `swap`, release at the end, refuse or take over per data-model §Resume and Locking (FR-013)
- [ ] T067 [US1] Implement the run start in `src/run/runner.ts`: take the lock, compute the first `toolPaths` (config file, files the rule and case globs match, output directory), start the adapter and `initialize`, render every case before the first model call (a failure ends as a configuration error naming the cases), and record versions, `capabilities`, render fingerprints, prices, cap and estimate in the manifest (FR-007, FR-014)
- [ ] T068 [US1] Implement the send loop in `src/run/runner.ts`: send in order through the cap check, write send and attempt lines, retry through `src/run/retry.ts`, append `calls` notifications as cost lines, raise `render-mismatch`, `identical-repeats`, `response-model-changed` and `transient-rate` (FR-007, FR-009, FR-010, FR-015, FR-016)
- [ ] T069 [US1] Implement stopping and the end of a run in `src/run/runner.ts`: the `config-error`, `transient-errors`, `budget` and `budget-projected` stops of [data-model §Stopping](data-model.md#stopping), in-flight attempts awaited, final status and `totals`, the run graded into a grade set, the lock released (FR-009, FR-011, FR-018)
- [ ] T070 [US1] Implement the swap check in `src/run/swap.ts`: one adapter per variant, one shared cap, interleaved trials, both runs stopping with the same `stopReason`, late notifications and responses awaited, then grade, compare, gate and write outputs; a stopped swap compares what finished and marks the result withheld except as FR-032 item 3 says (FR-011, FR-032)
- [ ] T071 [US1] Implement the sample plan in `src/lint/sample-plan.ts` with the gated-cell function of `src/compare/gate.ts` and n_min of `src/stats/verdict.ts`: `few-cases`, `margin-unreachable`, planned trials and n_min per gated cell (FR-006)
- [ ] T072 [P] [US1] Implement the Markdown report in `src/report/markdown.ts` with the sections of FR-029, read from the Comparison alone, and fenced untrusted strings (FR-029)
- [ ] T073 [P] [US1] Implement page payloads and template filling in `src/report/page-data.ts` per [002 page-data §Embedded Block](../002-report-viewer/contracts/page-data.md#embedded-block), and the `list` payload of the output directory skipping `.tmp-` folders (FR-031)
- [ ] T074 [US1] Implement the comparison writer in `src/report/write.ts`: `comparisons/<comparisonId>/` with redacted `comparison.json` and `report.md`, written per plan D6 (FR-029, FR-031)
- [ ] T075 [US1] Implement the `run` and `swap` commands in `src/cli/commands/run.ts` and `src/cli/commands/swap.ts`: `run` records and grades, `swap` runs the swap check; `--repeats`, `--cases`, `--max-cost-usd`, `--dry-run`, `--concurrency`; pre-start estimate, `conservative-over-budget` and sample-plan warnings (once per swap); once the config is loaded, the output redactor switches to its `redact` rules; exit codes and `--json` results (FR-006, FR-011, FR-030, FR-031, FR-032)
- [ ] T076 [US1] Implement human output for `run` and `swap` in `src/cli/human/swap.ts` as [contracts/cli.md §Human Output](contracts/cli.md#human-output-example-swap) shows, including the outcome distribution on a cost stop, with its strings in `src/messages/en.json` and `src/messages/ko.json` (FR-011, FR-028, FR-034)

**Checkpoint**: `swap` runs end to end against the mock adapter. User Story 1 is functional and testable on its own.

---

## Phase 4: User Story 2 - Keep the rule ledger in line with the prompt (Priority: P1)

**Goal**: `model-eval lint` checks files, references, provenance, examples, the sample plan and, with `--render`, anchors in every variant's rendered prompt, without calling a model.

**Independent Test**: Remove an anchored sentence from the mock adapter's rendered prompt and run `lint --render`. One `anchor-missing` warning appears.

### Tests for User Story 2

> Write these tests first and make sure they fail before the implementation.

- [ ] T077 [P] [US2] Write reference tests in `test/unit/lint/references.test.ts`: `duplicate-id`, `unknown-rule` with file and position, `missing-lang`, `unresolved-ref`, `input-schema`, `unknown-target`, `rule-filter-mismatch`, `rule-without-case`, `language-gap`, `completed-not-gated`, `excluded-from-gate` (FR-001, FR-002)
- [ ] T078 [P] [US2] Write provenance tests in `test/unit/lint/derived.test.ts`: `derived-tracked` and `vcs-unknown` per [data-model §Validation Rules](data-model.md#validation-rules) (FR-003)
- [ ] T079 [P] [US2] Write example tests in `test/unit/lint/examples.test.ts`: `example-mismatch` both ways; `input` and `params` of `examples` feed `…From` (FR-005)
- [ ] T080 [P] [US2] Write end-to-end lint tests in `test/e2e/lint.test.ts`: acceptance scenarios 1 to 6 of User Story 2; anchors checked per variant and reported once per rule, language and quote; an anchor present in some languages only is reported; `unanchored` info not counted by `--max-warnings`; `few-cases` and `margin-unreachable`; `--no-adapter`; `adapter-failed` exits 4; `render-failed`; human output; `lint --json` validates against `schemas/lint.schema.json` (FR-004, FR-006, FR-030)

### Implementation for User Story 2

- [ ] T081 [P] [US2] Implement reference lint codes, one function each, in `src/lint/references.ts` (FR-001, FR-002)
- [ ] T082 [P] [US2] Implement `input-schema` with ajv against each target's `inputSchema` in `src/lint/input-schema.ts` (FR-002)
- [ ] T083 [P] [US2] Implement `derived-tracked` and `vcs-unknown` with `git ls-files` and `git check-ignore` in `src/lint/derived-tracked.ts` (FR-003)
- [ ] T084 [P] [US2] Implement `example-mismatch` by running each rule's examples through its check in `src/lint/examples.ts` (FR-005)
- [ ] T085 [P] [US2] Implement anchor checks in `src/lint/anchors.ts`: render the matching cases for every variant (or `--variant`), normalise whitespace, report `anchor-missing` with variants and cases, skip `retired` rules, report `unanchored` as info and `render-failed` with the adapter's message (FR-004)
- [ ] T086 [P] [US2] Implement `completed-not-gated` and `excluded-from-gate`, and the lint codes of `src/lint/sample-plan.ts`, in `src/lint/gate-config.ts` (FR-006)
- [ ] T087 [US2] Implement the lint runner in `src/lint/index.ts`, the command in `src/cli/commands/lint.ts` and its human output in `src/cli/human/lint.ts`: adapter started with the first variant, every variant under `--render`, none under `--no-adapter`; `--max-warnings`; errors, warnings and info in `result.errors`, `warnings` and `result.info`; exit 1 on findings and 4 on `adapter-failed`; strings in `src/messages/` (FR-001, FR-004, FR-030, FR-034)

**Checkpoint**: User Stories 1 and 2 both work on their own.

---

## Phase 5: User Story 3 - Connect any service through an adapter (Priority: P1)

**Goal**: Any service connects through an adapter process: the tool survives hangs, crashes and protocol violations and records them as adapter errors, `init` creates a starting point, and the bundled example runs from a fresh clone.

**Independent Test**: Run the bundled `examples/pogo` with its Node mock adapter by following quickstart.md. It finishes without calling a model.

### Tests for User Story 3

> Write these tests first and make sure they fail before the implementation.

- [ ] T088 [P] [US3] Write adapter fault tests in `test/contract/adapter/faults.test.ts` per [adapter-protocol §Time Limits and Recovery](contracts/adapter-protocol.md#time-limits-and-recovery): abandonment at `adapter.timeoutMs` with `cancel` and the slot held until the late response; restart when every slot is abandoned; process death and non-JSON stdout restart with `abandoned: "restart"` and the message of US3 scenario 3; a result without required fields, a JSON-RPC error and `answers` 0 with `model` are adapter errors; late responses correct cost only (FR-007, FR-008)
- [ ] T089 [P] [US3] Write adapter log tests in `test/contract/adapter/logs.test.ts`: stderr shown with `--verbose` and its last lines attached to failure reports, `log` notifications in `adapter.log`, `warn` and `error` logs grouped with counts at the end of a run, all redacted (FR-008, FR-031)
- [ ] T090 [P] [US3] Write end-to-end adapter error tests in `test/e2e/adapter-errors.test.ts`: acceptance scenarios 3 and 4 of User Story 3; the `adapter-errors` stop by rate and by crashes in a row with exit 3; a restarted adapter with a different version or service code ends with exit 4; `abandoned-trials` and `adapter-warnings` in the comparison; `capabilities.postprocess: false` shown in the report (FR-008, FR-009, FR-029)
- [ ] T091 [P] [US3] Write `init` tests in `test/e2e/init.test.ts`: in an empty folder, `init` creates the config template, example rules and cases and adds the output directory to `.gitignore`; `lint --no-adapter` passes on the result; human output; `init --json` validates against `schemas/init.schema.json` (FR-033, FR-030)
- [ ] T092 [P] [US3] Write the example test in `test/e2e/example-pogo.test.ts`: in `examples/pogo`, the steps of quickstart.md §Verify: Example Swap Check (`lint --render` exit codes with the one planted `anchor-missing`, `swap --dry-run` without a `generate` request, `swap` exiting 1 with `script-ja` first and writing `report.md`); the whole test runs in CI within 3 minutes (SC-001, SC-006)

### Implementation for User Story 3

- [ ] T093 [US3] Extend `src/adapter/client.ts` with the tool time limit, `cancel` when declared, slot accounting for abandoned requests, restart after death, stdout contamination or all slots abandoned, and the version comparison of a restarted adapter; abandoned request IDs stay pending until their late response arrives, so a late response is not a protocol violation (FR-008)
- [ ] T094 [P] [US3] Add fault modes to `src/adapter/mock.ts` and scenarios in `test/fixtures/mock/`: hang, crash, stdout noise, missing fields, JSON-RPC errors with `data`, late responses, `calls` notifications, version change on restart, adapter warnings (FR-008)
- [ ] T095 [P] [US3] Implement adapter stderr relay and `adapter.log` in `src/adapter/logs.ts`: redacted `--verbose` output, the tail for failure reports, grouped `warn` and `error` logs at the end of a run (FR-008, FR-031)
- [ ] T096 [US3] Extend `src/run/runner.ts` with the `adapter-errors` stop, the `config-error` stop for a restarted adapter whose versions or service code differ, and abandoned attempts charged at their reservation (FR-008)
- [ ] T097 [US3] Add `abandoned-trials` and `adapter-warnings` to `src/compare/warnings.ts`, and the post-processing notice to `src/cli/human/swap.ts`; the report notice is T072's, and T090 checks it for the fault-mode adapter (FR-008)
- [ ] T098 [US3] Implement `init` without `--adapter` in `src/cli/commands/init.ts` with templates in `src/cli/templates/` and human output: config template, example rules and cases, `.gitignore` entry for `output.dir` (FR-033, FR-034)
- [ ] T099 [P] [US3] Create the synthetic example in `examples/pogo/`: `model-eval.config.yaml`, `rules/` and `cases/` from [contracts/config.md](contracts/config.md) with enough `provenance: synthetic` cases per language for the default settings, and `adapter.mjs` that needs only Node, renders prompts with one planted missing anchor, and whose `model-b` breaks `script-ja` on purpose (SC-001, SC-006)

**Checkpoint**: User Stories 1, 2 and 3 work; the example runs from a fresh clone.

---

## Phase 6: User Story 4 - Re-grade, compare and resume saved runs (Priority: P1)

**Goal**: `grade`, `compare` and `report` work on saved runs without calling a model, and `run --resume` and `swap --resume` finish interrupted work with the same conclusion an uninterrupted run would reach.

**Independent Test**: Grade a saved run, change a pattern in one rule and run `compare` again. Only cells of that rule change verdict, and no model is called.

### Tests for User Story 4

> Write these tests first and make sure they fail before the implementation.

- [ ] T100 [P] [US4] Write resume unit tests in `test/unit/run/resume.test.ts` per [data-model §Resume and Locking](data-model.md#resume-and-locking) and §Trial: which trials are resent, send lines closed as `stopped`, a cut last line truncated, a broken middle line ends with exit 4 and its line number, retries counted across segments, stop rates over the current segment, spend and `totals` recounted (FR-013)
- [ ] T101 [P] [US4] Write end-to-end resume tests in `test/e2e/resume.test.ts`: acceptance scenarios 2, 3 and 4 of User Story 4; every refusal with exit 4 that data-model §Resume and Locking lists; `resume-unverified` and `resume-config-ignored`; a rule-only change never blocks; resume above the cap ends `budget-projected` with exit 5; `--dry-run` with `--resume` changes nothing (FR-011, FR-013)
- [ ] T102 [P] [US4] Write interrupt tests in `test/e2e/interrupt.test.ts`: first and second SIGINT or SIGTERM per data-model §Stopping; a kill leaves the run `running` and resumable when the lock owner is gone; a stopped swap compares what finished with the gate `undecided`, except as FR-032 item 3 says (FR-013, FR-032)
- [ ] T103 [P] [US4] Write re-grade tests in `test/e2e/regrade.test.ts`: the independent test of User Story 4; `grade` writes a new grade set without a `generate` request; `compare` re-grades both runs with the current rules (acceptance scenario 1); `report` rewrites `report.md`; human output of the three commands; `grade --json`, `compare --json` and `report --json` validate against their schemas (FR-019, FR-030)
- [ ] T104 [P] [US4] Write comparison precondition tests in `test/e2e/compare-coverage.test.ts`: cases in one run only and cases whose content changed leave the comparison and appear in `coverage`; preconditions use common cases only; `versions-differ` for different service code, adapter version, `launchHash` or helper version (FR-027)
- [ ] T105 [P] [US4] Write the determinism test in `test/e2e/determinism.test.ts`: `compare --json` on the same records twice gives byte-identical output apart from the volatile fields of data-model §Identifiers and Hashing; a run that became `complete` on resume gets a new `comparisonId` (SC-002)

### Implementation for User Story 4

- [ ] T106 [US4] Implement resume loading and repair in `src/run/resume.ts`: read the manifest and `trials.jsonl`, truncate a cut last line, end on a broken middle line with its line number, close send lines as `stopped` at their reservation, recount spend and `totals`, select the trials to send (FR-013)
- [ ] T107 [US4] Implement resume checks in `src/run/resume-check.ts`: the refusals and warnings of data-model §Resume and Locking, generation conditions compared with the manifest, `toolPaths` joined with earlier segments (FR-013)
- [ ] T108 [US4] Implement resumed sending in `src/run/runner.ts` and `src/run/swap.ts`: take the lock, add a segment, re-estimate before sending (`budget-projected` without a send), send the selected trials with their remaining retries, stop rates over the current segment, swap resume by `swapId` comparing without sending when both runs finished (FR-011, FR-013)
- [ ] T109 [US4] Implement interrupt handling in `src/run/signals.ts` and wire it into `src/run/runner.ts` and `src/run/swap.ts`: first signal stops, second cancels and exits, `interrupted` stop reason, withheld comparison rules of FR-032 item 3 (FR-013, FR-032)
- [ ] T110 [US4] Add `--resume` to `src/cli/commands/run.ts` and `src/cli/commands/swap.ts`: `runId` or `swapId`, refused options, `--max-cost-usd` over earlier spend, `--dry-run` showing remaining trials and the re-estimate (FR-011, FR-013)
- [ ] T111 [US4] Add `versions-differ` to `src/compare/warnings.ts` (FR-027)
- [ ] T112 [US4] Implement `grade` and `compare` in `src/cli/commands/grade.ts` and `src/cli/commands/compare.ts` with human output in `src/cli/human/compare.ts`: re-grade with the current rules into a grade set, compare, gate and write outputs; exit codes and `--json` (FR-019, FR-025, FR-030, FR-034)
- [ ] T113 [US4] Implement `report` in `src/cli/commands/report.ts`: rewrite `report.md` from a saved `comparison.json`, with human output and `--json` (FR-029, FR-030)

**Checkpoint**: All user stories work on their own.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Simulation, coverage enforcement, public API, docs, the parts that wait on features 002 and 003, and validation by people

- [ ] T114 [P] Implement the SC-003 simulation in `bench/random.ts` (seeded generator) and `bench/sc003.ts`: the scenarios and grid of [research §Design-time validation](research.md#design-time-validation-sc-003) run through `src/stats`, 1,000 families for item (d), print the tables and exit non-zero when an item misses its target; add the `bench` script (`tsx bench/sc003.ts`) to `package.json` (SC-003)
- [ ] T115 [P] Measure tool overhead per trial against the mock adapter in `bench/overhead.ts` and report it next to the 5 ms goal (plan §Technical Context)
- [ ] T116 [P] Implement `scripts/check-spec-coverage.ts`: read the FR and SC IDs of each feature whose status is `In Progress` or `Implemented`, find test names carrying `NNN FR-###`, and fail with the FR IDs that no test name carries (SC IDs are not enforced); its test in `test/unit/check-spec-coverage.test.ts` asserts that 001 is among the checked features; add the `check:coverage` script (`tsx scripts/check-spec-coverage.ts`) to `package.json` (constitution IX)
- [ ] T117 Extend `.github/workflows/ci.yml` with `pnpm check:coverage`, `pnpm bench` for SC-003, publint and Are the Types Wrong on `pnpm pack`, and a 3-minute limit on the end-to-end step (SC-001, SC-003, constitution IX)
- [ ] T118 [P] Export the public library API (config loading, `run`, `swap`, `grade`, `compare`, report writers, schemas) from `src/index.ts` and test the export list in `test/unit/index.test.ts` (FR-019, FR-030, FR-032)
- [ ] T119 [P] Complete the Korean strings in `src/messages/ko.json` and add `--lang ko` runs of every command to `test/e2e/lang.test.ts`, checking that `--json` output does not change with `--lang` (FR-034)
- [ ] T120 [P] Write `docs/guide/adapter.md`, `docs/guide/rules.md`, `docs/guide/statistics.md` and `docs/guide/ci.md`, including `lint --no-adapter` for untrusted pull requests (FR-004, FR-022, FR-033)
- [ ] T121 [P] Write `docs/reference/cli.md`, `docs/reference/config.md` and `docs/reference/checks.md`, linking to the contracts, data-model and `schemas/` (FR-017, FR-030)
- [ ] T122 [P] Write `README.md`: what the tool checks, install, the example swap check, links to docs and schemas, exit codes (SC-006)
- [ ] T123 Write `init --adapter` tests in `test/e2e/init-adapter.test.ts`, once feature 003 ships its helpers: `--adapter python` and `--adapter node` create the skeleton, Python also gets the helper file next to it, `lint` passes on each generated skeleton (acceptance scenario 2 of User Story 3), and an older copied helper gives `helper-outdated` (FR-033, FR-035)
- [ ] T124 Implement `--adapter python` and `--adapter node` in `src/cli/commands/init.ts` with skeletons in `src/cli/templates/` that use the feature 003 helper, copying `adapters/python/model_eval_adapter.py` for Python (FR-033)
- [ ] T125 [P] Implement `helper-outdated` from `initialize` `adapter.helper` against the bundled helper version in `src/lint/helper-version.ts` (FR-035)
- [ ] T126 Connect the result page template `dist/viewer/report.html`, once feature 002 builds it, to `src/report/write.ts` and `src/cli/commands/report.ts`, so `compare`, `swap` and `report` also write `report.html` and the output `index.html`; run `test/e2e/example-pogo.test.ts` on real output (FR-031, plan §Delivery step 3)
- [ ] T127 (manual, not for agents) Have a person new to the repository follow `specs/001-swap-check/quickstart.md` alone from a fresh clone, and record the time to the example comparison in `specs/001-swap-check/checklists/validation.md` (SC-006)
- [ ] T128 (manual, needs real keys, not for agents) Validate against a real service outside this repository per [plan §Validation Against a Real Service](plan.md#validation-against-a-real-service), read the SC-004, SC-005 and SC-007 figures from the manifests' `estimate`, `totals` and `costProfile`, and record the figures only, without service names, prompts or case data (constitution V), in `specs/001-swap-check/checklists/validation.md` (SC-004, SC-005, SC-007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T002 to T007 follow T001.
- **Foundational (Phase 2)**: Depends on Setup. Blocks all user stories. Inside it: T013, T014 and T015 first; T016 and T017 after T014; T018 after T015; T019 and T020 after T014 and T015; T028 after T015; T021 after T018 to T020; T022 after T021; T023 after T022; T026 after T021, T024 and T025; T027 after T015. T018 to T023 freeze the contracts; features 002 and 003 wait for T022 and T023.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on Foundational and on T071 (sample plan) of User Story 1.
- **User Story 3 (Phase 5)**: Depends on User Story 1 (client, runner, warnings and report it extends) and on User Story 2's lint command for T091 and T092.
- **User Story 4 (Phase 6)**: Depends on User Story 1 (runs to resume, grade and compare, and the lock of T066).
- **Polish (Phase 7)**: Depends on the user stories it touches. T123 to T125 depend on feature 003's helpers. T126 depends on feature 002's built template. T127 depends on T122 and T126. T128 depends on T123 to T125.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational. No dependency on other stories.
- **User Story 2 (P1)**: Starts after Foundational and T071. Testable on its own with the mock adapter.
- **User Story 3 (P1)**: Starts after User Story 1. Its fault handling extends `src/adapter/client.ts` and `src/run/runner.ts`.
- **User Story 4 (P1)**: Starts after User Story 1. Can run in parallel with User Stories 2 and 3, except for the shared files below.

### Within Each User Story

- Tests are written and fail before implementation.
- Checks before grading; grading before cells; T050 before T051 and T055; T052 and T056 before T071.
- Cost, cap, order, retry, writer and lock before the runner (T067 to T069 in order), the runner before the swap, the swap before the commands.
- `src/run/runner.ts` is edited by T067 to T069, T096, T108 and T109, and `src/compare/warnings.ts` by T058, T097 and T111; those tasks run one after another.
- Commit after each task or logical group.

### Parallel Opportunities

- T002 to T007 in Setup.
- In Foundational, tests T008 to T012; then T013, T014 and T015; then T017 to T020, T024, T025 and T028.
- In User Story 1, tests T029 to T042; then T043 to T045, T047, T050, T060, T061, T063, T064, T066, T072 and T073.
- In User Story 2, tests T077 to T080 and T081 to T086.
- In User Story 3, tests T088 to T092, then T094, T095 and T099.
- In User Story 4, tests T100 to T105.
- Features 002 and 003 run in parallel with all of this once T023 is committed.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write check tests in test/unit/checks/"
Task: "Write statistics tests in test/unit/stats/"
Task: "Write cost tests in test/unit/run/cost.test.ts"
Task: "Write end-to-end verdict tests in test/e2e/swap-verdicts.test.ts"

# Launch independent modules for User Story 1 together:
Task: "Implement the script and emoji checks in src/checks/script.ts and src/checks/emoji.ts"
Task: "Implement the normal quantile and the Wilson interval in src/stats/quantile.ts and src/stats/wilson.ts"
Task: "Implement pricing, the three estimates and costProfile in src/run/cost.ts"
Task: "Implement send order and variant interleaving in src/run/order.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational, and commit the contract freeze (T022, T023) so features 002 and 003 can start.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: `swap` against the mock adapter gives the expected verdicts, exit codes and report.

### Incremental Delivery

1. Setup and Foundational: contracts frozen, adapter client and mock adapter working.
2. User Story 1: `run` and `swap` end to end (MVP).
3. User Story 2: `lint` and `lint --render`.
4. User Story 3: adapter fault handling, `init`, the example.
5. User Story 4: `grade`, `compare`, `report`, resume.
6. Polish: SC-003 simulation, coverage check in CI, docs, then the parts that wait on features 002 and 003, then validation by people.

### Parallel Team Strategy

1. The team completes Setup and Foundational together.
2. After the contract freeze, feature 002 (result page) and feature 003 (Python helper) start on their own branches.
3. On this feature: one person on User Story 1; after T071, another on User Story 2; after User Story 1, User Stories 3 and 4 in parallel.

---

## Notes

- [P] tasks touch different files and depend on no incomplete task.
- [Story] labels map tasks to user stories in spec.md.
- Each rule, constraint, formula and table has one home in data-model.md or the contracts; tasks point to it and do not copy it.
- Verify that tests fail before implementing.
- Stop at any checkpoint to validate a story on its own.

## Requirement Coverage

Every FR and SC of [spec.md](spec.md) and the tasks that serve it. Test tasks are the ones whose description starts with "Write" (T127 and T128 are manual).

| Requirement | Tasks |
|---|---|
| FR-001 | T009, T014, T016, T077, T081, T087 |
| FR-002 | T017, T077, T081, T082 |
| FR-003 | T078, T083 |
| FR-004 | T080, T085, T087, T120 |
| FR-005 | T079, T084 |
| FR-006 | T038, T071, T075, T080, T086 |
| FR-007 | T012, T015, T027, T028, T042, T067, T068, T088 |
| FR-008 | T088, T089, T090, T093, T094, T095, T096, T097 |
| FR-009 | T030, T032, T035, T041, T047, T054, T064, T068, T069, T090 |
| FR-010 | T010, T018, T023, T037, T042, T065, T068 |
| FR-011 | T034, T040, T061, T062, T069, T070, T075, T076, T101, T108, T110 |
| FR-012 | T034, T040, T061 |
| FR-013 | T038, T066, T100, T101, T102, T106, T107, T108, T109, T110 |
| FR-014 | T008, T013, T019, T037, T042, T065, T067 |
| FR-015 | T042, T058, T068 |
| FR-016 | T035, T042, T058, T060, T068 |
| FR-017 | T014, T017, T029, T043, T044, T045, T046, T121 |
| FR-018 | T030, T037, T041, T047, T048, T049, T069 |
| FR-019 | T103, T112, T118 |
| FR-020 | T033, T046, T057 |
| FR-021 | T020, T031, T032, T039, T050, T051, T054, T059 |
| FR-022 | T020, T031, T039, T052, T120 |
| FR-023 | T032, T055, T058 |
| FR-024 | T031, T039, T053, T059 |
| FR-025 | T020, T023, T033, T039, T056, T059, T112 |
| FR-026 | T033, T056 |
| FR-027 | T059, T104, T111 |
| FR-028 | T020, T023, T033, T057, T076 |
| FR-029 | T036, T059, T072, T074, T090, T113 |
| FR-030 | T010, T011, T021, T022, T026, T039, T075, T080, T087, T091, T103, T112, T113, T118, T121 |
| FR-031 | T011, T023, T025, T026, T036, T042, T073, T074, T075, T089, T095, T126 |
| FR-032 | T035, T039, T063, T070, T075, T102, T109, T118 |
| FR-033 | T091, T098, T120, T123, T124 |
| FR-034 | T011, T024, T026, T076, T087, T098, T112, T119 |
| FR-035 | T123, T125 |
| SC-001 | T006, T028, T092, T099, T117 |
| SC-002 | T105 |
| SC-003 | T114, T117 |
| SC-004 | T128 |
| SC-005 | T034, T061, T128 |
| SC-006 | T092, T099, T122, T127 |
| SC-007 | T019, T034, T061, T128 |
