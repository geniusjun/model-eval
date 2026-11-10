# modelEval Constitution

Every spec, plan and implementation in this repository follows these principles.

- **MUST** (principles I–IX): a violation blocks merge. A failed item in a plan's Constitution Check returns the work to design.
- **SHOULD** (principle X): may be broken when the plan's Complexity Tracking table records the reason and the rejected alternative.

## Core Principles

### I. Grade What the Service Actually Ships

The adapter runs the service's own prompt assembly, model call and post-processing. The core MUST NOT build or edit service prompts; the rubric prompt sent to a judge model is not a service prompt, so the tool builds it.

- Every trial with status `ok` MUST record the model's first answer (`raw`) and what the service shipped (`finalKind`: the model's answer, a substitute text, or nothing), plus the shipped text (`final`) when there is one.
- An adapter without post-processing MUST declare `capabilities.postprocess: false` in `initialize`, and reports MUST show that.

**Check**: the core source contains no service prompt templates; the trial schema makes `raw` and `finalKind` required when the status is `ok`.

**Rationale**: If the evaluation path differs from production, a pass says nothing about production. Post-processing, discards and regeneration hide how often the model breaks a rule unless they are recorded.

### II. No Conclusion From a Single Sample

Comparisons MUST use repeated trials, and every rate used for a verdict MUST carry a confidence interval. A verdict asks whether the candidate is no worse than the baseline by more than a set margin (non-inferiority).

- An interval that straddles the margin is `inconclusive`; a sample that cannot decide is `insufficient`.
- A rerun after an undecided result is a new run and MUST NOT be pooled with the earlier one until a sequential procedure splits the error rate across looks.
- Operational metrics compared to a limit without an interval MUST NOT change the gate result; gating on them requires the same non-inferiority test.
- Precondition checks (the baseline's completion rate) and run stop criteria decide whether a verdict is possible; they are not verdicts.
- A comparison with nothing to judge MUST NOT pass: no gated cell judged, a gated rule with no judged cell, a partial run, or a baseline that failed to answer more than half of its trials. An empty gate reports `no-gate`, not `pass`.

**Check**: the verdict function has no path that returns a verdict without an interval; no code counts `inconclusive` or `insufficient` as passing; operational-metric warnings never change the exit code; tests show that none of these return `pass`: a comparison with every trial missing, a partial run (including a run left `running` by a kill), a baseline completion rate under 50%, a gated rule with no judged cell, an empty gate.

**Rationale**: LLM output varies for the same input. A few good-looking samples, or one lucky pass, is not evidence of no regression. Rerunning until it passes and pooling the results inflates false passes.

### III. Deterministic Checks First

Rules that can be decided by strings, character scripts, format or completion MUST use deterministic checks. LLM-judge checks are for rules that need meaning, and they MUST record the judge model, its snapshot and the rubric hash, and hide which variant produced the output. A judge rule MUST NOT gate until its agreement with human labels is measured above the configured bar. When the gate names such a rule, or a `review` rule that has no verdicts, the tool drops it from the gate with a warning.

**Check**: tests show the gate function excludes judge rules without a calibration record and `review` rules.

**Rationale**: A judge is also stochastic and biased. Blocking a model swap on an unmeasured judge turns the judge's mistakes into production decisions.

### IV. People Set Policy, the Tool Shows Evidence

The tool MUST NOT decide whether a rule is right or why languages differ. It shows the violation, the prompt sentence behind the rule and failing examples. Only conditions written in the config `gate` can block a swap; there are no default blocking conditions.

**Check**: tests show that with an empty `gate`, `compare` and `swap` never return `block`, and a comparison that passes the preconditions (001 data-model §Gate, rows 1–3) returns `no-gate` with exit code 0.

**Rationale**: A language-specific difference or a reliance on post-processing may be intended product policy. Hiding that judgement in the tool changes policy without review.

### V. Real User Data Stays Out of the Repository

All cases, examples and test data in the public repository MUST be synthetic, and public demos are built from synthetic examples only.

- Every case file MUST declare `provenance: synthetic | derived`, and `derived` cases (made from real data) MUST live outside version control.
- Raw trial records stay in the output directory, which `init` adds to `.gitignore`.
- Reports, result pages, saved comparisons, stdout, stderr (including adapter stderr the tool relays) and logs MUST pass the configured redaction rules before they are written.

**Check**: lint reports a version-controlled `derived` case as an error (001 data-model §Validation Rules).

**Rationale**: Regression cases tend to come from real conversations. Without a required provenance, real data leaks by accident.

### VI. Same Records, Same Conclusion

A run MUST record the tool version, the adapter and service versions, the variant, a hash per case, the rules hash, the seed and timestamps, and a render fingerprint when the adapter provides `render`. Stored outputs MUST be re-gradable without calling a model (`grade`, `compare`). Statistics MUST depend only on the records and the config; any calculation that uses randomness uses the recorded seed.

**Check**: comparing the same records twice yields byte-identical JSON apart from the volatile fields in 001 data-model §Identifiers and Hashing.

**Rationale**: Calling the model again after every check fix costs money and changes the outputs, so nobody can tell which change moved the conclusion.

### VII. Know the Cost Before Starting, Stay Under the Cap

Commands that call models MUST show the call count and two cost estimates before starting: the expected cost (the most plausible value) and the conservative cost (no cache hits). If the expected cost exceeds the cap, no model is called; if only the conservative cost exceeds it, the run starts with a warning.

Before each attempt (one send of a trial; a tool retry is also an attempt), the tool MUST check that spent cost plus the reservations of in-flight attempts plus this attempt's reservation stays within the cap; if it does not, the attempt is not sent and the run stops. A reservation is the worst-case cost of one attempt: no cache hits, output up to the output limit, and as many billed calls as the most seen in one attempt, starting from the previous run's value.

After the first batch of each variant and after every repeat round, the tool MUST re-estimate the total from measurements and stop if it exceeds the cap. Attempts abandoned without a response are charged at their reservation, because the provider may already have billed them. Actual spend above a reservation (a call with no output limit, more calls than seen so far) is recorded as overrun in the run record and the report.

The cap applies to spend the tool counted: both runs of a swap check, including earlier segments of a resumed run. Calls the adapter does not report cannot be counted and are not included. Prices come from the user's config, and the tool ships no price table.

**Check**: tests show that with a cap set, a variant model without a price ends with a configuration error before start, and the first unpriced call during a run ends it with a configuration error then; a run whose expected cost exceeds the cap sends no generate request to the adapter; at every send (tool retries included) spent cost plus in-flight reservations plus this reservation is at most the cap; spend above a reservation lands in the run record's overrun field.

**Rationale**:

- Repeated sampling multiplies calls. Reasoning models can emit far more output tokens than expected, and a first run cannot know this in advance, so measurements catch it.
- For services with a long shared prompt the conservative cost is several times the expected cost, so blocking on it would stop most runs that never reach the cap.
- One trial's cost depends on tool loops and output length, so "never exceed the cap" cannot be promised; a check before every send can be tested, and reporting the overrun shows the gap between the cap and actual spend.
- Prices change often, so a built-in table would soon be wrong.

### VIII. Humans and Agents Read the Same Result

Every command MUST offer human output and `--json` output with a `schemaVersion`. Exit codes and JSON schemas are a public contract, and changing their meaning requires a major version.

**Check**: each command has a test that validates its `--json` output against its JSON Schema.

**Rationale**: CI and coding agents run swap checks and people decide on them. One result in two formats keeps the interpretations from drifting apart.

### IX. Every Requirement Has a Test

Each functional requirement (`FR-###`) of a feature whose status is `In Progress` or `Implemented` MUST have at least one test whose name carries the feature and requirement IDs (for example `001 FR-007`). The default CI path MUST NOT call a model; end-to-end tests use a mock adapter.

**Check**: `scripts/check-spec-coverage` fails CI when a requirement of such a feature has no test.

**Rationale**: Specs and code drift apart where a requirement has no test. Model calls in CI make it costly and nondeterministic, so nobody trusts it.

### X. Stay Small (SHOULD)

Runtime dependencies SHOULD be limited to what is necessary, and each addition SHOULD be justified in the plan together with why it is not written in-house. TypeScript runs in `strict` mode, and external input (files, adapter responses) is parsed with a schema at the boundary before use.

**Rationale**: A public tool's dependencies become its users' supply-chain risk. Types narrowed at the boundary remove defensive code inside.

## Development Workflow

- Each feature lives under `specs/NNN-name/` and follows spec, plan, tasks and implementation in that order.
- A plan's Constitution Check runs before research and again after design.

## Governance

This constitution overrides other project conventions. An amendment:

1. States the principle changed, the reason and the affected specs in its pull request.
2. Bumps the version: MAJOR for a principle removed or its meaning changed, MINOR for a principle added, PATCH for wording.
3. Re-runs the Constitution Check of the affected spec.md and plan.md files in the same pull request. It is complete when that result is in the pull request.

**Version**: 1.0.0 | **Ratified**: 2026-11-09 | **Last Amended**: 2026-11-09
