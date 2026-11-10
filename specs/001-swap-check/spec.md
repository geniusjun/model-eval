# Feature Specification: Model Swap Check

**Feature Branch**: `001-swap-check`

**Created**: 2026-11-09

**Status**: Draft

**Input**: User description: "Check whether the prompt rules and post-processing fixes of an LLM service still hold when the service moves to another model, with repeated trials and statistical verdicts per rule and language."

## Context

Chat services fix output problems by adding rule sentences to the prompt or post-processing code. Those fixes can break again when the model changes, because a new model follows the same instruction differently. Operators then face the same problems on every swap:

- The fixes exist only as prose, and commits that fix prompts and post-processing cluster right after a swap. Some fixes are mechanical (scripts, name spelling, Markdown) and some need meaning, but none has a check, and the reason for a sentence is soon forgotten (research R5, R6).
- Swap failures are not only about tone. Reasoning tokens eat the output limit and leave empty or cut answers, and some tool and reasoning settings are rejected by the API. Background jobs with short output limits break first (research R6).
- Comparison scripts skip parts of the production prompt and the post-processing, so they cannot tell whether production rules hold (research R2).
- Output varies between calls. A rare violation appears a few times in hundreds of answers, so reading a handful proves nothing (research R6).
- Post-processing hides violations. Looking only at the shipped text shows neither how often the model breaks a rule nor how often the service throws answers away.

With this feature an operator names a candidate model and runs one command. The answer is, per rule and language and with statistical evidence, whether the candidate keeps the current rules as well as the baseline does, plus how cost and latency change. Any service can take part by writing an adapter and rule and case files. For small models, one check should cost at most 0.5 USD (SC-007, research R4).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Check a candidate model with deterministic rules (Priority: P1)

An operator picks a baseline variant and a candidate variant and runs the swap check. The tool runs the same cases on both variants several times, judges each rule that a string, script or format check can decide, and reports per rule and language whether the candidate is better, no worse, worse or undecided.

**Why this priority**: Many rules need no LLM judge, and these checks alone give a first basis for the swap decision. Completion failures, discarded answers, latency and cost come with them.

**Independent Test**: Run the check against a mock adapter that breaks rules with known probabilities. The per-cell verdicts, exit code and report match expectations, and no model is called.

**Acceptance Scenarios**:

1. **Given** 3 rules, 6 cases in 2 languages and 2 variants, **When** the swap check runs, **Then** each rule × language × output surface cell shows both compliance rates with intervals, their difference with an interval, and a verdict.
2. **Given** a candidate that breaks a blocking rule clearly more often than the margin allows, **When** the check runs, **Then** it exits with code 1 and the top of the result names that cell, the prompt sentence behind the rule and failing examples (raw and final).
3. **Given** an expected cost above the cap, **When** the check runs, **Then** no model is called and it exits with code 5, showing call counts and both estimates.
4. **Given** an expected cost within the cap and a conservative estimate above it, **When** the check runs, **Then** the run starts with a warning.
5. **Given** trials where post-processing removed the violating characters, **When** results are shown, **Then** the raw rate, the final rate and the masked rate are reported separately.
6. **Given** a gated cell whose interval straddles the margin, **When** the check runs, **Then** it exits with code 2 and the cell shows the repeats and trials (or cases) a new run needs.
7. **Given** a rule that applies to three languages and a candidate that regresses only in Japanese, **When** the check runs, **Then** the Japanese cell is `regressed` and blocks, and the pooled value is shown for reference only.
8. **Given** a service that discards some candidate answers or replaces them with a fixed message, **When** the check runs, **Then** those trials fail the completion rule, raw rules still judge them, final rules leave them out, and discard and fallback rates are reported.
9. **Given** both variants fail authentication, **When** the check runs, **Then** it ends as a configuration error (exit code 4), not as a pass.
10. **Given** a first run whose candidate writes far longer outputs than assumed, **When** the check runs, **Then** it stops with code 5 after the first batch of a variant, every send stayed within the cap, and any overrun is reported.
11. **Given** a candidate that misses the service's own time limit on hard cases, **When** the check runs, **Then** those trials are not retried and count as completion failures.
12. **Given** no `gate` in the config and two finished runs, **When** the check runs, **Then** cell verdicts are shown, the gate result is `no-gate` and the exit code is 0.
13. **Given** no `gate` in the config and a baseline that completed fewer than half of its trials in some language, **When** the check runs, **Then** the gate result is `undecided` and the exit code is 2.
14. **Given** a service that filters the candidate's first answer and regenerates it, **When** the check runs, **Then** raw rules judge the first answer, final rules and the completion rule judge the shipped text, and the masked rate and the regeneration rate are reported.

---

### User Story 2 - Keep the rule ledger in line with the prompt (Priority: P1)

Someone who edits a prompt runs lint with rendering. Without calling a model, it checks that the prompt sentences each rule is anchored to are still in the rendered prompt, that every rule and language has cases, and that the files are valid.

**Why this priority**: It costs nothing, so it can run on every prompt change. A swap check with a ledger that drifted from the prompt cannot be trusted.

**Independent Test**: Remove an anchored sentence from the mock adapter's rendered prompt and run lint. One `anchor-missing` warning appears.

**Acceptance Scenarios**:

1. **Given** a rule sentence removed from the Japanese prompt, **When** lint runs with rendering, **Then** one `anchor-missing` warning appears for that rule and language and the exit code is 0.
2. **Given** the same removed sentence and a warning limit of 0, **When** lint runs with rendering, **Then** the exit code is 1.
3. **Given** a case that names a rule ID that does not exist, **When** lint runs, **Then** it reports `unknown-rule` with file and position and exits with code 1.
4. **Given** a `derived` case in a version-controlled path, **When** lint runs, **Then** it reports `derived-tracked` and exits with code 1.
5. **Given** a rule set to `retired`, **When** lint runs, **Then** its anchors are not checked and it is not run.
6. **Given** a rule whose pass example fails its own check, **When** lint runs, **Then** it reports `example-mismatch` and exits with code 1.

---

### User Story 3 - Connect any service through an adapter (Priority: P1)

Another team writes one adapter for its service, plus rule and case files, and runs the same check. The adapter is a separate process that speaks a line-based JSON protocol, so the service can be written in any language.

**Why this priority**: The tool is only useful if changing the data and the adapter is all it takes to adopt it.

**Independent Test**: Run the bundled example with its mock adapter from a fresh clone, following the quickstart. It finishes without calling a model.

**Acceptance Scenarios**:

1. **Given** someone new to the repository who reads only the quickstart, **When** they run the example swap check, **Then** they reach the result within 10 minutes.
2. **Given** an empty folder, **When** `init --adapter python` or `init --adapter node` runs, **Then** a config, an adapter skeleton that uses the helper (for Python, with the helper file copied next to it), example rules and cases, and an ignore entry for the output directory are created, and lint passes.
3. **Given** an adapter that prints non-protocol text to stdout, **When** a run starts, **Then** the tool reports the offending line and explains that stdout is reserved for the protocol.
4. **Given** an adapter that returns an output without the required fields, **When** a trial finishes, **Then** the trial is recorded as an adapter error, not as a model failure.

---

### User Story 4 - Re-grade, compare and resume saved runs (Priority: P1)

After fixing a check, an operator re-grades saved runs and compares them again without calling a model. The same command compares two runs of the same variant made at different times. An interrupted run continues where it stopped.

**Why this priority**: Check definitions change more often than models. Re-grading is free and keeps the conclusion tied to the records, and a resumed run must reach the same conclusion as one that was never interrupted.

**Independent Test**: Grade a saved run, change a pattern in one rule and run `compare` again. Only cells of that rule change verdict, and no model is called.

**Acceptance Scenarios**:

1. **Given** two saved runs and an edited rule, **When** `compare` runs, **Then** both runs are re-graded with the current rules before the comparison.
2. **Given** a run interrupted midway, **When** it is resumed, **Then** only unsent or unfinished trials and trials that ended in a configuration error are sent, and trials that ended in other errors are not resent.
3. **Given** a run whose prompt or service code changed after the interruption, **When** it is resumed, **Then** the tool refuses.
4. **Given** a run whose adapter declares no service version, **When** it is resumed, **Then** it resumes and records a warning.

---

### Edge Cases

- **What if the adapter hangs or keeps crashing?** The trial is an adapter error, and the run stops as `partial` once the error rate or the restart count passes its limit (FR-008).
- **What if the service waits longer than the tool's adapter timeout?** The tool abandons the trial as an adapter error and warns; it counts as a completion failure only when such errors concentrate on one case of one variant (FR-008, FR-009).
- **What if the service raises an exception the adapter did not declare as a discard?** It is an adapter error, so a broken test harness does not hide behind a discard rate (FR-008).
- **What if the model rejects the request shape?** It is a completion failure and is not retried, because the user got no answer (FR-009).
- **What if the model misses the service's own time limit?** It is a completion failure and is not retried; a retry would give a slow model more chances than production does (FR-009).
- **What if authentication, the model name, quota, billing or the TLS certificate fails, or a model without a price is called while a cap is set?** It is a configuration problem, not a model defect: the run stops at once as a configuration error, whichever call it came from (FR-009, FR-012).
- **What if the provider rate-limits, returns 5xx or drops the connection?** The attempt is retried, failures that remain are left out of every denominator and reported (also when the service swallowed them and shipped a fixed message or another model's answer), and the run stops when they pass half of the finished trials (FR-009).
- **What if the regeneration request fails after the service filtered an answer it received?** The trial counts as what the service shipped, not as the failure, unless the service raised an exception that is not a discard and shipped nothing (FR-009).
- **What if every finished trial of one case (at least two) fails transiently or with adapter errors in one variant while the other variant judged that case?** It counts as a systematic completion failure, since chance load rarely hits every repeat of one case (FR-009).
- **What if the answer is cut or empty, or the service discards or replaces it?** When the discard or fallback was not caused by a model call failure, or followed a failed regeneration of an answer the service had received, the completion rule fails; raw rules still judge a raw answer that exists, and an empty output is judged only by the completion rule (FR-018).
- **What if the service picks one of several answers?** Raw rules judge the first answer, and final rules and the completion rule judge the one shipped (FR-018).
- **What if the service calls a model in the background after returning?** That cost is counted and the call is not graded (FR-007).
- **What if both variants keep a rule 100% of the time?** The cell is `insufficient` below the minimum trials for its margin and `non-inferior` above it; zero observed variance is not trusted (FR-022).
- **What if the gate is not empty but no gated cell could be judged, or a gated rule has no judged cell?** The gate result is `undecided` (FR-025).
- **What if the baseline completed fewer than half of its trials in some language?** The comparison's premise is broken and the result is `undecided` whatever the gate says (FR-025).
- **What if one of the compared runs is partial or never finished?** Results are shown but the gate result is `undecided` (FR-025).
- **What if output tokens per trial are unknown on a first run?** The run starts from the configured assumption and re-estimates from measurements after each variant's first batch and every repeat round, stopping if the estimate exceeds the cap (FR-011).
- **What if an attempt costs more than its reservation?** The overrun is recorded and reported separately (FR-011).
- **What if the tool is killed?** Sent attempts are charged at their reservation and are sent again on resume (FR-013).
- **What if rendering fails for some case at start?** The run ends as a configuration error before any model call and names the case (FR-014).
- **What if the two runs have different cases, or a case changed?** Only common, unchanged cases are compared and the difference is reported (FR-027).
- **What if the two runs used different service or adapter versions?** The comparison warns, because the service code may have changed as well (FR-027).
- **What if the provider honours the seed and every repeat is identical?** The run warns that repeats add no information (FR-016).
- **What if an anchor exists in some languages only?** Lint shows it and does not judge whether the difference is intended (FR-004).
- **What if the result is exit code 2?** Run again with the suggested repeats as a new run; it is not pooled with the earlier one (FR-024).

## Requirements *(mandatory)*

### Functional Requirements

#### Files and Lint

- **FR-001**: System MUST validate config, rule and case files against their schemas and report each problem with file, line and column, at the level the data model assigns to its code.
- **FR-002**: System MUST check that cases name existing rules, that case inputs match the target's input schema and that every case value a check refers to exists.
- **FR-003**: System MUST report a `derived` case in a version-controlled path as an error.
- **FR-004**: System MUST check, per variant and language, that each anchor sentence appears in the adapter's rendered prompt, report missing anchors and rules or languages without cases once each, and accept a warning limit so CI can fail on warnings.
- **FR-005**: System MUST run each rule's pass and fail examples through its check and report a mismatch as a lint error, so that check mistakes surface before any model call.
- **FR-006**: System MUST warn when a gated cell is planned with fewer trials per variant than its margin needs or with fewer than 10 cases, because such a run cannot pass at equal compliance.

#### Adapter

- **FR-007**: System MUST start the configured adapter command, talk to it over adapter protocol v1 with a configurable concurrency limit, and count the cost of every call the adapter reports, including calls made after the trial returned.
- **FR-008**: System MUST record adapter hangs, crashes and protocol violations as adapter errors, charge unanswered attempts at their reservation, warn about abandoned trials with their cause, and stop the run as `partial` when the adapter error rate or consecutive restarts pass their limits.
- **FR-009**: System MUST classify model call failures by kind:
  1. Rejections and service time-outs are completion failures without retry.
  2. Transient failures are retried, and those that remain are left out of denominators, except as item 3 says.
  3. Transient failures and adapter errors concentrated on one case of one variant are completion failures (data-model §Systematic Failures).
  4. Configuration failures stop the run at once.
  5. The run stops when transient failures pass their limit.

#### Running

- **FR-010**: System MUST run every case, or the cases selected with `--cases`, for the set number of repeats with one variant, and record, per trial, the raw answer, the shipped text and its kind, token usage split into cache and reasoning buckets, latency, finish reason, responding model snapshot and the number of answers the service received, and warn when one run sees more than one model snapshot.
- **FR-011**: System MUST hold a cost cap (default 1 USD, can be turned off) over both runs of a swap check and every earlier segment of a resumed run:
  1. Before calling a model, estimate and show calls, tokens, expected cost and conservative cost; call no model when the expected cost exceeds the cap, and warn when only the conservative cost does.
  2. Send no attempt (tool retries included) that fails the check of data-model §Cap Check.
  3. Stop when the estimate redone after each variant's first batch, after every repeat round and when a resume starts exceeds the cap.
  4. Exit with code 5 when the cap refuses the start or stops the run, and on a stop show the per-variant outcome distribution so far.
  5. Record and report spend above a reservation separately.
- **FR-012**: System MUST end as a configuration error when a cap is set and a variant model has no price, or when a call to an unpriced model first appears during the run; without a cap it charges unpriced calls at the most expensive known price per bucket and warns.
- **FR-013**: System MUST resume an interrupted run or swap check as data-model §Resume and Locking defines:
  1. Send only unsent and unfinished trials and trials that ended in a configuration error; finished trials are not resent even when they ended in an error.
  2. Use the recorded variant, seed, repeats and cases, and refuse command options that set them differently; keep the recorded retry count and adapter timeout.
  3. Refuse a finished run, and a run whose cases, service code (compared by file content, not by commit), adapter version or launch settings, helper version or render fingerprints changed; warn when a condition cannot be verified. A rule-only change, committed or not, never blocks resume.
  4. Resume a run that belongs to a swap check only through the swap check.
  5. Recount spend from the trial records, charging attempts cut by a kill at their reservation.
  6. Do not renew retries per segment, and count stop rates over the trials finished in the current segment.
  7. Lock a running run against a second writer.
- **FR-014**: System MUST record tool, adapter and service versions, the variant, case and rule hashes, render fingerprints, the seed, a copy of the prices and every resumed segment, and render every case before the first model call, ending as a configuration error when a render fails.
- **FR-015**: System MUST warn when the request fingerprint a trial reports differs from the render fingerprint of its case, so that anchor checks are known to match the real request.
- **FR-016**: System MUST derive a per-trial seed from the global seed, case and repeat, pass it to the adapter, and warn when all repeats of a case return the same output.

#### Grading

- **FR-017**: System MUST provide deterministic checks (script, emoji, pattern, phrases, overlap, length, JSON, completion), the combinators all, any and not, and a non-grading `review` check, give the same result for the same text and definition every time, and let checks refer to case input and per-rule values by path.
- **FR-018**: System MUST grade every applicable rule on both the raw answer and the shipped text, record the evidence, and apply these rules:
  1. The raw answer is the model's first answer; a regenerated or picked answer is graded as shipped text.
  2. Shipped text of discarded or substituted trials is not graded.
  3. An empty output is judged only by the completion rule.
- **FR-019**: System MUST re-grade stored trials into a new grade set without calling a model, and every comparison MUST grade both runs with the current rules.
- **FR-020**: System MUST collect, for each `review` rule, baseline and candidate samples of the same cases instead of computing a rate.

#### Comparison and Gate

- **FR-021**: System MUST compute, per rule × language × output surface cell, both compliance rates with intervals, their difference with an interval and the failure-rate ratio, and show the pooled value per rule as reference only.
- **FR-022**: System MUST give each cell one verdict out of `improved`, `non-inferior`, `regressed`, `inconclusive`, `insufficient` and `not-applicable`, in the order of data-model §Statistics.
- **FR-023**: System MUST compute operational metrics per variant (rejection, time-out, transient error, adapter error, discard rate and discard reasons, fallback, empty answer and regeneration rates, systematic failures, abandoned trials by cause, side-call failures, finish reasons, typical error messages, latency p50 and p95, tokens and cost per trial), attach intervals to rates, warn when a point estimate passes its threshold, and never change the exit code because of them.
- **FR-024**: System MUST estimate, for every undecided gated cell, the repeats and trials per variant a new run needs, or the cases it needs when repeats cannot help, and show how many times the same pair of variants was compared before.
- **FR-025**: System MUST decide the gate result (`pass`, `block`, `undecided` or `no-gate`) from the config `gate` only:
  1. A partial or unfinished run, a run with nothing to judge, or a baseline under half completion in any language gives `undecided` regardless of the gate.
  2. A non-empty gate with no judged gated cell, or a gated rule without a judged cell, gives `undecided`.
  3. An empty gate never gives `block`; when item 1 does not apply, it gives `no-gate`.
- **FR-026**: System MUST put the most common error message of a blocked cell's failures first in the gate reason when most failures share it, without changing the result.
- **FR-027**: System MUST compare only cases that both runs share with identical content, report the difference, run the precondition checks on those cases, and warn when service, adapter or helper versions or adapter launch settings differ.
- **FR-028**: System MUST include a decision summary in every comparison, in this order: worse cells (regressions and cells with a confirmed drop), better cells, undecided cells with the trials they need, changes in operational metrics, and the judged scope.

#### Output

- **FR-029**: System MUST write a Markdown report, with every model or service string inside a code block so mentions, links and HTML in it do not render when the report is posted as a pull request comment. Its sections, in order:
  1. decision summary and gate result;
  2. cell table;
  3. failing examples of regressed cells (raw and final);
  4. masked rate and the discard, fallback and regeneration figures;
  5. cells whose baseline compliance is below the configured level;
  6. anchors and origins;
  7. operational metrics and warnings;
  8. judged scope (judged targets and rule counts, and rules not judged);
  9. reproduction details.
- **FR-030**: Every command MUST offer `--json` output with a `schemaVersion` and published exit codes.
- **FR-031**: System MUST pass reports, result pages, saved comparisons, stdout, stderr (including relayed adapter stderr) and logs through the configured redaction rules before writing them.
- **FR-032**: The swap check MUST run both variants, grade, compare, gate and write the outputs in one command:
  1. Both variants use the same trial order and seeds, and their trials are interleaved.
  2. Repeats of a case are sent in repeat order, each only after the previous repeat of that case finished (data-model §Send Order).
  3. A swap check that stops early still compares what finished and marks the result as withheld, unless it stopped on a configuration error, was forced to quit, or finished no trial.
- **FR-033**: `init` MUST create a config template, example rules and cases and an ignore entry for the output directory. With `--adapter`, it also creates an adapter skeleton that uses the helper for that language, and for Python copies the helper file next to it.
- **FR-034**: System MUST print human output in English by default and in Korean when asked.

### Key Entities *(include if feature involves data)*

- **Target**: A service function under test, with its languages and input schema.
- **Variant**: A model plus parameters to compare. Baseline and candidate are roles chosen at comparison time.
- **Rule**: A behaviour the service promises, with severity, scope, anchors and one check.
- **Anchor**: A sentence of the rendered prompt that a rule relies on.
- **Check**: How a rule is decided on a text or a trial.
- **Case**: One input to a target, in one language, with its provenance.
- **Run**: All cases of one variant repeated a set number of times.
- **Trial**: One repeat of one case. Sending a trial once is an attempt.
- **Grade**: The result of one rule on one trial, per output surface.
- **Cell**: Rule × language × output surface, the unit of verdicts and of the gate.
- **Comparison**: Cell verdicts and the decision summary for a baseline run and a candidate run.
- **Gate**: The decision derived from a comparison and the config `gate`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A test that runs lint, the swap check and report generation against the mock adapter finishes in CI within 3 minutes without calling a model.
- **SC-002**: Comparing the same run records twice gives the same result apart from volatile fields.
- **SC-003**: A simulation that uses the shipped statistics code shows, at 0.95 confidence:
  - (a) With equal true compliance and 5 gated cells, at least one `regressed` appears in at most 5% of families over 3–30 cases and 3–10 repeats, both when per-case rates are equal and when only the means are equal.
  - (b) At a true difference of exactly −margin, a cell wrongly passes as `non-inferior` in at most 2.5% of runs on average and 5% at most over the measured range.
  - (c) A drop from 95% to 65% is `regressed` in at least 80% of runs, at 30 cases × 5 repeats with margin 0.10 and at 10 cases × 10 repeats with margin 0.05.
  - (d) At a 95% baseline, 30 cases × 5 repeats and margin 0.10, an unchanged candidate passes one cell at least 90% of the time and all 5 cells at least 70% of the time, measured over 1,000 families.
- **SC-004**: The tool is connected to one multilingual chat service in production use and completes at least one real baseline-versus-candidate comparison with at least 15 deterministic rules, 3 languages and at least 10 cases per gated cell.
- **SC-005**: On the second run of the same variant, the expected cost estimate is within ±30% of the actual cost.
- **SC-006**: A person new to the repository follows the quickstart alone and gets the example comparison within 10 minutes.
- **SC-007**: In the SC-004 integration, a swap check of two models priced at or below 0.2 USD input and 1.2 USD output per million tokens, with default settings (30 cases per language, 5 repeats, 1 USD cap) and the service's usual answer length as the output assumption, starts without raising the cap and costs at most 0.5 USD when the provider cache hits from the second repeat on. The record keeps mean input and output tokens per trial and the cache hit ratio.

## Assumptions

- Adapter authors can run the service code with its dependencies and API keys.
- Both variants run with the same rules and cases; otherwise only the common part is compared.
- People write rules and cases. The tool provides check types and file formats only.
- Conversation history is written statically into case input. Multi-turn simulation with a model playing the user is out of scope.
- Each case has exactly one language.
- Out of scope for this feature: LLM-judge checks and their calibration, adaptive sampling, gating on operational metrics, per-case repeat counts, overlap against the rendered prompt, importing results from other tools, and an HTTP adapter configured without code. These are later features.
- Out of scope for the product: automatic prompt editing or optimisation, fine-tuning, shadow traffic and online A/B tests, generating cases from real data, a server that collects runs, and a provider client library.
- The result page is feature 002 and the Python and TypeScript adapter helpers are feature 003; this feature defines the comparison output and the adapter protocol they build on.
