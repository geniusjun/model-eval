# Data Model: Model Swap Check

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

This file defines entities, fields, enums, validation and state. File syntax is in [contracts/config.md](contracts/config.md), adapter messages in [contracts/adapter-protocol.md](contracts/adapter-protocol.md) and the reasons behind the statistics in [research.md](research.md) R3. "N characters" always means N Unicode code points, and text is cut on code point boundaries.

The tables give each field's meaning. The exact JSON shape of every written record is the generated `schemas/*.schema.json`, and changing it follows constitution VIII.

## Overview

```text
Config ─┬─ Adapter ── Target (languages, input schema)
        ├─ Variant (model + params)
        ├─ Rule ── Check
        └─ Case (one language) ──> Run ──> Trial ──> Grade (raw, final, trial) ──> Cell ──> Comparison ──> Gate
                                  (one variant) (case × repeat)                 (rule × language × surface)   └─> report.md, report.html
```

- A **rule** is a behaviour the service promises; its **check** decides it on an output.
- A **case** is one input to a **target**, in one language.
- A **run** repeats every case with one **variant**. One repeat of one case is a **trial**; sending a trial once is an **attempt**, and retries add attempts, not trials.
- A **grade** is one rule on one trial, per output surface.
- A **cell** is rule × language × surface; verdicts and the gate work per cell (research R7).
- A **comparison** holds the cell verdicts and the decision summary of a baseline run and a candidate run. The **gate** turns it into `pass`, `block`, `undecided` or `no-gate`.

## Entities

### Target

A service function under test, declared by the adapter in `initialize`.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Referenced by a case's `target` |
| `languages` | string[] | no | Language codes. With two or more, cases must set `lang`. Without it, `lang` is optional and cases without one use the language key `*`; rules with `languages` never apply to them, and anchors use `lang: "*"` |
| `inputSchema` | JSON Schema | yes | Shape of a case's `input`. The tool validates input with it and never interprets it |

### Variant

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique in the config, for example `current`, `next` |
| `model` | string | yes | Model identifier, also the price lookup key |
| `params` | object | no | Passed to the adapter as is (reasoning effort, service flags). Stored in the run, so never secrets |

- Baseline and candidate are roles chosen at comparison time, not variant properties.
- The variant fingerprint is the hash of `{id, model, params}`. "The previous run of the same variant" means the same fingerprint.

### Rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique, follows the ID pattern (§Identifiers and Hashing) |
| `title` | string | yes | One readable line |
| `severity` | `blocking` \| `major` \| `minor` | yes | Selects gated rules (`gate.severities`) and display order |
| `status` | `active` \| `retired` | no | Default `active`. `retired` rules are not run, graded or anchor-checked; the reason goes in `origin` |
| `scope` | `global` \| `listed` | no | Default `listed`. `global` applies to every case of a matching target and language |
| `targets` | string[] | no | Applicable targets; empty means all |
| `languages` | string[] | no | Applicable languages; empty means all |
| `anchors` | Anchor[] | no | Prompt sentences the rule relies on |
| `check` | Check | yes | One check; combine conditions with `all`, `any`, `not` |
| `gateOn` | `raw` \| `final` \| `both` | no | Surface the gate reads. Default `raw`. Ignored by `completed`, whose only surface is `trial` |
| `margin` | number | no | Non-inferiority margin in compliance difference (0–1). Else `gate.margin`, else 0.10 |
| `examples` | Examples | no | Texts the check must pass and fail |
| `origin` | Origin[] | no | Where the rule came from: commit SHA, date, layer (`prompt`, `code`, `pipeline`). Not used for grading |

- Grading records every surface regardless of `gateOn`.
- `gateOn` defaults to `raw` because the question is whether prompt rules hold; rules that post-processing enforces nearly always pass on shipped text. Rules whose policy is only what users see use `final` (research R8).

### Anchor

| Field | Type | Required | Description |
|---|---|---|---|
| `lang` | string | yes | Language whose prompt must contain the sentence |
| `quote` | string | yes | Fragment that must appear verbatim in the rendered prompt; whitespace is normalised, and a quote of whitespace alone is a `schema` error |
| `target` | string | no | Needed when there are several targets |
| `cases` | string[] | no | Cases that must contain it; default all cases of that language and target |

- `lint --render` renders the matching cases for every variant. A missing quote is `anchor-missing`, reported once per rule, language and quote with the variants and cases that miss it.
- Sentences inside conditional blocks (for example a block present only when a mood was picked) list the cases that turn the block on.
- Rules may have no anchor (for example code-only fixes); lint reports `unanchored` as info.

### Check

A sum type keyed by `type`. Deterministic checks always give the same result for the same input.

| `type` | Surfaces | Fails when | Main fields |
|---|---|---|---|
| `script` | raw, final | A character of a script not allowed appears | `allow` (Unicode scripts), `ignore`, `ignoreFrom` |
| `emoji` | raw, final | A `\p{Extended_Pictographic}` character appears. Kaomoji are not caught; U+00A9, U+2122 and U+2665 are | — |
| `pattern` | raw, final | The regex matches (`forbid`) or does not (`require`) | `regex`, `flags`, `mode` |
| `phrases` | raw, final | A listed phrase appears (`forbid`) or none does (`require`) | `any`, `anyFrom`, `mode`, `normalize` |
| `overlap` | raw, final | A shared run with the given text reaches the threshold | `with`, `withFrom`, `minChars` |
| `length` | raw, final | Length is outside the range | `min`, `max`, `unit` (`chars`, `graphemes`) |
| `json` | raw, final | Not JSON, or violates the schema | `schema` |
| `completed` | trial | See §Trial Outcomes | — |
| `review` | — | Never grades; collects baseline and candidate samples of the same cases | `samples` (default 3 per case) |
| `all`, `any`, `not` | as children | Logical combination; cannot contain `completed` or `review` | `checks`, `check` |

Exact semantics:

| `type` | Rule |
|---|---|
| `script` | Characters are code points and scripts are the Unicode `Script` property, not `Script_Extensions`. `ignore` strings and `ignoreFrom` values are removed from the text before checking |
| `pattern` | JavaScript regex syntax, always with the `u` flag. `flags` accepts only `i`, `m`, `s`; `g` and `y` are rejected because they make results depend on call order |
| `phrases` | With `normalize` (default true), both sides are NFKC-normalised and lower-cased and matched as substrings; otherwise matched verbatim |
| `overlap` | Both sides NFKC-normalised with all whitespace removed; fails when the longest common substring has at least `minChars` code points |
| `length` | `chars` counts code points, `graphemes` counts extended grapheme clusters (`Intl.Segmenter`) |
| `json` | JSON Schema draft 2020-12 |

- `…From` fields are paths into the case (`input.nickname`, `params.words`). A string value is a one-item list. A missing `ignoreFrom` or `withFrom` value is an empty list; a missing `anyFrom` value is a lint error (`unresolved-ref`), because an empty forbid list checks nothing. Empty strings in an `anyFrom` value are dropped, and a value with none left is `unresolved-ref`.
- Overlap with the rendered prompt is a later feature; until then a prompt-leak rule puts the prompt sentence in `with`.
- `Examples` is `{pass: string[], fail: string[], input?, params?}`; `input` and `params` supply values for `…From` references. Not allowed on `review` or `completed`.
- Check parameters have no defaults except `normalize` and `samples` above. Required: `allow` (`script`), `regex` and `mode` (`pattern`), `mode` (`phrases`), `minChars` (`overlap`), `unit` (`length`), `checks` (`all`, `any`) and `check` (`not`). A check that checks nothing is a `schema` error: `phrases` without `any` or `anyFrom`, `overlap` without `with` or `withFrom`, `length` without `min` or `max`.

### Case

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique, follows the ID pattern |
| `target` | string | yes | Target name |
| `lang` | string | conditional | Required when the target has two or more languages; defaults to the only language otherwise |
| `provenance` | `synthetic` \| `derived` | yes | Synthetic, or made from real data (constitution V) |
| `input` | object | yes | Must satisfy the target's `inputSchema` |
| `rules` | (string \| {id, params})[] | no | `listed` rules to grade on this case, with per-case values |
| `note` | string | no | What the case tests |

- Applicable rules = `global` rules whose targets and languages match, plus listed rules whose targets and languages match. A listed rule that does not match is not graded and lint reports `rule-filter-mismatch`.
- One input grades many rules, so rules do not need their own cases.

### Run

A run is one directory, `runs/<runId>/` under `output.dir`: `manifest.json`, `trials.jsonl`, `grades/`, `adapter.log` (one redacted JSON object `{at, level, message}` per line), and `run.lock` while running.

A swap check also writes `swaps/<swapId>.json`: `{swapId, baselineRunId, candidateRunId, budget, spentUsd, segments[], status, stopReason?, comparisonId?}`. The cap check of a swap uses `spentUsd`, the total of both runs.

Atomic writes: [plan D6](plan.md#d6-runs-are-files-and-grading-is-separate-from-running).

#### Manifest

| Field | Description |
|---|---|
| `runId`, `swapId` | See §Identifiers and Hashing. `swapId` only on runs made by a swap check |
| `tool`, `adapter`, `service` | Name, version and protocol version. `adapter` always has `launchHash`, the hash of `adapter.command`, `adapter.env` and the real path of `adapter.cwd` (resolved from the config folder with links and letter case resolved, `fs.realpathSync.native`, so a link or a different letter case to the same folder does not block resume), the helper language and version when a helper is used, and the `capabilities` it declared in `initialize`. Environment values appear only hashed. `service` is what the adapter declares: git SHA, dirty flag and `treeHash`; unknown fields are omitted |
| `variant` | The full variant and its fingerprint |
| `cases` | `{id, target, lang, hash}` per case |
| `rulesHash` | Informational only; not compared on resume, since rules do not affect generation. Resume sets it from the current rules |
| `prompts` | Render fingerprint per case, when the adapter renders |
| `sampling` | Repeats, global seed, case filter from `--cases` (`null` when absent) |
| `limits` | `run.retries` and `adapter.timeoutMs`. They decide when a trial is finished, so resume keeps them |
| `pricing` | Copy of the whole `pricing` table at run time, since unpriced calls are charged from it. Resume sets it from the current config; each segment keeps its own copy |
| `budget` | Cap and scope. Omitted in config means 1 USD; `null` means no cap. Both runs of a swap share one cap |
| `estimate` | `{expected, conservative, basis}` before the start, and `projected[]` for every re-estimate. `basis` maps each language key (`*` for cases without a language) to `history` or `structure` (§Cost) |
| `costProfile` | Per variant and language for a finished run: `{repeat0MeanUsd, repeatNMeanUsd, inputTokensMean, outputTokensMean, outputTokensP95, cacheHitRatio, callsPerTrialP95, callsPerAttemptMax}`. Values per trial sum every line of its key; a trial's input tokens are `input` + `cachedInput` + `cacheWrite`. `cacheHitRatio` = `cachedInput` ÷ (`input` + `cachedInput` + `cacheWrite`), summed over all lines of finished keys. Both call counts are at least 1. Every p95 in records is the nearest-rank 95th percentile |
| `totals` | Trials per outcome (effective lines), token buckets and cost of all lines with the estimated part (`costEstimated`: reservations and substitute prices), `overrunUsd`, duration (the sum of ended segments; a segment ended by a kill has no end time and adds nothing) |
| `segments[]` | One per segment, the first run being segment 1: start and end, tool, adapter and helper versions, prices, cap, concurrency, `toolPaths` sent (including on restarts), spend, `resume-unverified` and `resume-config-ignored` details |
| `warnings` | Warnings this run raises from its own records (§Warnings). Rewritten at segment start (after pre-start checks), whenever a new code appears and at segment end, so a run left `running` still has them. In such a run, values like the overrun are as last written; resume recounts them. `run --json` carries them after the pre-start `few-cases`, `margin-unreachable` and `conservative-over-budget`, which the manifest does not hold |
| `status` | `running` → `complete` \| `partial` |
| `stopReason` | When `partial`: `interrupted`, `budget`, `budget-projected`, `adapter-errors`, `transient-errors`, `config-error` |

#### Run and Swap Status

```text
running ──(all trials finished, adapters shut down, late notifications and responses received)──> complete
running ──(stop condition, §Stopping)──> partial
running ──(process killed)──> stays running; resumable when the lock owner is gone
```

A late `calls` notification or late response that creates a stop condition (for example a `config` failure) turns `complete` into `partial`.

**Swap status** is `running` → `complete` (after the comparison is written) or `partial` (both runs stopped with the same `stopReason`). A killed swap stays `running`.

- A stopped swap still waits for late notifications and responses of both runs, then compares what finished and writes the report and result page, so the cells that were degrading up to the stop are visible at once. The gate is `undecided`, the page is marked as withheld, and the exit code is that of the stop reason.
- It does not compare when neither run finished a trial, on `config-error`, or on a second interrupt or kill.
- A resume that stops at once with `budget-projected` still compares the earlier segments, because a killed earlier segment left no result page.
- A compared swap has `comparisonId` even when `partial`.

### Trial

A trial is the key `(caseId, repeat)`. `trials.jsonl` is append-only and has three line kinds:

| Line | Written | Shape |
|---|---|---|
| Send line | Just before an attempt goes to the adapter, after the write is flushed, so a kill cannot lose the reservation | `{caseId, repeat, attempt, segment, reservedUsd, sending: true}`; `reservedUsd` is `null` only without a cap and without any configured price (§Unpriced Models) |
| Attempt line | When an attempt ends | Fields below |
| Cost line | When calls or cost appear after the attempt line | `{caseId, repeat, attempt, segment, source, costUsd, costEstimated?, usage?, calls?, costCorrection: true}` |

- **Effective line**: the last attempt line of a key decides the trial's outcome. Grades, finished trials, error rates, systematic failures and outcome counts use one effective line per key.
- **Cost, tokens and calls** sum all lines. A line's tokens are its `usage`; cost lines get the sum of their `calls[].usage` as `usage`. Retries and calls after the result are included so the next estimate follows real spend. A trial's value is the sum over its key; per-trial values (`costProfile`, metrics, re-estimates) average those sums over finished keys only, because unfinished keys miss part of their cost.
- **Cost lines** let comparisons write the `abandoned-trials` message and let runs and resumes recount billed calls per attempt from the records alone; they are never graded. They have `source`: `late` for a late response to an abandoned attempt (its `usage` and `calls`, and `costUsd` = cost above the reservation, else 0), or `calls` for calls the adapter reported outside a result (protocol `calls` notification). A notification that arrives before its attempt's result is written after the attempt line. A call that belongs to no known trial is written without a key: `{segment, source, costUsd, usage?, calls, costCorrection: true}`; it counts in the run total and, for per-trial values, is spread evenly over the finished keys of the averages before averaging per variant, language and repeat group.
- **Cut last line**: bytes after the last `\n` are a cut line, even if they form valid JSON. Resume truncates them before appending, because appending would glue two lines and break the middle one; read-only commands (`grade`, `compare`) ignore them. A broken line in the middle is a configuration error (exit code 4) with its line number.
- **Closing send lines**: on resume, every send line without a matching attempt line gets a `stopped` attempt line charged at its `reservedUsd` with `costEstimated: true`, in the send line's segment, so the next segment does not add the same reservation again.
- Every line has `segment`, the segment that wrote it (the closing line uses the send line's segment).

#### Attempt Line Fields

| Field | Description |
|---|---|
| `caseId`, `repeat` | The trial key |
| `attempt` | Attempt number for this key, from 1, continuing across segments |
| `segment` | Segment number, from 1 |
| `seed` | Per-trial seed (§Identifiers and Hashing) |
| `status` | `ok` \| `error` \| `stopped`. `stopped` is an attempt the tool did not wait for when stopping (second interrupt), one closed on resume after a kill, or one never sent because the adapter could not be restarted. It is not graded, not counted in error rates, and resent on resume |
| `raw` | The model's first answer. Required when `ok`, may be empty. A regenerated or picked answer does not replace it (protocol `generate`) |
| `answers` | Number of answers the service received, integer ≥ 0, default 1. 0 means it ended without a model answer; 2 or more means it regenerated or picked |
| `finalKind` | `model` (the model's answer, possibly regenerated), `fallback` (a fixed message or another model's answer) or `discarded`. Required when `ok` |
| `final` | Text the service sends to the user; absent when `discarded` |
| `discardReason` | When `discarded`: exception type and the start of its message |
| `stages` | Optional `[{name, text}]` per post-processing stage; shows which stage removed a violation |
| `usage` | `{input, cachedInput, cacheWrite, output, reasoning}`. The first four never overlap; `reasoning` is part of `output`. With several calls, the sum of calls that have usage |
| `calls` | Optional per-call records in send order (helpers fill them). An empty array means no model was called; unknown means absent. See below |
| `latencyMs` | Duration of the whole service function. Required when `ok` |
| `finishReason` | `stop` \| `length` \| `content_filter` \| `other`, for the shipped text. Required when `ok` |
| `modelSnapshot` | Model of the response that produced `raw`. Optional |
| `fingerprint` | Fingerprint of the first request of the branch that produced the first answer. Optional; compared with the render fingerprint (`render-mismatch`) |
| `warnings` | Adapter warning sentences for this attempt. Optional |
| `costUsd`, `costEstimated` | Attempt cost (§Cost); `costEstimated: true` when a reservation was used |
| `error` | When `error`: `{kind, message, retryAfterMs?, abandoned?, capturedRaw?}` |

**Call record**: `{model, outcome, responseModel?, errorKind?, retryAfterMs?, branch?, usage?, finishReason?, latencyMs?}`. Only `model` and `outcome` are required.

- `model` is the requested model and the price key; `responseModel` is the model the response named.
- `outcome` is `ok`, `failed` or `unanswered`. `failed` is a failure that was not billed or whose billing is known: rejected with an error status, never reached the provider (no connection, request not fully sent, TLS failure), or a failed response with usage. `unanswered` got no answer, may have been billed and the amount is unknown: time-out, cancel or drop before or during the response, or a response that started with HTTP 200 and ended in failure without usage (Responses `status: failed`, a failure end event in a stream).
- `errorKind` is the failure kind; `retryAfterMs` the wait the failure asked for (integer ms ≥ 0); `branch` is `answer` or `side`, present only when the answer branch is known; `finishReason` is the provider's raw value.

#### Error Kinds

| `kind` | Meaning |
|---|---|
| `config` | Authentication, permission, unknown model, quota or billing exhausted, TLS certificate failure |
| `adapter` | Adapter exception, protocol violation, no answer (abandoned), undeclared service exception, no request reached the variant model, answer call ambiguous, request outside any trial context |
| `transient` | §Transient Failures |
| `permanent` | The request shape was rejected, for example an unsupported parameter combination |
| `timeout` | The model did not answer within the service's time limit, after the service's and the SDK's retries; also a trial the service stopped reading because it was late and that has no secured answer ([adapter-protocol §Answers](contracts/adapter-protocol.md#answers)) |

- `abandoned` is `timeout` (no adapter answer within `adapter.timeoutMs`) or `restart` (the adapter died or was restarted after stdout contamination). Both have kind `adapter`.
- `capturedRaw` is the raw answer of an adapter-error trial whose model call succeeded. It is for debugging and never graded.
- `retryAfterMs` is the value of the call that decided the outcome.

### Grade and GradeSet

- A grade: `{caseId, repeat, ruleId, surface: raw | final | trial, outcome: pass | fail | skip | error, evidence?}`. `evidence` holds the violating characters or matched strings; for `length` it is the measured length, and for `json` each schema violation by instance path and message. `error` means the check itself could not run; it leaves the denominator.
- A grade set: `{gradeSetId, runId, rulesHash, checkerVersion, trialsFingerprint, casesHash}`. The last five values identify it and an existing one is reused. `checkerVersion` is the tool version; any tool change re-grades, which is cheap for deterministic checks. `trialsFingerprint` covers every line, so a resumed run gets a new grade set. `casesHash` uses the current case files because checks read case input through `…From`. The file `grades/<gradeSetId>.jsonl` holds the grade set on its first line and its grades after it.
- Trials of a case whose current hash differs from the manifest, including deleted cases, are not graded and leave the comparison too (FR-027). They get `skip` for every rule that applies to the case as defined now; a deleted case gets it for every `global` rule matching its target and language.
- A grade set looks at one run. Systematic failures need both runs and are applied by the comparison (§Trial Outcomes).
- Like `trials.jsonl`, a grade set holds `evidence` as checked. Redaction applies when evidence reaches a comparison or any output (FR-031), so a change to `redact` needs no re-grade and a reused grade set never carries old redaction.
- `grade` and `compare` start no adapter, so a case without `lang` keeps the language key its run recorded.
- `compare` only uses grade sets made with the current rules (FR-019).

### Cell

| Field | Description |
|---|---|
| `ruleId`, `lang`, `surface` | Cell key |
| `gated` | Whether the cell is gated (§Gate) |
| `cases` | K, the common cases with at least one judged trial in this cell for both variants |
| `droppedCases` | Cases dropped because one variant had no judged trial. Rejections, time-outs, discards, fallbacks and empty answers without regeneration are caught by the `completed` cell; an empty first answer followed by a regenerated one remains in the empty-answer and regeneration rates; transient and adapter errors stay only in this count unless systematic |
| `systematic` | `completed` cells only: trials and cases per variant counted as systematic failures |
| `excluded` | `completed` cells only: per variant, the transient and adapter error trials left out because they were not systematic |
| `baseline`, `candidate` | Rate |
| `diff` | `{estimate, low, high}`. `low` at the configured level; `high` multiplicity-corrected when gated (§Statistics) |
| `deff` | Case-cluster design effect |
| `failRatio` | Candidate failure rate ÷ baseline failure rate, with failure rate 1 − `rate`. `null` when the baseline has no failure, shown as "baseline 0" |
| `masked` | `raw` cells only: per variant, the share of trials graded on both surfaces that failed raw and passed final. Shown as "masked by the service" |
| `margin` | Margin used |
| `verdict` | `improved`, `non-inferior`, `regressed`, `inconclusive`, `insufficient`, `not-applicable` |
| `needed` | Undecided gated cells only, one of the kinds of §Statistics, Trials needed: `{kind: repeats, repeats, cellTrials, trialsPerVariant, nearMargin}`, `{kind: cases, cases}` or `{kind: on-margin}`. `cellTrials` = K × repeats; `trialsPerVariant` = the candidate run's cases × repeats. The message files hold the text; the `repeats` text's `currentTrials` is the cell's `candidate.trials` |
| `note` | A code; the message files hold its text. When `high < 0`: `drop-within-margin` (`non-inferior`), `drop-margin-undecided` (`inconclusive`), `drop-too-few-samples` (`insufficient` with K ≥ 3). With K < 3 only `clear-drop-too-few-cases` (§Statistics) |

- `Rate` is `{cases, trials, passes, rate, pooledRate, low, high, nEff}`, counted over the K common cases; its statistics are `null` when K = 0. `rate` is case-weighted and drives the verdict; `pooledRate` = passes ÷ trials is for reference; `nEff` is ñ.
- Display names: `improved` Better, `non-inferior` Held, `regressed` Regressed, `inconclusive` Inconclusive, `insufficient` Too few samples, `not-applicable` Not applicable. "Undecided" covers `inconclusive` and `insufficient`; neither ever counts as passing.

### Comparison

| Field | Description |
|---|---|
| `comparisonId` | Deterministic ID (§Identifiers and Hashing) |
| `createdAt` | When the comparison was written (volatile) |
| `baseline`, `candidate` | Run ID, grade set ID, variant, run `status`, versions from the manifest (`tool`, `adapter` with its helper, `service`) and the `postprocess` capability the adapter declared |
| `cells[]` | Cells |
| `aggregates[]` | Per rule and surface, the pooled rate and difference over languages. No verdict |
| `rules[]` | `active` rules applicable to the compared targets (the targets of the common, unchanged cases): `{id, title, severity, languages, gateOn, margin, anchors, origin}`, with `margin` as used (§Statistics, Verdict order) |
| `summary` | In order: `worse[]` (regressed cells, cells with a confirmed drop, cells with note `clear-drop-too-few-cases`), `improved[]`, `unknown[]` (undecided cells with `needed`), `ops[]` (changes such as cost ratio, latency ratio, discard rate), `scope`. An undecided cell with a confirmed drop appears in both `worse[]` and `unknown[]` |
| `gate` | The Gate of this comparison (§Gate) |
| `completion` | Per language, the baseline completion rate of §Gate (row 3) with its judged trials and passes |
| `ops` | Per variant: rejection, time-out, transient, adapter error, discard, fallback, empty answer and regeneration rates (each with a Wilson interval); systematic trials and cases; discard reasons; top 3 messages per error kind by frequency; side-call failures per kind; abandoned trials per cause; finish reasons; latency p50, p95 and distribution; token buckets and cost per trial; response model snapshots |
| `samples` | Texts for side-by-side viewing: `review` samples per case and failing examples of regressed cells, redacted. Each (variant, `caseId`, `repeat`) text is stored once and referenced by key. `review` takes the lowest repeats, `samples` per case, raw and final. Error trials carry the kind and message instead. Failing examples are candidate failures, up to `report.samples` per cell, sorted by case and repeat and taken round-robin across cases, each stored with the baseline text of the same case and repeat |
| `warnings[]` | `{code, params?, ruleId?, lang?, variants?, caseIds?, file?, line?, column?}`, codes from §Warnings only. `file`, `line` and `column` are for file-location warnings |
| `coverage` | Common cases, cases in one run only, cases dropped for a changed hash |
| `scope` | Judged targets, judged rules / all rules, `review` rules |
| `priorComparisons` | Number of distinct run pairs among earlier comparisons in the output directory with the same two variant fingerprints in the same roles, excluding the current run pair. Re-grading or finishing the same runs is not a new sample; rerunning only the candidate is |
| `stats` | Confidence level, method, G, both z values, `minCases` |
| `config` | Copies of `gate`, `stats` and `report` used |

- The report, the result page and `report` read rule details, versions and settings from the comparison alone. `rules[]` comes from rule definitions that `rulesHash` covers, versions and `postprocess` from the manifests of the runs the grade sets name, and `config` from the `gate`, `stats` and `report` settings the `comparisonId` input already holds, so these fields add no input to the ID. `gate` and `completion` are derived from those inputs and add none either.
- Metrics use the same common, unchanged cases as the cells (FR-027).
- Denominators: rejection, time-out, discard, fallback, empty answer and regeneration rates divide by the variant's trials graded on `completed` in the comparison (systematic failures in, other transient, adapter and config errors out). Transient and adapter error rates divide by all finished trials of the common cases, in every segment, and systematic trials stay in their numerators.
- Cost and tokens per trial average keys finished in both runs; token means are not rounded. Latency uses the `ok` trials among them; the time of trials that ended in errors shows through the time-out and error rates. This keeps a partial run whose repeat 0 alone finished from looking expensive because of cache writes.
- Rates are counted independently of the outcome table, and one trial can fall in several: discard = `discarded`, fallback = `fallback`, empty answer = `ok` trials with an empty raw answer and `answers` ≥ 1, regeneration = `ok` trials with `answers` ≥ 2.
- Metric warnings compare point estimates with thresholds; they never change the exit code, so no interval is used (constitution II). Defaults: `discardRateIncrease` 0.01, `regenerationRateIncrease` 0.03 (reasons in research R3).
- Saved as `comparisons/<comparisonId>/comparison.json` (redacted) with `report.md` and `report.html`; the output root's `index.html` lists comparisons.
- `report.md` puts every model, service or provider string (examples, samples, error messages, discard reasons) in a code block or span whose fence is longer than the longest backtick run inside, so mentions, links and HTML do not render in pull request comments.
- A swap check shuts down both adapters and receives late notifications and responses before writing both run statuses and comparing, so call costs after results are included and a later `compare` of the same runs gives the same ID.

### Gate

- **Empty gate**: `gate` absent, `gate.severities` absent or empty. Cells are still judged, with the margin from the rule, `gate.margin` or 0.10.
- **Gated rules**: `active` rules applicable to the compared targets whose `severity` is in `gate.severities`. `review` rules and uncalibrated judge rules are removed into `excluded[]` with a reason (constitution III).
- **Gated cells**: cells of gated rules whose surface matches `gateOn` (`trial` for `completed`) and whose verdict is not `not-applicable`, except low-baseline cells. A low-baseline cell is a cell of a rule other than `completed` whose baseline `rate` is below `report.lowBaseline`: the baseline does not hold that rule yet, so there is no held fix to protect, and the report lists these cells separately (FR-029). `completed` has its own premise check (row 3).
- **Completion rate**: the share of `pass` in the `completed` column among judged trials (all except transient, adapter and config errors and `stopped`; systematic failures included), computed even without a `completed` rule. Preconditions 1–3 use common, unchanged cases only; two runs without a common case fall under 2.

The first matching row decides. Rows 1–3 check the premise of the comparison and come before the gate config, so even with an empty gate a comparison without a basis is `undecided` (constitution II). The human message for each reason code lives in the message files (`src/messages/`).

| Order | Condition | Outcome | Reason code | Params |
|---|---|---|---|---|
| 1 | A run is not `complete` (`partial`, or `running` because it was killed or is still running) | `undecided` | `partial-run` | As the warning `partial-run` (§Warnings) |
| 2 | A run has no judged trial | `undecided` | `no-judged-trials` | `{variants: list of variant IDs}` |
| 3 | The baseline completion rate is below 0.5 in some language | `undecided` | `baseline-incomplete` (with the language) | `{rate}` |
| 4 | The gate is empty | `no-gate` | `no-gate` | — |
| 5 | No gated cell | `undecided` | `no-gated-cells` | — |
| 6 | A gated cell is `regressed` | `block` | `regressed` (one per cell) | — |
| 7 | A gated cell is `inconclusive` or `insufficient`, or a gated rule has no judged cell | `undecided` | `cell-undecided` (per cell), `rule-not-judged` (per rule) | — |
| 8 | Otherwise | `pass` | — | — |

| Field | Description |
|---|---|
| `outcome` | `pass` \| `block` \| `undecided` \| `no-gate` |
| `reasons[]` | `{code, params?, ruleId?, lang?, surface?}` with the codes above plus two informational ones that never change the outcome: `dominant-error` and `abandoned-in-systematic` |
| `blocking[]` | Regressed gated cells |
| `undecided[]` | Undecided gated cells with `needed`, and gated rules without a judged cell |
| `excluded[]` | Rules removed from the gate: `{ruleId, cause}`, `cause` as in the warning `excluded-from-gate` (§Warnings) |

- A partial or still-running run never blocks. A CI time-out kills the process and leaves the run `running`; comparing it as finished could pass a half-run. Variants of a stopped run may also have finished different cases. Cell verdicts stay visible and regressed cells are listed in the reasons.
- When rows 1–3 decide, `reasons[]` holds that reason followed by one `regressed` per regressed gated cell, and `blocking[]` and `undecided[]` stay empty. From row 5 on, `reasons[]` lists every matching row's reasons in table order, and `blocking[]` and `undecided[]` list their cells whatever the outcome.
- 0.5 in row 3 is a premise check, not a statistical threshold: when the baseline fails to answer half the time, "the candidate is no worse" means nothing.
- Row 4 is not `pass` because nothing was judged; it exits 0 because nothing can block (constitution II, IV).
- Row 7 includes rules without a judged cell because a gated rule must be able to block; a run limited by `--cases` that misses a gated rule is `undecided`.
- `dominant-error`: when at least 80% of the failing candidate trials of the blocking cells end with the same error message (redacted, first 200 characters), the reason goes first in `reasons[]` and at the top of the summary, with params `{message, share}`. A new shape of billing or quota error classified as a rejection would otherwise look like a worse model. The outcome does not change.
- `abandoned-in-systematic`: abandoned trials inside the systematic failures of a gated `completed` cell, with params `{trials: per variant {timeout, restart}, timeoutMs: per variant}` listing both variants, a variant without abandoned trials with zero counts, `timeoutMs` being each run's `adapter.timeoutMs`.
- Exit codes per outcome: [contracts/cli.md](contracts/cli.md).

## Statistics

Per cell. Reasons, simulations and rejected alternatives: [research R3](research.md#r3-verdict-statistics).

**Notation**: For one cell and variant v ∈ {baseline b, candidate c}, case i has n_vi judged trials and x_vi passes. `skip` and `error` grades are left out. K is the number of common cases with at least one judged trial in this cell for both variants; cases judged on one side only are dropped and counted in the cell's `droppedCases` (§Cell).

**Estimators**: y_vi = x_vi / n_vi, p̂_v = (1/K) Σ y_vi, Δ̂ = p̂_c − p̂_b, effective trials ñ_v = K² / Σ(1/n_vi) (K·r when repeats are equal).

**Interval**:

```text
d_i   = y_ci − y_bi
V_cl  = Σ(d_i − Δ̂)² / (K(K−1))
V_bin = p̂_c(1−p̂_c)/ñ_c + p̂_b(1−p̂_b)/ñ_b
deff  = max(1, V_cl / V_bin)                 (1 when V_bin = 0)
n*_v  = ñ_v / deff,  x*_v = p̂_v · n*_v,  [l_v, u_v] = Wilson(x*_v, n*_v, z)
L = Δ̂ − √((p̂_c − l_c)² + (u_b − p̂_b)²)      with z = z_L
U = Δ̂ + √((u_c − p̂_c)² + (p̂_b − l_b)²)      with z = z_U
```

- The per-variant rate interval is Wilson(p̂_v·ñ_v/deff_v, ñ_v/deff_v, z_L) with deff_v = max(1, (s²(y_v)/K) ÷ (p̂_v(1−p̂_v)/ñ_v)).

**Levels**: α = (1 − confidence)/2. The lower bound uses z_L = z_{1−α} without correction. The upper bound of a gated cell uses z_U = z_{1−α/G}, where G is the number of gated cells; ungated cells use z_U = z_L.

**Verdict order** (margin m from the rule's `margin`, else `gate.margin`, else 0.10):

| Order | Condition | Verdict |
|---|---|---|
| 1 | Neither run has a judged trial in this cell | `not-applicable` |
| 2 | K < 3 | `insufficient` |
| 3 | U < −m | `regressed` |
| 4 | K < `minCases` | `insufficient` |
| 5 | L > 0 | `improved` |
| 6 | L > −m | `non-inferior` (note `drop-within-margin` when U < 0) |
| 7 | min(ñ_b, ñ_c) < n_min(m) | `insufficient` |
| 8 | Otherwise | `inconclusive` |

- A cell with U < 0 has a confirmed drop whatever its verdict and goes under worse cells in the decision summary with its `note` (§Cell). With K < 3 the interval is not trusted, so only the note `clear-drop-too-few-cases` marks a confirmed drop. Otherwise a confirmed drop would hide under "undecided".
- With K < 3, if U computed without the design effect is below −m, the cell gets the note `clear-drop-too-few-cases`.
- n_min(m) = ⌈z_L²(1−m)/m⌉: 73, 35 and 22 for m = 0.05, 0.10 and 0.15 with z_L = 1.96. A cell planned below it gets the lint warning `margin-unreachable`.

**Trials needed** (FR-024), for undecided gated cells only:

- Cases first. If K < max(3, `minCases`), more repeats fall back into verdict rows 2 or 4, so the cell asks for max(3, `minCases`) cases (kind cases), or for the larger count below when that is higher. The repeat formula applies only to cells with enough cases.

```text
z     = z_L if Δ̂ > −m, else z_U
p̃_v   = (x_v + z²/2) / (n_v + z²)            (x_v, n_v: pooled passes and trials of the cell)
W     = p̃_b(1−p̃_b) + p̃_c(1−p̃_c),  r̄ = harmonic mean of candidate trials per case
σ²_B  = max(0, s_d² − W/r̄)                   (s_d²: sample variance of d_i; the between-case part repeats cannot reduce)
d     = |Δ̂ + m|,  z_t = z + 0.84             (0.84 gives 80% power)
d = 0 → kind on-margin: exactly on the margin, repeats are unlikely to settle it (no number)
c     = K·d²/z_t² − σ²_B
c > 0 → kind repeats with r′ = max(⌈W/c⌉, ⌈n_min/K⌉, ⌊r̄⌋ + 1): a new run with r′ repeats gives this cell
        K·r′ trials per variant (now n_c) and the whole run (cases)·r′ trials per variant; about 80% chance of a verdict (estimate)
c ≤ 0 → kind cases with ⌈z_t²(σ²_B + W/r̄)/d²⌉ cases: repeats cannot settle it
r′ > 10·r̄ → nearMargin: near the margin, repeats are unlikely to settle it
```

## Trial Outcomes

The first matching row decides. "Judged" means `pass` or `fail`; "excluded" means a `skip` grade outside the denominator.

| Order | Outcome | Example | Tool retry | `completed` | Raw rules | Final rules | Metric |
|---|---|---|---|---|---|---|---|
| 1 | `error` · `config` | Authentication, unknown model, quota or billing, TLS certificate | None; the run stops and resume resends after the fix | — | — | — | — |
| 2 | `error` · `adapter` | Adapter exception, protocol violation, abandoned, undeclared service exception, no request to the variant model, ambiguous answer call, request outside a trial | None, also not on resume | excluded (systematic: fail) | excluded | excluded | Adapter error rate, abandoned trials |
| 3 | `error` · `transient` | 429, 5xx, connection failure or drop | `run.retries` times (default 2) with exponential backoff, or `retryAfterMs`, capped at 120 s | excluded (systematic: fail) | excluded | excluded | Transient error rate |
| 4 | `error` · `permanent` | Request shape rejected | None | fail | excluded | excluded | Rejection rate |
| 5 | `error` · `timeout` | No model answer within the service's limit; or the service stopped reading a late answer without a secured answer | None | fail | excluded | excluded | Time-out rate |
| 6 | `ok`, empty `raw`, `answers` 1 | Reasoning used the whole output limit | — | fail | excluded | excluded | Empty answer rate |
| 7 | `ok` · `discarded` | Service threw away a cut or emptied answer (declared discard) | — | fail | judged | excluded | Discard rate and reasons |
| 8 | `ok` · `fallback` | Fixed message or another model's answer after a failed check | — | fail | judged | excluded | Fallback rate |
| 9 | `ok` · `model`, empty `final` | Service sent empty text | — | fail | judged | excluded | Empty answer rate only when `raw` is empty too |
| 10 | `ok` · `model`, finish reason not `stop` | Shipped cut (`length`) or filtered | — | fail | judged | judged | Finish reasons |
| 11 | `ok` · `model`, finish reason `stop` | Normal answer | — | pass | judged | judged | — |

- Raw rules exclude an empty raw answer: an empty string always passes forbidding checks.
- "Empty" means nothing remains after trimming the 25 Unicode `White_Space` code points from both ends: U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. Whitespace-only answers pass forbidding checks and are empty to users. Records keep the value as received.
- Raw rules read the first answer; `completed` and final rules read the shipped text. With `answers` ≥ 2, an empty first answer does not make row 6; rows 7–11 apply to the shipped result and the empty first answer stays in the empty-answer and regeneration rates. With `answers` 0, an empty raw answer goes to rows 7–8, since the model did not produce an empty answer.
- A trial with any call whose `errorKind` is `config` is row 1, whatever the adapter reported; the tool records the reported result in the message, so resume resends the trial after the fix. Calls reported after the result (adapter-protocol `calls`) and late responses to abandoned attempts never change the outcome; they only stop the run.
- `stopped` is outside this table: it leaves every rule and metric and is resent on resume.
- Why rejections fail `completed` and configuration problems are kept apart from them: [research R8](research.md#r8-trial-outcomes-and-the-default-gated-surface).
- Time-outs count as completion failures because the service's limit and retries are production behaviour (research R8). The tool's own `adapter.timeoutMs` is not, so passing it abandons the trial as an adapter error with warning `abandoned-trials`; concentrated on one case of one variant it becomes systematic. Set `adapter.timeoutMs` longer than one service call can take, so the service's own time-out fires first; [003 helper-api §SDK Retries and `adapter.timeoutMs`](../003-adapter-helpers/contracts/helper-api.md#sdk-retries-and-adaptertimeoutms) explains how SDK retry waits add up.
- A late answer that the service cut and resent, where the resent request then failed transiently, counts as transient, not as a time-out ([adapter-protocol §Answers](contracts/adapter-protocol.md#answers)); a regeneration after a secured answer follows [adapter-protocol §Reporting Model Failures](contracts/adapter-protocol.md#reporting-model-failures), rule 4.

### Transient Failures

The numbered list below is complete. A trial is transient when a failure on the list reached the service and kept it from answering. It is also transient when:

- the service swallowed that failure of the answer request without a secured answer and shipped a fixed message or another model's answer;
- another call's failure (a parallel duplicate request, or a side call before, after or alongside the answer) made the service skip, cut, replace or discard the answer.

In both cases the user missed the model's answer because of that error. Which failure decides when the service had a secured answer, or when several calls failed: [adapter-protocol §Reporting Model Failures](contracts/adapter-protocol.md#reporting-model-failures), rules 3 and 4.

1. **429**, except quota exhaustion. A response that started with 200 and then failed with a rate-limit code counts as 429.
2. **5xx**. A response that started with 200 and then failed with a server-error, overload or provider-side time-out code counts as 5xx. The provider codes for 1 and 2 are in [003 helper-api §Error Classification](../003-adapter-helpers/contracts/helper-api.md#error-classification).
3. **Connection failure or drop**: the request never arrived (refused, DNS failure, connect time-out, pool wait time-out, request not fully sent, or HTTP 408 saying the server did not receive the whole request); the connection closed after sending and before response headers; the body was cut while receiving; or a read time-out on a non-stream body.
   - A read time-out while waiting for the next event of a stream (SSE) is `timeout`: stream events arrive as the model generates them, so a long gap means a slow model, and retrying would give it more chances than production.
   - Connect and pool time-outs never reached the model, so they are not `timeout`.
   - A drop before headers counts as a connection drop even if a proxy cut a slow response, because it was not the service's own limit; concentrated on one case it becomes systematic.
   - 408 is the server-side view of a request that was not fully sent, so it counts the same way.

- A TLS certificate failure also never reaches the model, but it is `config`: retrying does not help and it is an environment problem, so the run stops at the first one.
- Other statuses the SDK retries, such as 409, are `permanent` when they remain after the SDK's retries; a 409 whose cause code means a configuration problem is `config` ([003 helper-api §Error Classification](../003-adapter-helpers/contracts/helper-api.md#error-classification)).
- Transient failures are excluded so that rate limits caused by evaluation load and short provider outages do not count against the candidate.
- Tool retries wait `retryAfterMs`, or when it is absent 1 s doubled per retry with each wait drawn uniformly between half and all of that value, but never more than 120 s. The random half keeps trials that hit the same 429 together from retrying at the same moment. The ceiling keeps a daily-limit 429 with a long `retry-after` from freezing the run; such a rejection fails again and shows in the transient rate. 120 s matches the OpenAI Python SDK's own ceiling for honouring `retry-after`.

### Systematic Failures

When one variant has at least two finished trials of a case, all ending in `transient` or `adapter` (mixed is fine), and the other variant has a `completed`-graded trial of that case, those trials fail `completed`. Raw and final rules still exclude them. This is the complete definition.

- Reasons, including why chance clustering is not filtered out: [research R8](research.md#r8-trial-outcomes-and-the-default-gated-surface). When evaluation load is suspected, lower the concurrency (transient-rate warning).
- Grade sets cannot apply it because it needs both runs; the comparison turns those `skip` grades into `completed` failures when it builds cells. They count in the completion rate and in the `completed`-based metric denominators, stay in the transient and adapter error numerators, and their number is recorded as `systematic`.
- An undeclared exception (for example fake storage rejecting a query) is an adapter error, not a discard ([research R8](research.md#r8-trial-outcomes-and-the-default-gated-surface)).

### Stopping

A finished trial is a key whose effective line leaves no tool retry. A `transient` effective line still has a retry when the key's `transient` attempt lines over all segments number fewer than the recorded retries + 1; counting across segments keeps a resumed trial from getting more retries. `stopped` is never finished.

Adapter and transient error rates are shares of finished trials, checked only after 20 finished trials, separately per run in a swap, and over the current segment's effective lines on resume.

| Condition | `stopReason` | Exit code |
|---|---|---|
| A `config` failure (also on side calls, `calls` notifications and late responses), a call to an unpriced model while a cap is set (also when reported that way), or a restarted adapter that declares a different adapter or helper version or service code (same rules as resume) | `config-error` | 4 |
| Adapter error rate above `run.maxAdapterErrorRate` (default 0.05), or the adapter process lost three times in a row (death, stdout contamination or every slot abandoned) without an answer in between; the third loss starts no new process | `adapter-errors` | 3 |
| Transient error rate above `run.maxTransientRate` (default 0.5) | `transient-errors` | 3 |
| Re-estimated total above the cap after the first batch, after a repeat round, or at resume | `budget-projected` | 5 |
| Before an attempt (tool retries included), the §Cap Check fails | `budget` | 5 |
| The user interrupted | `interrupted` | 3 |

- On stop, no new trials or retries are sent and in-flight attempts are awaited and recorded as usual. An attempt without an answer `adapter.timeoutMs` after sending is abandoned as usual; marking it `stopped` would let resume send it again, a chance an uninterrupted run never gets.
- In a swap check, when one run stops the other stops the same way, and both record the same `stopReason`.
- SIGINT and SIGTERM are interrupts. The first starts stopping (or keeps waiting if already stopping). The second sends `cancel` to adapters that support it and exits at once; in-flight trials become `stopped`. The first signal never cuts attempts even while stopping, because people press it without knowing a stop is in progress, and resent attempts would get extra chances. CI may send signals in a row or kill after a grace period, leaving `stopped` trials or a `running` run; resume resends only the cut trials either way.
- With several reasons, `stopReason` is `config-error` if present, else the first one. An unfixed configuration stops every resume again, and unpriced calls make spend untrustworthy. The exit code follows `stopReason`.
- A stop on cost (`budget` or `budget-projected`) shows the outcome distribution per variant (for example "100% of candidate trials are `timeout`"). A candidate that always times out piles up reservations and hits the cap first, which is not a reason to raise the cap.

## Send Order

1. **First batch**: pick 10 cases alternating languages (one per language in file order, round-robin), send repeat 0 of all of them, then repeat 1: 20 trials. With 1 repeat, pick 20 cases the same way for repeat 0. With fewer cases, use what exists.
2. **Rest**: repeat-major (repeat 0 of every case, then repeat 1, and so on).
3. Repeat r of a case goes out only after repeat r − 1 of that case finished.
4. **Interleave variants** in the same order. When one variant has finished (all segments included) at least the concurrency limit more trials than the other, it waits. A variant with nothing left is ignored.

- Cases are ordered by case file path (lexicographic), then by position in the file. Languages follow the target's `languages`, else sorted codes. The same files and config always give the same order.
- Repeats then hit the cache written by the previous repeat (research R4). Repeat 1 in the first batch measures early whether the cache hits, and alternating languages puts prompt-length differences into the first re-estimate. Both variants see the same time window, which keeps latency and transient comparisons fair, and a stopped run keeps repeats even across cases.
- When one round of many cases outlasts the provider's cache lifetime, later repeats can miss the cache; the per-round re-estimate catches that.

**Start**: when the adapter renders, every case is rendered before the first trial (render fingerprints, input token estimates). A failed render ends the run as a configuration error (exit code 4) before any model call, naming the cases and messages; such a case would also end without a model answer during generation. `lint --render` reports the same as `render-failed`. A run refused by the pre-start cost check leaves no directory.

## Resume and Locking

1. A `complete` run (`run --resume`) or swap check (`swap --resume`) is not resumed (exit code 4). Resume finishes a stopped run; resending trials of a finished run would change its basis. Start a new run instead.
2. Resume sends only: unsent trials, trials whose effective line is `stopped`, `transient` trials with retries left, and trials that ended in `config`. Finished trials that ended in errors (`transient` without retries, `adapter`, `permanent`, `timeout`) are not resent, because an uninterrupted run would not resend them either and resending could erase systematic failures. A run stopped by a provider outage keeps those errors; run again to see it without the outage. `config` errors are environment problems and are resent once fixed. A cut last line is truncated first.
3. Variant, global seed, repeats and case list come from the manifest. A command that sets them differently (`run --variant`, `swap --from`/`--to`, `--repeats`, `--cases`) is refused (exit code 4). Different values only in the config file are ignored with warning `resume-config-ignored`. A manifest case missing from the files is refused; cases only in the files are left out and named in the same warning.
4. Refused when generation conditions differ from the manifest (exit code 4): case hashes, service code (`treeHash`, else version string and dirty flag), adapter name, version and `launchHash`, helper version, and render fingerprints (re-rendered at resume when the adapter renders). One run never mixes trials of different prompts or service code. Adapter code outside `service_dir` is known only by its version, so bump it on changes. The rules hash and commit SHA are not compared, so rules can be fixed and committed between segments.
5. `toolPaths` sent to the adapter at every start (restarts included) are the paths the config's globs match now plus every path this run sent before (`segments[]`), so new rule files are not counted as service code and old ones that left the glob still are.
6. A condition that cannot be verified gives warning `resume-unverified` and resume continues: no service version (on either side), `dirty: true` without `treeHash`, or no render fingerprint. A restarted adapter follows the same rule: a value missing on one side is not a change. Refusing would make resume unusable for services that declare no version. It is stored in the segment and in the comparison.
7. Retries and adapter time limit come from `limits`; different config values give `resume-config-ignored`. Prices, cap and concurrency come from the current config and are stored per segment; the cap includes earlier spend.
8. At start, send lines without attempt lines are closed as `stopped`, then spend and `totals` are recounted from `trials.jsonl`, because a kill may have left the summaries behind the last line.
9. `transient` trials with retries left get only the remaining retries. Stop rates use only trials finished in this segment, so the errors that stopped the last segment do not stop this one at once.
10. Resume re-estimates the total from measurements first and ends with `budget-projected` (exit code 5) above the cap without sending; raise the cap and resume again.
11. With `--dry-run`, resume changes nothing and shows the remaining trials and the re-estimate, counting unclosed send lines at their reservations.
12. A swap check resumes both runs by `swapId` and interleaves the remaining trials. When both runs finished but the swap did not (killed before comparing), it compares without sending. `run --resume` on a run that belongs to a swap is refused (exit code 4), since both runs share the cap and the interleaving. A swap whose runs are one `complete` and one not resumes the unfinished run and then compares.

**Lock**: `run.lock` holds PID, host and start time. On the same host, a lock whose process is gone means the run can be resumed. A live owner or another host's lock is refused (exit code 4) with the lock path. Resuming on another machine is not supported: the owner's liveness cannot be checked and the service code hash can differ between machines.

## Warnings

Run and comparison warning codes (lint codes are in §Validation Rules):

| Code | Condition | Params |
|---|---|---|
| `transient-rate` | Transient error rate above `report.warn.transientRate` | `{rates: per variant, threshold}` |
| `discard-rate-increase` | Candidate minus baseline discard rate above `report.warn.discardRateIncrease` | `{rates: per variant, threshold}` |
| `regeneration-rate-increase` | Candidate minus baseline regeneration rate above `report.warn.regenerationRateIncrease`: the service filters the candidate's first answers more often | `{rates: per variant, threshold}` |
| `latency-p95-ratio` | Latency p95 ratio above `report.warn.latencyP95Ratio` | `{p95Ms: per variant, ratio, threshold}` |
| `cost-ratio` | Cost-per-trial ratio above `report.warn.costRatio` | `{costPerTrialUsd: per variant, ratio, threshold}` |
| `identical-repeats` | All repeats of a case returned the same output (FR-016) | — |
| `response-model-changed` | More than one response model snapshot within a run: the model behind an alias changed during the run | `{models: per variant, list of snapshots}` |
| `same-response-model` | The variants have different `model` values but the same non-empty list of response snapshots: both may have answered with one model (a pinned Azure deployment, a proxy that ignores the model name) | `{models: list of snapshots}` |
| `render-mismatch` | A trial's request fingerprint differs from its case's render fingerprint (FR-015) | `{trials: per variant}` |
| `budget-overrun` | Spend above reservations (`overrunUsd` > 0) | `{overrunUsd: per variant}` |
| `abandoned-trials` | Trials abandoned without an answer, per cause. For trials abandoned at the tool time limit whose late responses contain calls with a kind that did not succeed (`failed` or `unanswered`), `lateFailures` holds per kind the number of such trials and their longest `retryAfterMs`. All calls are checked, not only the last, because after `cancel` a request can still finish and a successful SDK retry would hide the earlier failure. Transient failures here suggest the service's SDK waited before retrying | `{trials: per variant {timeout, restart}, timeoutMs: per variant, lateFailures: per variant {kind: {trials, maxRetryAfterMs}}}`, `timeoutMs` being each run's `adapter.timeoutMs` |
| `resume-unverified` | A generation condition could not be verified on resume | `{conditions: list of service-version, tree-hash, render-fingerprint}` |
| `resume-config-ignored` | On resume, config values for variant, seed, repeats, retries or adapter time limit differ and the manifest wins, or cases only in the files were left out | `{fields: list of variant, seed, repeats, retries, timeoutMs}`; left-out cases in `caseIds` |
| `unpriced-model` | Without a cap, an unpriced call was charged at the most expensive price | `{models: list of model names}` |
| `cached-input-unpriced` | No `cachedInput` price, so cache hits were charged at `input` | `{models: list of model names}` |
| `estimate-low-accuracy` | Input tokens could not be counted from the render and `estimate.inputTokens` was used (§Cost) | `{inputTokens}`, the `estimate.inputTokens` used |
| `conservative-over-budget` | The conservative estimate exceeds the cap (before the start); the run may stop at the cap if the cache misses or outputs are long | `{conservativeUsd, maxCostUsd}` |
| `excluded-from-gate` | A rule of a gated severity is `review` or an uncalibrated judge and was removed from the gate | `{cause: review | uncalibrated-judge}` |
| `partial-run` | A compared run is not finished (`partial` or `running`) | `{runs: per unfinished variant {status, stopReason}}`, `stopReason` `null` for a `running` run |
| `versions-differ` | The compared runs differ in service code (`treeHash`, else version and dirty flag), adapter version, `launchHash` or helper version | `{fields: list of service, adapter-version, launch-hash, helper-version}`; `variants` names the variants of both runs |
| `adapter-warnings` | The adapter attached warnings to results. One per distinct sentence, with the variants in `variants`, counts per variant in `params` (trials with the sentence on any of their attempts) and cases in `caseIds`. Helper warnings change how a result reads ([003 helper-api §Trial Warnings](../003-adapter-helpers/contracts/helper-api.md#trial-warnings)) | `{sentence, trials: per variant}` |

- **Who raises them**: a run raises codes from its own records. Codes that compare variants (`discard-rate-increase`, `regeneration-rate-increase`, `latency-p95-ratio`, `cost-ratio`, `same-response-model`, `versions-differ`), `excluded-from-gate` (from the gate config) and `partial-run` (from run status) come only from comparisons. `conservative-over-budget` is raised before the start; a swap check raises it once against the combined estimate. A comparison re-raises every other code from both runs' records: trial-based codes are recounted on common cases, and manifest warnings (`budget-overrun`, `unpriced-model`, `cached-input-unpriced`, `estimate-low-accuracy`, `resume-unverified`, `resume-config-ignored`) are copied under their run's variant. A swap that reaches the comparison therefore holds every warning of its runs.
- **Grouping**: one warning per code per run or comparison; per `ruleId` and `lang` when the code has them; per sentence for `adapter-warnings`. Affected variants go in `variants`, cases in `caseIds`, counts and values per variant in `params`, so both variants can be read side by side.
- **Text**: records hold no sentences the tool composes. A warning, gate reason or lint finding is its code with the params of its table row, and the message files (`src/messages/`) turn it into text in the `--lang` language. Text that comes from the adapter (the sentence of `adapter-warnings`, error messages) is data and stays in `params` as written; a validator's `detail` is data in English.
- **Params notation**: in the Params columns, "per variant" is an object keyed by variant ID, "list of" is an array, and a dash (`—`) means the finding has no `params`. Each message template names every params key of its code exactly once as `{key}` and nothing else; the renderer writes objects and lists out.
- Sample-plan warnings before the start use the lint codes `few-cases` and `margin-unreachable` (FR-006). They go into the `--json` envelope's `warnings`, not the comparison, because they can occur without one.

## Identifiers and Hashing

- Rule, case and variant IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`, since they appear in directory names and run IDs.
- `runId` = `YYYYMMDD-HHMMSS-<variantId>-<4 hex>`; `swapId` = `YYYYMMDD-HHMMSS-swap-<4 hex>`.
- Per-trial seed: the first 4 bytes of `SHA-256("<sampling.seed>:<caseId>:<repeat>")` read as a big-endian unsigned 32-bit integer. Seed 1729, case `greet-ko`, repeat 0 gives 235035669. Both variants use the same seed for the same trial.
- A hash is the SHA-256 of the canonical JSON (below) of a value, written `sha256:` plus 64 lowercase hex digits. Fingerprints use the same notation; `treeHash` too, over the bytes defined in [003 data-model §`treeHash`](../003-adapter-helpers/data-model.md#treehash). IDs (`gradeSetId`, `comparisonId`) take the first 12 hex digits. YAML is hashed after parsing, so comments, indentation and key order do not matter. NaN or infinity (`.nan`, `.inf`) in a hashed value cannot be canonical JSON and is a `schema` error.

| Name | Input |
|---|---|
| Case hash | `{target, lang, input}` (`lang` is `*` for a case without a language), only what generation uses, so editing `note` or rule lists blocks neither resume nor comparison |
| `rulesHash` | `{rules, cases}`: `active` rule definitions sorted by `id`, and `{id, rules}` of the run's cases sorted by case `id` |
| Variant fingerprint | `{id, model, params}`, without `params` when the variant has none |
| Render fingerprint | The render's `{messages, tools}` (`tools` is `null` when absent). A `generate` fingerprint converts the first request of the first-answer branch into the same shape first, so the two compare directly |
| `trialsFingerprint` | Every complete line of `trials.jsonl` in file order, send and cost lines included, because cost metrics come from them; any new line changes the grade set and the comparison ID |
| `casesHash` | `{id, current case hash or null}` per case of the run, sorted by `id` |
| `gradeSetId` | `gs-` + 12 hex of `{runId, rulesHash, checkerVersion, trialsFingerprint, casesHash}` |
| `comparisonId` | `cmp-` + 12 hex of `{baseline: {gradeSetId, status}, candidate: {gradeSetId, status}, gate, stats, report, redact}`. Different report or redaction settings write different folders. Status is included because a run killed right after its last line becomes `complete` on resume without new lines, and the new comparison must not overwrite the `undecided` one |

Volatile fields, excluded from the determinism check (SC-002, constitution VI): `createdAt`, `durationMs`, `tool.startedAt`, output path strings, `priorComparisons`.

### Canonical JSON

The tool and both helpers write canonical JSON with these rules, so hashes and fingerprints match byte for byte. They follow RFC 8785 except that the two cases RFC 8785 treats as errors, lone surrogates and duplicate names, produce defined output: model-made tool arguments and service requests can contain them, and failing every time would stop fingerprints and raw answers from being compared.

- **Keys** sort by UTF-16 code units (Python: the bytes of `encode('utf-16-be', 'surrogatepass')`, which also works with lone surrogates). Keys with characters outside the BMP sort differently from code point order.
- **Strings** escape only `"` (as `\"`), `\` (as `\\`) and U+0000–U+001F (`\b`, `\t`, `\n`, `\f`, `\r`, otherwise lowercase `\u00XX`), write lone surrogates as lowercase `\udXXX`, and keep every other character as is, like ECMAScript `JSON.stringify`.
- **Numbers** convert to IEEE 754 double and use ECMAScript notation.
- **Reading** JSON text (request and response bodies, `answer_tool` arguments): `NaN`, `Infinity`, `-Infinity` and numbers too large for a double (`1e400`) make the text not JSON, since Python `json.loads` accepts them and JavaScript `JSON.parse` rejects or turns them into infinity. Duplicate names keep the last value, as both standard parsers do.

The helpers implement these rules directly rather than relying on each language's standard `json` ([003 research R13](../003-adapter-helpers/research.md#r13-make-both-helpers-produce-the-same-bytes)).

## Cost

### One Call

- Prices are looked up by the call's `model`, then by the name without a trailing date (`-YYYY-MM-DD` or `-YYYYMMDD`), the same rule that identifies the variant model.
- Cost = Σ(bucket tokens × bucket price) ÷ 1,000,000 over `input`, `cachedInput`, `cacheWrite`, `output`. `reasoning` is inside `output`.
- Without a `cachedInput` price, cache hits are charged at `input` with warning `cached-input-unpriced`.
- With a `cacheWrite` price and no write amount in the response (`cacheWrite` absent), every non-hit input token is charged at `cacheWrite`, which never under-counts.
- When write prices differ per cache lifetime, the user enters the lifetime the service uses, or the most expensive one when it uses several.

### One Attempt

- Every attempt line carries its cost. A run's cost is the sum of all attempt and cost lines, retries and resumed segments included.
- Results, model failure results and the `data` of JSON-RPC errors follow the same rule. With `calls`, each call is priced by its own `model` and summed; an empty array is 0 and is sent only when the adapter knows no model was called. Without `calls`, `usage` is priced at the variant model; without `usage`, whether a model was called is unknown and the attempt is charged its reservation.
- A `Result(usage=)` given to a helper becomes the usage of the raw answer's call and is counted through `calls`; with no captured call there are no `calls` and it becomes the trial's `usage`. Trial `usage` and call `usage` are never counted twice.
- A `failed` call without usage costs 0, since providers rarely bill rejected requests; with usage (Responses `status: failed`) it costs that. A response that started with 200 and failed without usage may be billed, so it is `unanswered`, not `failed`.
- An `ok` call without usage (for example a stream the helper does not parse) and an `unanswered` call are charged the call reservation.
- An attempt without an adapter answer (`abandoned`, `stopped`) is charged the attempt reservation, except a `stopped` attempt that never reached the adapter, which costs nothing. A late response with usage or calls corrects it to the larger of that cost and the reservation, and a cost line records the difference with the response's tokens and calls. Calls reported by `calls` notifications are added as cost lines. Send lines without an attempt line are closed on resume as `stopped` at their reservation.
- Lines that include a reservation have `costEstimated: true`.

### Unpriced Models

- **With a cap**: an unpriced variant model ends the run before the start as a configuration error. Another model's call first seen during the run is recorded with its trial, which stays valid, charged at the most expensive configured price per bucket (`costEstimated: true`), and the run stops with `config-error`. Add the price and resume. The cap cannot be checked while unknown prices are mixed in.
- **Without a cap**: charged at the most expensive configured price per bucket with warning `unpriced-model`. With no price at all, cost is `null`, never 0.

### Three Estimates

| Estimate | Used for | Calculation |
|---|---|---|
| Expected | Start decision, SC-005 | `basis: history`: the previous run's `costProfile` (mean cost of repeat 0 and of later repeats, per variant and language) times the trial counts. `basis: structure`: repeat 0 writes the whole prompt to the cache, later repeats hit it, output is `estimate.outputTokens` (or the render's smaller `maxOutputTokens`), one call per trial |
| Conservative | Pre-start warning | No cache hits. Per trial: calls × input tokens per call × max(`input`, `cacheWrite`) price + output tokens per trial × `output` price. Calls = previous `callsPerTrialP95`, else 1. Input per call = the case's input token estimate (below). Output = previous `outputTokensP95`, else the expected-estimate assumption |
| Reservation | In-run cap check, charge for unanswered calls and attempts | Call reservation = input tokens × max(`input`, `cacheWrite`) price + output tokens × `output` price. Input = the larger of the case's input estimate and the largest input per call seen so far in the run. Output = the request's output limit (render `maxOutputTokens`), else the larger of `estimate.outputTokens` and the largest output per call seen. Attempt reservation = call reservation × the largest number of billed calls per attempt. Prices are the unanswered call's own `model` (unpriced: as above); an attempt with unknown calls uses the variant model |

- **Billed calls per attempt** are its `ok` and `unanswered` calls and `failed` calls with usage, including calls in the attempt's cost lines, so services that always call a model after returning do not get undersized reservations. `failed` calls without usage are not billed, so two SDK retries of a 429 do not triple the reservation. An attempt without `calls` counts as one billed call. An abandoned or `stopped` attempt counts as one, or as the calls of its late response (`source: late`); a `stopped` attempt that never reached the adapter counts none. Billed calls per trial sum all attempts of the key.
- The maximum is kept per language, starts from the previous run's `callsPerAttemptMax` for that language (else 1), and grows when this run sees more. `costProfile` stores the value seen in this run, so one rare spike does not carry into every later run. The maximum and both call counts are never below 1: a run whose calls all failed unbilled would otherwise make the next reservation 0 and switch the cap check off.
- **The previous run for `history`** is the latest `complete` run with the same variant fingerprint, at least 2 repeats and no case filter. A one-repeat run cannot measure cache hits, and a filtered run can skew per-language means. Without one, `structure` is used, also for languages the previous run lacks.
- The conservative estimate and the reservation differ on purpose: output limits usually far exceed real output, so a warning based on them would fire every time, while the in-run check must not undershoot. For the same reason the conservative estimate uses p95 calls per trial and the reservation the maximum per attempt.
- The default `estimate.outputTokens` of 600 covers answers with short reasoning. It usually decides a first run's expected estimate (research R4), so services with short chat answers should set their usual length; a large value refuses first runs that would have finished under the cap.
- **Input token estimate**: the render's `inputTokens` when given. Otherwise count the render's characters: Hangul, kana and Han count 1 token each, every other character (spaces included) 0.3. English usually needs fewer than 0.3 tokens per character and CJK about 1, so this over-estimates; it only matters until the first re-estimate. Without a render, `estimate.inputTokens` is used and the report marks low accuracy. When the render contains a stored-prompt reference (`role: prompt`, [003 helper-api §Render Mode](../003-adapter-helpers/contracts/helper-api.md#render-mode)), the prompt body is missing from the request, so the larger of the count and `estimate.inputTokens` is used with the same mark. In both cases a missing `estimate.inputTokens` ends the run as a configuration error before any model call (exit code 4, `--dry-run` included), because counting 0 would shrink the estimate and the reservations; the message asks for `estimate.inputTokens`.

### Cap Check

- **Scope**: spend the tool counted, both runs of a swap and every earlier segment of a resumed run. Calls the adapter never reported (for example embeddings the helper does not capture) are not included. Omitted in config means 1 USD; `null` means no cap.
- **Before every attempt** (tool retries included): send only if spent + in-flight reservations + this reservation ≤ cap. In-flight reservations are the `reservedUsd` of their send lines. Attempts that ended without an answer are already in spent at their reservation and are not added again. Otherwise stop with `budget`.
- **Re-estimate** after each variant's first batch, after each repeat round and at resume: spent + remaining trials × measured mean per variant and language, with repeat 0 and later repeats separate and each finished trial summing all lines of its key. A variant whose first batch has not finished uses the pre-start expected value per trial, so spent cost is not counted twice. Above the cap, stop with `budget-projected`. Results go to `estimate.projected[]`. When both variants of a swap reach a re-estimate point in the same step, both points are recorded even if the first stops the swap; a run records no later point after its stop.
- **Overrun**: per attempt, (cost of its attempt and cost lines) − (reservation at send). Positive amounts add up in `totals.overrunUsd` and raise `budget-overrun`. Sources are calls without an output limit, longer tool loops than seen before, SDK retries and calls after the result. Cost of calls that belong to no known trial is all overrun.

## Validation Rules

Lint codes. Info does not count as a warning, is not limited by `--max-warnings` and appears under `result.info` in `--json`. Lint findings have the shape and the text rule of §Warnings.

| Code | Level | Condition | Params |
|---|---|---|---|
| `schema` | error | A file violates its schema | `{path, detail}`; `path` is empty for a whole-file finding, and its text then names only `detail` |
| `duplicate-id` | error | Duplicate rule, case or variant ID | `{kind: rule | case | variant, id}` |
| `unknown-rule` | error | A case names a rule that does not exist | —; the rule in `ruleId`, the case in `caseIds` |
| `input-schema` | error | A case input violates the target's input schema | `{target, detail}` |
| `unknown-target` | error | A case names a target the adapter does not declare; `run` refuses it too | `{target}` |
| `missing-lang` | error | A case of a multi-language target has no `lang` | `{target}` |
| `unresolved-ref` | error | A required reference (`anyFrom`) is missing from the case, or a `…From` value is neither text nor a list of text | `{path}` |
| `derived-tracked` | error | A `derived` case file is tracked by git, or sits in a git work tree without being ignored | `{cause: tracked | not-ignored}` |
| `example-mismatch` | error | A rule example gives a different result than expected | `{example, expected: pass | fail}` |
| `adapter-failed` | error | The adapter did not start or initialise, or broke the protocol, so checks that need it could not run. Unlike other lint errors it exits with code 4 | `{detail}` |
| `render-failed` | error | A case failed to render with `--render`, with the adapter's message. Cases on paths that never call a model (input blocks, fixed messages) are not swap-check material; remove them or change the input | `{detail}`, the adapter's message |
| `anchor-missing` | warning | An anchor is missing from the rendered prompt | `{quote}` |
| `rule-without-case` | warning | A `listed` rule no case names | — |
| `rule-filter-mismatch` | warning | A rule listed on a case does not match its target or language and is not graded | — |
| `completed-not-gated` | warning | A gate exists but no `completed` rule exists or its severity is not gated, so rejections, time-outs and discards cannot block | `{cause: no-rule | not-gated}` |
| `language-gap` | warning | A rule language has no cases | — |
| `few-cases` | warning | A gated cell has fewer than 10 cases; it only catches large drops (research R3) | `{surface, cases}` |
| `margin-unreachable` | warning | A gated cell's planned trials (cases × repeats) are below n_min for its margin; equal compliance cannot pass (§Statistics) | `{surface, plannedTrials, nMin, margin}` |
| `excluded-from-gate` | warning | Same as the run warning of that name (§Warnings), raised by lint | `{cause: review | uncalibrated-judge}` |
| `vcs-unknown` | warning | Not a git work tree, so `derived-tracked` cannot be decided; reported once | — |
| `helper-outdated` | warning | The adapter's helper is older than the one bundled with this tool; copy it again with `init` | `{version, bundled}` |
| `unanchored` | info | A rule without an anchor for a language of the cases it applies to; a notice, not something to fix (for example a rule kept by post-processing alone) | — |

- Lint starts the adapter with the first variant to obtain input schemas, and with every variant under `--render`. `--no-adapter` skips `input-schema`, `unknown-target` and anchor checks. Under `--render`, an adapter that does not declare `capabilities.render` is `adapter-failed`, since the anchors asked for cannot be checked, and so is one that does not answer `shutdown`.
- Without the adapter's targets (`--no-adapter`), the language of a case without `lang` is unknown, so checks that depend on it (`rule-filter-mismatch`, `language-gap`, `unanchored`, `unresolved-ref` of rules limited by language, and the sample plan codes) leave that case out instead of guessing, and `language-gap` is not reported for a language such a case may cover.
