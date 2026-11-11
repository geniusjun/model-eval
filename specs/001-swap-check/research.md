# Research: Model Swap Check

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

External facts are as of 2026-11-09, from each project's repository and official documentation.

## R1. Build on an existing eval tool?

**Decision**: Build a small standalone runner rather than a layer on top of an existing tool (plan D5).

**Rationale**:

| Tool | Repeats and statistics | Runs service code | Raw vs post-processed | Notes |
|---|---|---|---|---|
| promptfoo (MIT, TypeScript) | `--repeat`; since 0.125.0 (2026-10-23) a Wilson interval and an "unstable" flag per repeat group. No baseline-difference verdict | Through a Python provider | Imitable with transforms and `metadata` | Regex assertions build `RegExp` without flags, so `\p{Script=…}` is unavailable. A per-repeat-index cache replays the same output on rerun. Acquired by OpenAI in 2026-03 |
| Inspect AI (MIT, Python) | Epochs, clustered standard errors, bootstrap, Wilson interval, early-stop hooks. No two-model difference verdict | `agent_bridge()` patches SDK request methods and reroutes requests whose model name is `inspect`, so the service's model name must change | Not separated | Python only |
| DeepEval (Apache-2.0, Python) | Repeats via pytest, no statistical verdict | Yes | No | Instruction-following metrics list instructions by hand and use an LLM judge |
| LangSmith, Braintrust (commercial) | Repeats; experiment comparison counts improvements and regressions without significance | Yes | No | LangSmith measures judge agreement with human labels (Align Evals) |
| OpenAI Evals | The open-source repository has no repeat option and no release since 2024-05 | CompletionFn | No | The platform Evals became read-only on 2026-10-31 and shuts down on 2026-11-30 |
| EvalShift (Apache-2.0, Python, since 2026-05) | Built for model-swap regressions: paired t-test, Wilcoxon, Benjamini–Hochberg, Wilson-based budget decisions | No. It captures prompts with SDK instrumentation and replays them on both models | Impossible | Deterministic checks are JSON Schema, regex and length |

- Already available elsewhere, so not a differentiator: calling service code, repeats, regex and JSON checks, cost and latency totals, CI pass-rate gates, judge-human agreement, statistical tests of a two-model difference.
- Missing, so owned by this tool:
  1. A rule ledger tied to rendered prompts. Anchors catch "the check exists but the sentence left the prompt" and "a rule or language without cases" on every pull request, without a model call.
  2. Separate records and comparison of raw, shipped, discarded and substituted outputs, including the masked rate and the discard rate per variant. A tool that does not run service code cannot do this, and general tools can only imitate it with untyped metadata.
  3. Margin-based non-inferiority per rule × language cell and a decision view that does not count undecided cells as passes and says how many trials are needed.
- A runner contract is required for the pre-start cost refusal and the per-attempt cap (constitution VII); promptfoo has neither. Trial semantics (raw, `finalKind`, token buckets, finish reason) must be schema-enforced at the boundary. The unit of acceptance differs: promptfoo accepts per test row and caches per repeat index, this tool judges per cell. promptfoo shipped four releases in 2026-10 alone, so an adapter layer would chase its result format.
- Cost of the choice: the adapter client, concurrency and resume are built and tested here, and there is no provider integration list. The trial format is public, so an importer from other tools can come later and reuse the grading and the result page.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| promptfoo as the execution engine with a grading layer on top | The reasons above. Adaptive sampling would need an outer loop that calls the engine in batches |
| Inspect AI as the engine | Python only, the CLI contract for people and agents (constitution VIII) would sit on top, and rerouting by model name leaves the service's discard and fallback decisions to be captured separately |
| EvalShift | Does not run service code, so post-processing and discards are invisible |

## R2. How to reproduce the production path

**Decision**: Run the service's real turn function against fake storage and let only the model call go out; capture the raw answer at the model call (plan D2).

**Rationale**:

- One chat turn draws its model input from many places: persona and language rules, user blocks such as names and relationships, and per-turn blocks such as time, mood, summaries and memories. When the turn function decides the order and position of those blocks, no assembly result exists apart from running it. Rendering is therefore also obtained by running the turn function and capturing the answer request (feature 003, render mode).
- Post-processing (removing other scripts, cleaning symbols, replacing names, rejecting empty answers) also lives in the turn function. Skipping it hides what the service ships and what it discards (R6).
- A service may have several model paths. If a one-shot call and a tool loop send different reasoning settings, reproducing only one path misses regressions on the other.
- A comparison script that sends only the system prompt is fine for reading answer quality and for cost and latency, but not for judging rules after production blocks and post-processing.
- Services that already test the turn function with a fake session and an intercepted model call can reuse that harness in the adapter.
- A trap: code that drops a block when reading optional context fails, combined with a fake session that returns the same value for every query, turns a new read path into a silently missing block. Fake storage must raise on unexpected queries, and cases carry anchors for blocks that must be present. Because the turn function also writes after the model call (messages, memories, answer checks), such exceptions can happen after the answer arrived. Exceptions the adapter did not declare as discards are adapter errors, so the mismatch does not hide in the discard rate.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Call the assembly fragments and copy the glue code into the adapter | The copy keeps running after the service changes and drifts silently |
| Call a deployed development server's API | Per-case state (memories, mood) is hard to control, and it writes to storage |
| Extract the persona string and let the tool call the model | Production blocks and post-processing are missing, the same limit as the comparison script |

## R3. Verdict statistics

**Decision**: Case-weighted compliance, a Newcombe hybrid score interval for the difference with a Rao–Scott design effect, a Student t quantile with K − 1 degrees of freedom for the upper bound of cells with fewer than 10 cases, a fixed verdict order, a minimum trial count derived from the margin, and a power-aware estimate of the trials a new run needs.

**Rules**: [data-model §Statistics](data-model.md#statistics).

**Rationale**:

- Cases are different situations and repeats re-measure one situation. Trial weighting would over-represent cases with more surviving trials; ñ keeps the interval width honest when errors make trial counts uneven.
- Wilson intervals keep a non-zero width when every trial passed. The design effect accounts for correlation between repeats of one case. The paired structure enters through d_i, but deff never drops below 1, so pairing can only widen the interval.
- Closed form means no resampling and no seed: the same records give the same interval (constitution VI).
- Passing means every gated cell is non-inferior, an intersection-union test, so α per cell keeps the overall false-pass rate at α (Berger 1982). Blocking means any cell regressed, a union, so the family error needs α/G.
- Correcting the lower bound as well makes unchanged candidates fail. At baseline 0.95, 30 cases, 5 repeats and margin 0.10, on the 10,000 families of the (d) reference, one-cell pass rates move from 78.2/81.1% (both bounds corrected) to 94.0/94.9% (upper only), and all five cells from 29.6/35.2% to 73.3/76.9%, while blocking stays the same.
- The estimate targets the population of cases, so a false block is a `regressed` verdict when the case population means are equal. The between-case variance V_cl has K − 1 degrees of freedom; with 5 gated cells and 3 cases the one-sided 0.5% normal quantile is 2.576 while t with 2 degrees of freedom is 9.925, so with the normal quantile a small V_cl by chance makes U too narrow. The effect is largest near a 0.5 baseline, where Wilson is close to Wald, and with 10 repeats, where V_bin is small, so the floor deff ≥ 1 does not keep U wide. From 10 cases on, the normal quantile already holds the per-cell level (about 0.45% against 0.5% nominal in the TypeScript variant Monte Carlo of §Design-time validation), so t applies below 10, the `few-cases` boundary, and only to U; L, the pass side, keeps z_L.
- The 3 in verdict row 2 is a fixed floor. With K = 1, V_cl cannot be computed; with K = 2 it has one degree of freedom and falls below 10% of its true value with probability 25%.
- Regressions (verdict row 3) come before `minCases` (row 4) and the trial floor (row 7) so that a collapse is caught on small samples. At 5 cases, 5 repeats and margin 0.10, a drop from 0.95 to 0.20 is detected 55.9/42.8% of the time (low/high heterogeneity); the other order would hide it as `insufficient`, since 25 trials are below n_min = 35. At 3 cases the t upper bound leaves 9.1/7.2%: no interval with 2 degrees of freedom can both keep false blocks at 5% and catch a collapse often. Raising `minCases` blocks passes, never blocks.
- n_min: when both variants pass every trial, L = −z²/(n+z²), so L > −m needs at least n_min(m) trials ([data-model §Statistics](data-model.md#statistics)). Below it, equal observed rates can never pass and only a luckier candidate can.
- An undecided cell always sits on the −m boundary, on either side. Without the power term a true value equal to the estimate decides only half the time. Repeats of the same case cannot shrink the between-case part, so a large one asks for cases.
- "About 80%" treats the observation as the truth and is not a guarantee. Rerunning after every undecided result to chase a pass multiplies false-pass chances by the number of tries (up to about 2α for two), so the result shows how many times the same pair of variants was compared.
- Metric warning thresholds: the defaults for discard and regeneration increases (0.01 and 0.03) are about twice the standard error of the difference at 450 trials per variant (about 0.5 pp near 0.5% and 1.5 pp near 5%), giving about a 2% warning chance for an unchanged candidate. That standard error ignores case clustering; when discards or regenerations repeat on the same cases (design effect 1.8) the chance rises to about 6%. Warnings never change the exit code, so they are tuned not to miss.

**Defaults and budget**: The target is at most 0.5 USD per swap check (SC-007).

- The default sample is about 450 trials per variant, 30 cases per language × 5 repeats for a three-language service. In the R4 example it costs about 0.24 USD when repeats hit the cache and about 0.80 USD when nothing hits.
- Margin 0.10 is the smallest that meets SC-003 (c) and (d) together with this sample. Required trials grow with 1/m², so margin 0.05 needs about four times the trials per cell for the same pass rate.
- Rules can set their own `margin`; lint and `--dry-run` show the n_min it needs.

### Design-time validation (SC-003)

- **Method**: Monte Carlo through the shipped statistics code, `bench/sc003.ts` with the seeded generator of `bench/random.ts` (`pnpm bench`, run in CI), which exits non-zero when an item misses its target. Per-case compliance is drawn from Beta(μκ, (1−μ)κ), with low heterogeneity κ = 49 (ICC 0.02) and high κ = 4 (ICC 0.20). Baseline and candidate are linked three ways: identical probabilities (null), quantiles from a shared uniform draw (regression, keeps case difficulty order), and equal means with independent draws per case (null sensitivity). Grid K ∈ {3, 5, 10, 30} × r ∈ {3, 5, 10} × m ∈ {0.05, 0.10, 0.15}, 1,000 runs per combination for one-cell items and 1,000 families for items (a) and (d), plus a (d) reference over 10,000 families from the same seed, whose first 1,000 are those of (d). Seeds fixed.
  - Item (a) runs the gate procedure per comparison. A comparison has 5 rules at true baseline μ ∈ {0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99}, either all five at μ or four at 0.95 and one at μ. The default `report.lowBaseline` (0.9) removes cells whose observed baseline rate is below it, as in [data-model §Gate](data-model.md#gate), G is the number of cells left, and a false block is a comparison with any `regressed` gated cell; a comparison without a gated cell is not blocked. The same grid also runs 5 cells gated whatever their baseline (G = 5), which measures the interval alone.
  - Figures for the rejected alternatives on the upper-bound quantile and the low-baseline filter (the rows from "Normal quantile for the upper bound at every K" to "Current filter, plus t at every K …") come from a Monte Carlo in TypeScript of variants of the shipped statistics code on the same scenarios, 4,000 families per combination, with 20,000 draws per cell for the rates among cells that enter the gate. The same variants run on the draws of the (d) reference give the both-bounds comparison in R3 and the row "Student t for both bounds at every K", so those compare with the chosen method on the same 10,000 families.
  - Figures for the other rejected alternatives come from a Monte Carlo in Python (numpy, scipy) on the same scenarios, 1,000 runs per combination and 200 families. Neither the TypeScript variants nor the Python code is part of the repository.
- **Results** (each "low/high heterogeneity", %):

| SC-003 item | Measured | Target |
|---|---|---|
| (a) No regression, comparisons with any `regressed` gated cell, default `report.lowBaseline` | Max 3.4 (equal means, all five rules at 0.75, 10 cases, 3 repeats, m 0.05, high heterogeneity); 1.4 for the identical-probability null (0.8, 10 cases, 5 repeats, m 0.05, low heterogeneity); four at 0.95 and one at μ: max 0.3 | ≤ 5 |
| Reference: (a) with 5 cells gated whatever their baseline | Max 2.8 (equal means, 0.6, 10 cases, 10 repeats, m 0.05, high heterogeneity); at most 0.6 for the identical-probability null | — |
| (b) True difference −m, one cell wrongly passes | Max 4.2, cell mean 1.1 (two boundary scenarios at baseline 0.95 × 48 case/repeat/heterogeneity cells; nominal 2.5) | Mean ≤ 2.5, max ≤ 5 |
| (c) 0.95 → 0.65 detected, 30 cases, 5 repeats, m 0.10 | 97.4 / 96.8 | ≥ 80 |
| (c) 0.95 → 0.65 detected, 10 cases, 10 repeats, m 0.05 | 96.2 / 85.0 | ≥ 80 |
| (d) Unchanged candidate (baseline 0.95), 30 cases, 5 repeats, m 0.10, one cell passes | 93.4 / 95.3 (10,000 families from the same seed: 94.0 / 94.9) | ≥ 90 |
| (d) Same, all 5 cells pass | 70.0 / 78.4 (1,000 families, standard error 1.4 / 1.3 pp; 10,000 families from the same seed: 73.3 / 76.9) | ≥ 70 |
| Reference: lowest coverage of the population Δ by an ungated cell's [L, U], over the 48 cells of (b) | 94.9 (nominal 95) | — |

- **Margin trade-offs** (30 cases, 5 repeats):

| Margin | n_min | 0.95 → 0.65 detected | Unchanged at 0.95: one cell · 5 cells | Unchanged at 0.99: one cell · 5 cells | 0.99 → 0.95 (5× failures) passes |
|---|---|---|---|---|---|
| 0.05 | 73 | 99.8 / 99.8 | 41.7/44.5 · 1.3/2.4 | 85.3/85.5 · 44.1/46.7 | 5.0 / 8.9 |
| 0.10 | 35 | 97.4 / 96.8 | 93.4/95.3 · 70.0/78.4 | 100/99.2 · 99.8/95.9 | 66.4 / 56.9 |
| 0.15 | 22 | 78.8 / 70.6 | 99.9/99.9 · 99.6/99.7 | 100/100 · 100/100 | 98.4 / 94.6 |

  - 0.05 is practical only for mechanical rules around 0.99 compliance (the simulation looked only at 0.99) with 10 repeats (30 cases × 10 repeats at 0.99: all 5 cells pass 95.1/87.7%), at twice the cost. 0.15 fails SC-003 (c).
  - Margin 0.10 can call 0.99 → 0.95 non-inferior even though failures grew five-fold, so every cell also shows failure rates and their ratio.
- Cells with fewer than 10 cases seldom block, even a collapsed rule. At margin 0.10 with 5 cases × 5 repeats, drops from 0.95 to 0.20, 0.50 and 0.65 are detected 55.9/42.8%, 12.2/7.4% and 2.0/1.0% of the time (67.7/48.7, 19.5/13.5 and 6.0/2.5 at margin 0.05); with 3 cases × 5 repeats a drop to 0.20 is detected 9.1/7.2%. With 10 cases × 5 repeats at margin 0.10 the same drops are detected 100/100, 90.3/85.8 and 41.1/28.5%. A gate meant to stop a 30-point drop needs 10 or more cases per cell (lint `few-cases`).
- **Limits**: Rules were simulated as independent; they share trials in practice, so family false-block rates should be lower and joint pass rates higher. Only two Beta heterogeneity levels were tried, not a bimodal mix with always-failing cases, and only equal trials per case. Boundary scenarios covered two cases at baseline 0.95 (0.95 → 0.90 at m 0.05, 0.95 → 0.85 at m 0.10), not 0.80 or 0.99 baselines. Verdicts of ungated cells (α_U = α) were not simulated; only the coverage reference uses the ungated interval. Standard errors are 0.7 pp near 5% and 1.3 pp near 80% for 1,000 runs or families, 0.35 pp near 5% for the 4,000 families of the TypeScript figures, 0.45 pp near 74% for 10,000 families, and 1.5 pp near 5% and 3.1 pp near 73% for the 200 families of the Python figures.
  - The low-baseline filter acts on the observed baseline rate, so a rule whose true baseline is below `report.lowBaseline` enters the gate when its baseline happens to look good, and its candidate then tends to look worse by regression to the mean. Among such cells alone, a family of 5 has a false block in up to 19.8% of cases at a true baseline of 0.75 and 9.5% at 0.80 (equal means; up to 5.3% for identical probabilities), falling to 1.9% at 0.85 and 0.4% at 0.90. These cells seldom enter the gate, so the rate per comparison of item (a) stays at or below 3.4%. Conditional figures rest on 500 or more entering cells per combination; with 500 to 700 the standard error is about 2 to 3 pp.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Union of a paired two-stage bootstrap and the Newcombe interval | With both bounds corrected, unchanged candidates pass one cell 73.5/75.9%; with the upper bound only, 90.7/92.8%, below the chosen method in the same Python run (94.1/95.1). Resampling trials after cases counts within-case variance twice (Davison & Hinkley 1997, §3.8; 1.6 to 1.9 times the true variance at 30 cases × 5 repeats). Resampling also lets the seed flip verdicts near the boundary |
| Union of a one-stage case bootstrap and Newcombe | Detects more, but family false blocks reach 8.0% at 3 cases × 10 repeats and boundary false passes 4.7% at 10 cases × 10 repeats |
| Bootstrap alone | Zero width when every trial passed; lowest coverage 30.5% |
| Newcombe without design effect | Ignores between-case variance and is too narrow; lowest coverage 75.6% |
| Bonferroni on the lower bound too | Passing needs no correction (above), and unchanged candidates get blocked |
| Normal quantile for the upper bound at every K | Item (a) reaches 8.3% (equal means, baseline 0.5, 3 cases × 10 repeats, m 0.05, high heterogeneity, 4,000 families): V_cl with 2 degrees of freedom is too often small by chance |
| Student t for the upper bound at every K | Item (c) at 10 cases × 10 repeats, m 0.05 falls to 85.8/58.7%. At 10 cases the normal quantile already holds the per-cell level, so t there only widens |
| Student t for both bounds at every K | The same loss in (c), and passing needs no correction: on the 10,000 families of the (d) reference, unchanged candidates pass one cell 93.4/94.5% and all 5 cells 71.0/75.1%, against 94.0/94.9% and 73.3/76.9% for the chosen method |
| t at the family level, max(z_U, t_{K−1, 1−2α/G}) | Item (c) at 10 cases × 10 repeats, m 0.05 falls to 92.8/76.4% |
| Keep the normal quantile and state SC-003 (a) only for baselines of 0.9 or more | A false block is defined on the case population, so a narrow U with few cases is a defect at any baseline. The low-baseline filter acts on the observed rate, so rules with a true baseline of 0.8 still enter the gate |
| Gate a cell unless its baseline upper bound u_b is below `report.lowBaseline` | Among entering low cells, families of 5 falsely block up to 13.1% at a true baseline of 0.7, and a true 0.7 cell enters the gate 54% of the time at 3 cases × 5 repeats, gating rules the baseline does not hold |
| Gate a cell only when its baseline lower bound l_b reaches `report.lowBaseline` | Drops 51–73% of cells with a true baseline of 0.95 at 30 × 5 and 10 × 10, and all of them at 3 × 5; a dropped cell cannot block a collapse |
| Gate on the Wilson centre (l_b + u_b)/2 | Families of 5 entering low cells falsely block up to 14.9% at a true baseline of 0.8, and up to 36% of true 0.95 cells leave the gate at 10 × 10 (all at 3 × 5) |
| Current filter, plus t at every K for cells whose baseline lower bound is below `report.lowBaseline` | Families of 5 entering low cells still falsely block up to 10.0% at a true baseline of 0.7, and item (c) at 10 cases × 10 repeats, m 0.05 falls to 87.6/67.5% |
| Gate on the mean of baseline and candidate rates | A collapsed candidate pulls the mean below the threshold (0.95 → 0.65 gives 0.80) and removes the regressed cell from the gate |
| Absolute threshold (candidate ≥ 90%) | Rules the baseline already broke look like failures every time; a swap question is relative |
| Ratio margin on violation rates | Closer in meaning at high compliance, but unaffordable: allowing "twice the failures" at a 1% baseline failure rate needs about 3,300 trials per cell and variant for an unchanged candidate to pass 80% of the time (normal approximation; Monte Carlo 77% at 3,000 and 83% at 3,500). Even a 1-point absolute margin with a known baseline needs 1,500 to 1,800, several times the default sample of about 450 trials per variant |
| Chi-square or Fisher test per trial | Ignores correlation between repeats, and answers "is there a difference" instead of "is the difference small" |
| Bayesian hierarchical model | The prior drives the result and readers cannot check it |
| Looking after every repeat and stopping early | Each look adds false conclusions; adaptive sampling with alpha spending is a later feature |

## R4. Cost estimate and budget

**Decision**: Three estimates with different jobs, a cap checked before every attempt, and a default cap of 1 USD. Rules: [data-model §Cost](data-model.md#cost).

1. The expected estimate decides whether to start and is what SC-005 measures; the conservative estimate only warns; the reservation of each attempt holds the cap during the run.
2. Input tokens come from the render when it reports them, otherwise from a generous estimate based on message length. The tool ships no tokenizer.
3. The default cap `budget.maxCostUsd` is 1 USD, twice the 0.5 USD goal for two small models with default settings (SC-007). The cap is not a forecast; crossing it asks a person to decide again.

**Rationale**:

- Example service: a multilingual chat feature with a long shared prompt of about 4,500 tokens per call, short answers averaging about 50 output tokens with p95 100. Prices per million tokens (input, cache hit, cache write, output): baseline 0.10, 0.01, 0.125, 0.50; candidate 0.20, 0.02, 0.25, 1.20. These match `model-a` and `model-b` in the config example.
- Default settings, 450 trials per variant:

| Case | Baseline | Candidate | Total |
|---|---|---|---|
| Cache hits from repeat 1 on (the intent of the send order) | $0.078 | $0.161 | $0.239 |
| Only 25% of the prompt hits, the rest is written | $0.206 | $0.417 | $0.623 |
| No cache hits | $0.264 | $0.533 | $0.798 |
| Expected estimate on a first run (output assumption 600) | $0.202 | $0.458 | $0.659 |
| Conservative estimate (output 600) | $0.388 | $0.830 | $1.218 |
| Conservative estimate (previous p95 100) | $0.276 | $0.560 | $0.836 |

- Input dominates the cost because answers are about 50 tokens. Cache hits therefore decide the cost, and the send order makes repeats of a case hit the cache. Repeats sent together would all be billed as writes before the cache exists.
- A first run starts at an expected $0.66 under the 1 USD cap and warns because the conservative $1.22 is above it. Later runs use measurements.
- With a 1,024-token output limit, a reservation is about $0.0011 for the baseline and $0.0024 for the candidate. Four concurrent attempts for each variant reserve about $0.014 in all, so the check does not block a run that is not near the cap.
- If both models sit at the SC-007 price limit (input 0.2, output 1.2, cache prices in the same ratio), a first run's expected estimate is $0.92 at an output assumption of 600, close to the cap, and an estimated input above about 5,900 tokens refuses to start. Korean and Japanese prompts are over-estimated by length and cross that line easily. Most of that estimate comes from the output assumption, so it should not exceed the render's output limit and should be set to the service's usual answer length; at 150 it is $0.43. At the same prices with no cache hits the actual cost is about $1.07, so the first re-estimate stops the run with `budget-projected`. SC-007's "without raising the cap" assumes the cache hits from the second repeat on.
- SC-007 depends on the first row. A provider cache can scatter identical prompts sent close together across servers and hit less often, so the real value is measured with the cache hit ratio in the integration; with no hits it is about $0.80, over the target.
- Starting on the expected estimate: with a long shared prompt the conservative estimate is a multiple of the expected one (1.85 times on a first run, about 3.5 times later). Refusing on it would block most runs that never reach the cap and push people to disable or raise the cap. The check before every attempt holds the cap instead (data-model §Cap Check).
- Re-estimating after the first batch: output tokens per trial are unknown on a first run, and reasoning models can emit several times the visible answer (R6). Twenty measured trials catch that early, and including repeat 1 in the batch also measures whether the cache really hits.
- Re-estimating every repeat round: with many cases, the gap between repeats of one case can exceed the provider's cache lifetime, so later repeats miss the cache measured in the tight first batch.
- Reservation and overrun: one trial's cost depends on tool loops and output length and is unknown in advance. The tool keeps a condition at send time that tests can verify, and shows the overrun where the reservation fell short (constitution VII).
- Cache hits and writes have different prices. Anthropic bills writes at 1.25 times input (5-minute lifetime) or 2 times (1 hour); OpenAI, for GPT-5.6 and later, at 1.25 times (default lifetime) or 2.5 times (12 hours). The example uses 1.25 times. Providers also report tokens differently: OpenAI's input total includes hits and writes, Anthropic's excludes both. The protocol's token buckets therefore never overlap, and the helpers map provider fields to buckets (feature 003). Sources: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Refuse to start when the conservative estimate exceeds the cap | The example's first run would be blocked at the default cap |
| Default cap of 2 USD | Four times the target could be spent without asking; starting on the expected estimate makes 1 USD enough |
| Stop only when actual cost reaches the cap | In-flight requests overshoot it, and long outputs spend the whole cap before stopping |
| Limit calls per trial to hold the cap exactly | Blocking calls inside the helper changes service behaviour (constitution I) |
| Reserve output at p95 | By definition 5% of trials exceed it; the in-run check must not undershoot, so it uses the output limit and only the warning uses p95 |

## R5. Pulling rule origins from git

**Decision**: No automatic link. The rule's `origin` is an optional field written by a person, and the rule file is the single record of the rule's reason, anchors and check.

**Rationale**:

- `git blame` names only the last commit that touched a line. One large prompt cleanup makes it the blame of many lines and hides the commit that added each rule and why.
- When sibling commits that add the same sentence are merged, blame can skip the commit with the reason, and plain `git log` hides such commits through history simplification (`--full-history` is needed).
- Prompt commits often have no body, so the reason is not in git at all.
- A person looking it up once and writing `origin` is more accurate.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Fill `origin` from `git blame` or `git log` | Both miss the commit that added a rule for the reasons above, and the reason is often not in git at all |

## R6. What breaks after a model swap

**Decision**:

1. The example config gates on the `completed` rule. Rejections, empty answers, `length` finishes, discards and fallbacks all fail it (R8). When only the chat turn is connected, background-job failures stay invisible, so the result names the judged targets to keep it from reading as "safe to swap".
2. Mechanical output rules become deterministic rules. Violations that post-processing removes, such as other scripts, are gated on the raw answer. Small changes in rare violations cannot be decided at the default margin, so the result shows failure rates and examples alongside (R3).
3. Semantic rules are `review` rules judged side by side by people; LLM judges are a later feature.
4. Trials record the finish reason and output tokens including reasoning, and the result shows finish-reason distributions and output tokens per trial per variant.
5. Trials record `modelSnapshot`. A service that calls a model alias can change behaviour while its config stays the same, so the guide covers comparing the same variant at two points in time (`model-eval compare <old run> <new run>`).

**Rationale**: The fix commits that followed one model swap in a multilingual chat service fall into two groups. Other services will differ in detail, but the two shapes should hold.

- Calls break: the result is empty, cut or rejected.
  - Sending function tools together with reasoning settings makes the new model reject the request (HTTP 400).
  - Reasoning tokens count against the output limit: HTTP 200, finish reason `length`, zero characters. A caller that silently falls back to a default message hides it.
  - For the same reason structured output is cut midway and schema validation fails repeatedly.
  - These failures show up first in background jobs with short output limits (summaries, judgements, notification text), before the chat turn.
- Output rules break: problems that prompts and post-processing had fixed come back.
  - Mechanical ones: characters of another script at the end of an answer, a Latin string glued to a period without a space, per-language spelling of a character's name, Markdown emphasis.
  - Semantic ones: volunteering its own state before being asked, talking about the user's experience as its own, inventing facts, overdoing crisis responses, chaining questions.
  - Mixed-script violations appear a few times in hundreds of answers, so reading a few answers cannot tell whether they increased.

**Alternatives considered**: none; this entry records observed failures and the checks that answer them.

## R7. Rules that differ by language

**Decision**:

1. The unit of judgement is rule × language × output surface. A case has one language and a cell uses only that language's cases. The pooled value is reference only.
2. G in the multiplicity correction is the number of gated cells.
3. Differences between languages are shown, not judged (constitution IV). Rules name their languages in `languages`. Lint reports languages without an anchor as `unanchored` (info) and languages without cases as `language-gap` (warning).

**Rationale**:

- Multilingual services often keep a persona prompt per language, so one rule is instructed by different sentences per language and a swap can break it in one language only.
- Pooling dilutes. With equal case counts in three languages, a 30-point drop in Japanese is about a 10-point pooled drop and can fit in margin 0.10.
- Editing prompts per language leaves rules on the same topic pointing different ways or present on one side only (commas, question marks, crisis guidance, reading out timestamps). Some of those differences are intended, and treating them as errors would let the tool make policy.
- Cost: every cell needs cases. Gated cells should have 10 or more cases per language (R3), and the defaults assume 30 per language.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Pool languages for the verdict, show per-language values for reference | A regression in one language is diluted |
| Pooled verdict plus a "block if any language regressed" option | Needs per-language intervals anyway and splits the multiplicity calculation in two |

## R8. Trial outcomes and the default gated surface

**Decision**: Classify trials by [data-model §Trial Outcomes](data-model.md#trial-outcomes), and gate on the raw answer by default (`gateOn: raw`).

**Rationale**:

- Services discard cut or empty answers by raising, and also discard answers with nothing left after post-processing, such as an answer entirely in another script. Removing those trials from every denominator would drop the worst violations and make a candidate that discards more look better (survivorship bias).
- Time-outs are similar. Missing the service's time limit clusters on hard cases; treating it as transient and retrying would judge a slow candidate without its hard cases and give it more chances than production, where only the service's own retries exist.
- A transient failure that repeats on one case is not chance. Repeat-major order spaces out the repeats of a case, so a short outage rarely hits all of them. The same holds for adapter errors: the two variants share the adapter and the cases and differ only in the model, so adapter errors in one variant mean that model's answers broke the service code. If the cause is the harness, such as fake storage, it surfaces as a `completed` regression with a typical error message and gets fixed. Trials the tool abandoned at its own time limit are adapter errors too, and concentrated on one case they mean the model is that slow on that case.
- Discards are kept apart from adapter errors because a discard can result from the candidate's behaviour and is compared. Counting an undeclared exception (for example fake storage rejecting a query) as a discard would hide a harness mismatch in the discard rate: equal on both variants it passes unnoticed, different per variant it blocks falsely.
- Some services replace the model output with a fixed message when an answer check fails, for example a recalled memory that does not match the record. The shipped text then passes nearly every rule.
- A tool loop can accept a structured final answer that arrived with finish reason `tool_calls`. The provider's finish reason would make a normal turn look cut.
- Post-processing removes other scripts, Markdown and meta sentences (R2). Gating those rules on shipped text passes them however often the model breaks them. The question here is whether prompt rules hold, so the default is the raw answer.
- Regeneration is another mask. A service that regenerates when an answer mixes scripts would show nearly the same raw rate even if the candidate broke the rule several times more often on its first answers, so raw is the first answer. Rules whose accepted fix is regeneration use `gateOn: final`.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Remove discarded trials from every denominator | Survivorship bias: the more a candidate discards, the better the rest looks |
| Remove rejections (`permanent`) from denominators | A candidate that gets HTTP 400 every time ends as undecided (the rejection in R6) |
| Count authentication failures and unknown models as rejections | When both variants fail, completion is 0% against 0% and passes; a missing key in CI becomes a false pass |
| Leave transient failures and adapter errors concentrated on one case of one variant out of the denominators, like other such failures | The case drops out of the comparison silently, although the likely cause is the model's response on that input (a provider error only that input triggers, or a response that breaks the service code) |
| Count every transient failure as a completion failure | Rate limits caused by evaluation load would block swaps. Instead the run stops above half and only concentrated failures count |
| Exempt cases that may have clustered by chance (few repeats, frequent transient errors) from systematic failure | A request that failed in the service can fail the same way in production; calling clustered failures luck misses real repeated failures. Concurrency control and the transient-rate warning reduce evaluation load instead |
| Only warn about adapter errors concentrated on one case, or leave them undecided | Warning lets a candidate pass with the cases it breaks left out (constitution II). Undecided avoids false blocks from the harness but also misses real service breakage |
| Treat time-outs as transient and retry | Survivorship bias for slow candidates and more chances than production |
| Judge an empty raw answer with content rules | Forbidding checks always pass an empty string and inflate compliance; empty output belongs to `completed` |
| Gate on shipped text by default | Rules that post-processing enforces nearly always pass there |
| Treat the shipped text as the raw answer | Violations masked by regeneration disappear from raw compliance; a regeneration rate alone shows cost and latency but not which rule broke |
