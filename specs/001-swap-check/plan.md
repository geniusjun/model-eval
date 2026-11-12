# Implementation Plan: Model Swap Check

**Branch**: `001-swap-check` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-swap-check/spec.md`

## Summary

A TypeScript CLI and library that never calls the service code directly. It talks to a language-neutral adapter process over JSON-RPC on stdio. The runner sends the same cases to a baseline and a candidate variant in interleaved order, and grades each rule on the raw answer, the shipped text and the trial outcome with deterministic checks.

Each rule × language × output surface cell gets a non-inferiority verdict from a closed-form Newcombe interval widened by a case-cluster design effect. The gate applies only the conditions written in the config, reports through the exit code, and the comparison is written as JSON and Markdown for the result page (feature 002) to read.

## Technical Context

**Language/Version**: TypeScript 5.x with `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; ESM only

**Primary Dependencies**: `zod`, `ajv` and `yaml` at run time (D3); everything else is Node built-ins or written in-house. Development only: pnpm, `tsc`, `@types/node`, vitest, `tsx` (runs `scripts/` and `bench/`), ESLint with typescript-eslint (strict type-checked), Prettier, publint, Are the Types Wrong

**Storage**: Files only. A run is `manifest.json` plus JSONL; a comparison is JSON plus `report.md` and `report.html` (feature 002)

**Testing**: vitest for unit (checks, statistics, schemas), contract (adapter protocol) and end-to-end tests against the mock adapter; `bench/` simulation for SC-003

**Target Platform**: Node.js 22.17 or later (the version where `fs.glob` became stable) on macOS and Linux; CI on Node 22, 24 and 26 in GitHub Actions. Windows is not supported, because adapter process signals and paths are not verified there

**Project Type**: Single npm package: library, CLI (`bin`), adapter helper subpath (feature 003) and result page template (feature 002)

**Performance Goals**: Tool overhead of at most 5 ms per trial

**Constraints**: The default CI path never calls a model. Default swap check of two small models costs at most 0.5 USD (SC-007)

**Scale/Scope**: Tens of rules, hundreds of cases, thousands of trials per run

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Grade What the Service Actually Ships | PASS | The core holds no service prompt. `raw` and `finalKind` are required on trials with status `ok` |
| II. No Conclusion From a Single Sample | PASS | No verdict without an interval. Operational metrics only warn and never change the exit code (D9). A partial run, nothing to judge or a low baseline completion rate is checked before the gate config and gives `undecided`; so does a gate with no judged gated cell or a gated rule with no judged cell; an empty gate gives `no-gate` (data-model §Gate) |
| III. Deterministic Checks First | PASS | Only deterministic checks and `review` in this feature. The gate excludes `review` rules |
| IV. People Set Policy, the Tool Shows Evidence | PASS | An empty `gate` cannot block, and a comparison that passes the preconditions returns `no-gate` with exit code 0. Margins, severities and surfaces come from the config and rule files |
| V. Real User Data Stays Out of the Repository | PASS | Required `provenance`, `derived-tracked` lint error, ignored output path, every written surface redacted per FR-031. The example pages CI keeps are built from the synthetic example only |
| VI. Same Records, Same Conclusion | PASS | Case hashes, service version, seed, price copy and segment records in the manifest. Resume is refused when a generation condition is known to differ and warns when it cannot be verified. Closed-form statistics need no seed. Deterministic IDs from canonical JSON |
| VII. Know the Cost Before Starting, Stay Under the Cap | PASS | The expected estimate decides the start and the conservative one warns. Re-estimates after the first batch and every repeat round, a reservation check before every send, the overrun reported, the cap covering both runs of a swap and earlier segments, a missing price as a configuration error (FR-011, FR-012, D7) |
| VIII. Humans and Agents Read the Same Result | PASS | `--json` with JSON Schema for every command, published exit codes |
| IX. Every Requirement Has a Test | PASS | Test names carry `001 FR-###`. CI uses the mock adapter |
| X. Stay Small | PASS | Three runtime dependencies (D3) |

Re-checked after Phase 1 design (data-model, contracts): no change.

## Project Structure

### Documentation (this feature)

```text
specs/001-swap-check/
├── spec.md
├── plan.md              # This file
├── research.md          # R1–R8
├── data-model.md        # Entities, trial outcomes, cells, gate, cost
├── quickstart.md        # Example swap check end to end
├── contracts/
│   ├── cli.md           # Commands, options, exit codes, --json
│   ├── config.md        # model-eval.config.yaml, rules/*.yaml, cases/**/*.yaml
│   └── adapter-protocol.md
├── checklists/
│   ├── requirements.md
│   └── validation.md    # SC-004 to SC-007 figures, filled by people
└── tasks.md             # Phase 2 output (/speckit.tasks), not created by /speckit.plan
```

### Source Code (repository root)

```text
src/
├── config/        # zod schemas for config, rules and cases; YAML loader with positions; path references
├── adapter/       # protocol types, stdio JSON-RPC client (cancel, restart), mock adapter
├── run/           # runner (order, concurrency, retries, resume, lock), cost estimate and cap, record writer
├── checks/        # one file per deterministic check type, registry
├── grade/         # grading per output surface, trial outcome classification, grade-set cache
├── stats/         # Wilson, Newcombe, design effect, verdict order, n_min, required trials, normal quantile
├── compare/       # cells, comparison, decision summary, operational metrics and warnings, gate
├── report/        # Markdown and JSON writers, redaction, page data for feature 002
├── lint/          # one function per lint code
├── messages/      # en.json, ko.json
├── cli/           # entry points, output, exit codes, init templates (templates/)
├── cli.ts         # bin entry, built to dist/cli.js
└── index.ts       # public library API

schemas/           # JSON Schemas generated from zod, shipped in the package
examples/pogo/     # synthetic example: config, rules, cases, Node mock adapter
bench/             # SC-003 simulation using src/stats
test/              # unit/ contract/ e2e/ fixtures/
scripts/           # check-spec-coverage.ts, generate-schemas.ts
.github/workflows/ # CI
docs/
├── guide/         # adapter, rules, reading the statistics, CI
└── reference/     # CLI, config, checks
```

**Structure Decision**: One npm package. The library API in `src/index.ts` is the core, and the CLI, the helpers (`src/helper/`, feature 003) and the result page (`viewer/`, feature 002) are layers on top. Separate packages would add version alignment work without a user benefit.

## Design Decisions

### D1. The tool is TypeScript; the service is reached through an adapter process

The tool runs on Node and starts the adapter as a child process that speaks JSON-RPC over stdio. The process boundary keeps the tool from reaching into the service, which enforces principle I by structure, and npm gives one-step installation in CI. A Python library imported into the service would exclude other languages and mix dependencies; an HTTP adapter would need ports and authentication. Details: [contracts/adapter-protocol.md](contracts/adapter-protocol.md).

### D2. The adapter runs the service's real turn function

Adapters run the service's own turn function against fake storage and let only the model call go out. Copying the assembly code into the adapter keeps running after the service changes and drifts silently. Fake storage raises on unexpected queries and cases carry anchors for blocks that must be present, so a missing block surfaces as an error instead of quietly vanishing (research R2).

### D3. Three runtime dependencies

| Dependency | Used for | Why not in-house |
|---|---|---|
| `zod` | Config, rule, case and protocol schemas; type inference; JSON Schema generation | One schema gives types, validation and JSON Schema; three separate copies drift |
| `ajv` | Validating case inputs against the adapter's `inputSchema` | The schema arrives at run time as JSON Schema; a hand-written validator would not cover the standard |
| `yaml` | Parsing with line and column positions | A position-aware YAML parser is not small enough to write |

Built in or written in-house: argument parsing (`node:util` `parseArgs`), colour (`node:util` `styleText`), file globbing (`node:fs` `glob`), hashing (`node:crypto`), statistics with the normal and Student t quantiles, the seeded random generator for the simulation, and Unicode script tests (`\p{Script=…}`, `\p{Extended_Pictographic}`). React is bundled into the result page template at build time and is not a runtime dependency of the package.

### D4. Statistics are closed-form

Case-weighted compliance, Newcombe hybrid score interval with a Rao–Scott design effect, Bonferroni on the blocking upper bound only, a Student t quantile on that bound for cells with fewer than 10 cases, regressions checked before sample-size verdicts, and a minimum trial count derived from the margin. Defaults are 5 repeats and margin 0.10, the smallest margin that meets SC-003 with 30 cases per language. See research R3.

### D5. A small standalone runner, not a plugin for an existing eval tool

The new parts are the rule ledger tied to rendered prompts, separate grading of raw, shipped, discarded and substituted outputs, and cell-level non-inferiority with a decision view. Pre-start cost refusal and the per-attempt cap must be a runner contract. See research R1.

### D6. Runs are files and grading is separate from running

One run is one directory with `manifest.json`, `trials.jsonl` and `grades/<gradeSetId>.jsonl`. Grade sets are cached by run, rules hash, checker version, trials fingerprint and cases hash, and `compare` always grades with the current rules. Checks can then be fixed without calling the model again, and JSONL survives interruption. SQLite was rejected for its native dependency and records that people cannot open.

No half-written file survives a kill or a second interrupt:

1. The manifest, the swap record, grade-set files and the output `index.html` are written under a temporary name and renamed.
2. A new comparison folder is written as a temporary folder and renamed. If the folder already exists (also when another process created it first), each file is replaced the same way: a folder cannot be renamed over another, and the same comparison ID means the same content apart from volatile fields.
3. Temporary names start with `.tmp-`, contain the process ID and a random part, and live in the destination folder. The rename is then atomic on one file system, and two processes writing the same result never mix their writes.
4. Scans of the output directory (`index.html`, `priorComparisons`) skip `.tmp-` names, so leftovers of a kill are never read as results.
5. A cut grade-set file would be reused as it is, since grade sets with the same ID are never rebuilt; this is why grade sets are written atomically too.

`trials.jsonl` is append-only, and its cut last line is handled as in [data-model §Trial](data-model.md#trial).

### D7. Cost: start on the expected estimate, hold the cap with a check before every attempt

The start decision uses the expected estimate; the conservative estimate only warns. Every attempt reserves its worst case before it is sent. Re-estimates run after the first 20-trial batch of each variant and after every repeat round. Formulas: [data-model §Cost](data-model.md#cost). Reasons and figures: research R4.

### D8. One adapter process per variant, variants interleaved

`swap` starts one adapter per variant and passes the variant once in `initialize`. The adapter applies the variant (model, flags) once at start, which keeps adapters simple, and services that choose the model globally connect unchanged.

Trials of the two variants are sent in the same order and interleaved, and neither variant gets ahead by the concurrency limit or more. Interleaving gives both variants the same provider load even when it changes over time, so latency and transient errors compare fairly. Repeats of a case go in repeat order, each after the previous one finished: repeats sent together would all miss the cache and be billed as cache writes (research R4), and a run stopped midway leaves every case with about the same number of repeats. Order rules: [data-model §Send Order](data-model.md#send-order).

A timed-out request is never resent. A `cancel` is sent when the adapter supports it, and its slot stays counted until the adapter answers, so a request the provider may already have billed is not paid twice and real concurrency stays within the limit.

Rejected: finishing one variant before starting the other, which mixes time-of-day effects into latency and error rates; sending a case's repeats together, for the cache cost above.

### D9. Trial outcomes decide denominators

Rejections, time-outs, cuts, empty answers, discards and fallbacks fail the `completed` rule. Transient failures and adapter errors leave the denominators unless they concentrate on one case of one variant. Configuration problems stop the run. The default gated surface is the raw answer. See [data-model §Trial Outcomes](data-model.md#trial-outcomes) and research R8.

Operational metrics (rejection, transient error, discard and fallback rates, latency, cost) are reported with intervals and only warn. Gating a point estimate against a fixed limit would break principle II, and a candidate rejected every time is already blocked by its `completed` cell.

### D10. The unit of judgement is rule × language × output surface

Cells are judged and gated one by one; the pooled value per rule is reference only. The public JSON keys rows by cell from the start, so adding the language axis later never forces a major version. See research R7.

### D11. Human output in English and Korean

All human-facing strings live in `src/messages/en.json` and `ko.json`, selected by `--lang` or the config `lang` (default `en`). JSON output and exit codes do not depend on the language. Text that comes from the adapter (protocol `log` messages, error messages, helper warnings) is data in the trial records and is shown as written, whatever the language; the helpers write it in English ([003 plan D11](../003-adapter-helpers/plan.md#d11-helper-messages-are-english-sentences)).

## Validation Against a Real Service

The repository holds only the synthetic example. A real integration keeps its adapter, rules and cases in the service's own workspace, imports the service code through the helpers without modifying it, and keeps its measurements there.

- First target: one chat turn of a multilingual chat service, using render mode, `stages`, `finalKind`, `cancel` and `discard_on` for the exceptions the turn function raises on cut or empty answers. Exceptions from fake storage are not listed in `discard_on`, so harness mismatches surface as adapter errors.
- Service feature flags go into the variant `params`.
- SC-004, SC-005 and SC-007 are measured here with 30 cases per language, over two real comparisons. The second one measures SC-005.
- Background jobs with short output limits break first after a swap (research R6). Whether to add a structured-output background call as a second target is decided after the first comparison.

## Delivery

Work that does not wait on other work runs in parallel branches, and the contracts between branches are fixed first.

1. **Freeze the contracts**: tasks.md for each feature, and the trial record and comparison JSON Schemas with fixtures. Done when every task points to an FR or SC and both schemas and their fixtures are committed.
2. **Three branches in parallel**
   - A, core (this feature): schemas, loader and lint, adapter client (cancel, restart), runner (send order, retries, cost checks, resume, lock), deterministic checks, grading and outcome classification, statistics, comparison, gate and decision summary, Markdown and JSON output, CLI, JSON Schemas, `bench/` for SC-003, CI.
   - B, result page (feature 002), built against the comparison fixture.
   - C, Python helper (feature 003).
   - Done when `swap` runs end to end against the mock adapter, SC-001, SC-002 and SC-003 pass, and the coverage check passes for this feature's FRs. Branches B and C meet their own success criteria against the fixtures.
3. **Integrate**: connect the result page to `compare`, `swap` and `report`, connect `init --adapter python` and `init --adapter node` to the helpers of feature 003, and test again on real comparison output. The TypeScript helper and `init --adapter node` are a separate branch here; if the real integration uses only the Python helper, step 4 starts before that branch ends. Done when the mock adapter and the example Python service run end to end and the success criteria of features 002 and 003 pass on real output.
4. **Real integration**: an adapter built on the helper, at least 15 deterministic rules, 30 cases per language, `lint --render` passing, and two real comparisons (the second measures SC-005). Done when SC-004, SC-005 and SC-007 are recorded with the cache hit ratio and every anchor warning is handled (fixed or `retired`).
5. **Docs and example pages**: README, `docs/guide/`, `docs/reference/` and the example result pages that CI keeps. Done when someone new to the repository has actually performed SC-006.
6. **Release preparation**: licence, package metadata, repository settings, and an independent review with its fixes. Done when every known defect is handled and `npm publish --dry-run` and publint pass.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The adapter's substitution point differs subtly from production | Verdicts do not reflect production | Fake storage raises on unexpected queries, anchors for required blocks, clocks and remote config fixed in case input (D2) |
| Production flag values unknown | Different prompt blocks than production | Flags in variant `params`, shown in the manifest and the result |
| A small margin multiplies trials | Many undecided cells or higher cost | Default margin 0.10; lint and `--dry-run` warn about unreachable cells (FR-006) |
| Evaluation load triggers rate limits | Fewer trials; with few repeats, chance clustering looks systematic | Concurrency limit, retries, transient-rate warning, stop above half. Scattered transient errors never block. Lower concurrency and rerun when warned |
| Deterministic rules miss semantic rules | The verdict overstates swap safety | Side-by-side view (feature 002) and the judged scope in every result |
| Only the chat path is connected | Part of the swap failures stays invisible | Judged scope in the result; background targets decided after the first comparison |
| Provider cache hits less than expected | Cost 2.6 to 3.3 times the expected value (research R4) | Repeat-major order, re-estimates, cap; cache hit ratio recorded in the integration |
| Features 002 and 003 drift from the contracts | Rework at integration | Comparison and trial JSON Schemas and fixtures are committed before the three features run in parallel, and each feature's tests read the same fixtures |
