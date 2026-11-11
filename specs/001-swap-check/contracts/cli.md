# CLI Contract

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

## Commands

| Command | Calls models | Does |
|---|---|---|
| `model-eval init [--adapter python\|node]` | no | Creates a config template, example rules and cases, and adds the output directory to the `.gitignore` of the config file's folder. Files that already exist are kept. Example rules and cases are written only together with a new config file; with an existing one, `init` adds that config's `output.dir` to `.gitignore` and stops with exit code 4 if the config cannot be loaded. With `--adapter`, also an adapter skeleton that uses the helper (feature 003) |
| `model-eval lint` | no | Checks file schemas, ID references, provenance, examples, case input schemas, the sample plan of gated cells and the helper version. `--render` also renders cases per variant and checks anchors. Starts the adapter unless `--no-adapter` (see [adapter-protocol §Security](adapter-protocol.md#security)) |
| `model-eval run --variant <id>` | yes | Runs every case with one variant, records the run and grades it |
| `model-eval grade <runId>` | no | Re-grades stored trials with the current rules into a grade set |
| `model-eval compare <baseRunId> <candRunId>` | no | Grades both runs with the current rules, compares cells, applies the gate and writes `report.md` and `report.html` |
| `model-eval swap --from <id> --to <id>` | yes | Runs both variants, grades, compares, gates and writes the reports in one go. The everyday command |
| `model-eval report <comparisonId>` | no | Rewrites `report.md`, `report.html` and the output `index.html` from a saved comparison, for example with a newer tool version |

### Common Options

| Option | Meaning |
|---|---|
| `--config <path>` | Config file. Default `./model-eval.config.yaml` |
| `--json` | Write exactly one JSON document to stdout; progress goes to stderr |
| `--lang <en\|ko>` | Language of human output and of the result page. Default from config `lang`, else `en` |
| `--verbose` | Show adapter stderr and per-stage timings |
| `--no-color` | Disable colour. `NO_COLOR` is honoured too |

### Top-Level Options

Given without a command:

| Option | Meaning |
|---|---|
| `--version` | Print the tool version and exit |
| `--help`, `-h` | Print the commands and common options and exit |

### `lint` Options

| Option | Meaning |
|---|---|
| `--render` | Check anchors through the adapter's `render`; also checks adapter conformance (handshake, stdout contamination). An adapter without the `render` capability is `adapter-failed` |
| `--variant <id>` | Render only this variant. Default: every variant, since variant parameters can change prompt blocks. Only with `--render` |
| `--max-warnings <n>` | Exit 1 when warnings exceed n. Info codes (`unanchored`) do not count. `0` in CI blocks pull requests on missing anchors |
| `--no-adapter` | Do not start the adapter; skip input-schema, target and anchor checks. Together with `--render` it is a usage error (exit 4) |

Without `--render`, lint still starts the adapter with the first variant to obtain input schemas. If the adapter fails to start or breaks the protocol (stdout contamination included), lint reports `adapter-failed` and exits 4, as every command treats adapter problems as configuration problems.

### Options of `run` and `swap`

| Option | Meaning |
|---|---|
| `--repeats <n>` | Repeats for this run; overrides `sampling.repeats` |
| `--cases <glob>` | Run only cases whose ID matches, case-sensitively; `*`, `?`, `[...]` (`!` or `^` negates), `{a,b}` and `\` escapes; an unclosed bracket or brace and braces without a comma are literal. Comparisons use common cases |
| `--max-cost-usd <x>` | Override `budget.maxCostUsd` once; `none` runs without a cap. Allowed on resume, where the cap includes earlier spend |
| `--dry-run` | Show calls, tokens, expected and conservative cost with their basis (previous run or first-run assumption), reservation per attempt, and planned trials and n_min per gated cell, then exit. Exit 4 when input tokens cannot be estimated, 5 when the expected cost exceeds the cap, else 0. With `--resume`, change nothing and show remaining trials and the re-estimated total; exit 5 when it exceeds the cap |
| `--concurrency <n>` | Concurrent requests per adapter process (per variant), at most the adapter's `maxConcurrency` |
| `--resume <id>` | `runId` for `run`, `swapId` for `swap`. Resumes only stopped runs; see [data-model §Resume and Locking](../data-model.md#resume-and-locking) for what is resent, kept and refused |

After exit code 2, run again with the suggested `--repeats` as a new run. It is not pooled with the earlier run (constitution II); the result shows how many times this pair of variants was compared.

## Exit Codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `ok` | Finished. For `compare` and `swap`, the gate is `pass` or `no-gate`. For `lint`, no errors and warnings within the limit |
| 1 | `failed` | `compare` and `swap`: the gate is `block`. `lint`: errors, or warnings above the limit |
| 2 | `undecided` | Nothing blocks but it cannot count as a pass: regardless of the gate config, an unfinished run was compared, a run had nothing to judge, or the baseline completed fewer than half of its trials in some language; or a gated cell is undecided, no gated cell was judged, or a gated rule has no judged cell |
| 3 | `run-failed` | The run could not finish because of the adapter or transient error limits or a user interrupt; it stays `partial` |
| 4 | `config-error` | See below |
| 5 | `over-budget` | The expected cost exceeded the cap and no model was called; or a re-estimate after the first batch, a repeat round or at resume exceeded the cap; or the next attempt's reservation, tool retries included, would cross the cap (the last two leave the run `partial`) |
| 6 | `internal-error` | An unexpected internal error; report it as a bug |

Exit code 4 covers:

1. Config, rule or case files cannot be read or validated.
2. A case failed to render at the start of a run.
3. A price is missing while a cap is set, including a model first seen during the run.
4. Input tokens cannot be estimated (no render count and no `estimate.inputTokens`).
5. The adapter does not start or initialise, or breaks the protocol during start, initialisation or lint. Violations during a run are adapter errors of that trial, and exit 3 once their limit is passed.
6. A model call, side calls included, failed on authentication, model, quota, billing or TLS certificate.
7. A restarted adapter declares a different adapter or helper version or service code.
8. Resume problems: generation conditions differ from the record, `--variant`, `--from`/`--to`, `--repeats` or `--cases` differ from the record, the run or swap is `complete`, a run that belongs to a swap is resumed with `run`, or another process holds the lock.
9. The command line is invalid: an unknown command or option, or an invalid option value, such as `swap --from` and `--to` naming the same variant, or `lint --render` with `--no-adapter` or `lint --variant` without `--render`.

- A stopped run exits with the code of its `stopReason` (`config-error` if present, else the first reason). Other overlaps resolve in the order 6, 4, 5, 3, 1, 2, 0. A `swap` stopped by the cap exits 5 whatever its comparison says; the comparison is still in `result.gate`.
- File errors exit 1 from `lint`, where they are findings, and 4 from `init` and from commands that call models, where they prevent the start.
- A stop with exit code 5 shows the outcome distribution per variant so far. A candidate that times out or is rejected every time has a candidate problem, not a cap problem.
- An empty gate never blocks: `no-gate` with code 0 when the preconditions hold, otherwise `undecided` with code 2. `no-gate` is shown apart from `pass`, because nothing was judged (constitution II, IV).
- Code 2 is not a pass; every undecided gated cell says what a new run needs.
- Codes and names are a public contract (constitution VIII); changing them requires a major version.

## `--json` Output

Every command uses the same envelope:

```json
{
  "schemaVersion": "1",
  "command": "swap",
  "exit": {"code": 1, "name": "failed"},
  "result": {
    "swapId": "20261105-101500-swap-a1b2",
    "runs": ["20261105-101500-current-c3d4", "20261105-101500-next-e5f6"],
    "gate": {
      "outcome": "block",
      "reasons": [{"code": "regressed", "ruleId": "script-ja", "lang": "ja", "surface": "raw"}],
      "blocking": [{"ruleId": "script-ja", "lang": "ja", "surface": "raw"}],
      "undecided": [],
      "excluded": []
    }
  },
  "warnings": [{
    "code": "abandoned-trials",
    "variants": ["next"],
    "params": {"trials": {"next": {"timeout": 2, "restart": 0}}, "timeoutMs": {"next": 120000}, "lateFailures": {"next": {}}}
  }]
}
```

The example leaves `result.comparison` out for length; a swap that reached the comparison carries it.

- `result` has a JSON Schema per command (`schemas/<command>.schema.json`). It is `null` when the command ends before it has a result: a usage or configuration error (exit code 4), including one found before a `run` or `swap` starts, or an internal error (exit code 6). A `run` or `swap` refused by the pre-start cost check (exit code 5) has `{plan}`, the same as `--dry-run`, so CI sees the estimate that refused it. A `swap` that stopped without comparing (FR-032 item 3) has `{swapId, runs}` without `comparison` and `gate`. `command` is `null` when the command line names no known command; such an envelope follows `schemas/envelope.schema.json`, the envelope of any command.
- Findings carry a code and `params`, never a sentence the tool composes; a validator's detail is data in English, and adapter text is data as written. The message files turn them into text in the `--lang` language ([data-model §Warnings](../data-model.md#warnings)).
- `warnings` holds every warning the command raised, in the shape of the comparison's `warnings[]`, with codes from the warning table or the lint table of the data model.
  - `lint` uses lint codes. Errors go to `result.errors` and info to `result.info` in the same shape, with `file`, `line` and `column` (FR-001). `warnings` holds only warning-level codes, matching what `--max-warnings` counts.
  - `compare`: equal to `result.comparison.warnings`.
  - `run` and `swap` include pre-start warnings (`few-cases`, `margin-unreachable`, `conservative-over-budget`); `swap` raises them once, not per run. `run` adds its run warnings. `swap` that reached the comparison carries `result.comparison.warnings`; one that stopped without comparing carries both runs' warnings grouped the same way, so CI still sees them. Copying run warnings next to the comparison's would duplicate them, since the comparison re-raises every run warning, or make them diverge from the result page counts.
- `result.comparison` and `result.gate` of `compare` and `swap` are the Comparison and Gate of the data model; `result.gate` equals `result.comparison.gate`. The result page reads the same comparison.
- `run --dry-run` and `swap --dry-run` create no run, so their `result` is `{plan}` alone:

  | Field of `plan` | Meaning |
  |---|---|
  | `variants[]` | Per variant: `variant` (ID), `trials` to send (the remaining ones with `--resume`), and `calls`, `inputTokens` and `outputTokens` summed over those trials; `basis` per language key (`*` for cases without a language), `history` or `structure`; `reservationUsd`, the largest attempt reservation of the variant at the start |
  | `expectedUsd`, `conservativeUsd` | Both estimates over every variant of the command. With `--resume`, `expectedUsd` is the re-estimated total with earlier spend included and `conservativeUsd` is `null` |
  | `maxCostUsd` | The cap, `null` without one |
  | `cells[]` | Per gated cell: `{ruleId, lang, surface, plannedTrials, nMin}` |

  Costs are `null` when no price is configured at all.
- `--json` output is redacted as well.
- JSON output does not depend on `--lang`.

## Human Output (example, `swap`)

Figures follow [data-model §Statistics](../data-model.md#statistics) (6 gated cells, corrected upper z = 2.638). The example assumes the 8 rules of [config.md](config.md#rule-files) plus one blocking rule that applies to a single language, one more `review` rule and `question-mark-ko`, 11 rules in all. The gated cells are `completed` in 3 languages, `script-ko`, `script-ja` and the added rule, 6 in all.

It is the second comparison of the two variants, so the cost estimate uses the previous run. Intervals depend on how failures and errors fall across cases; the example assumes one such layout.

```text
model-eval swap  current (model-a) → next (model-b)   90 cases (ko, en, ja × 30) · 5 repeats · 900 trials · $0.25 (expected $0.26 · conservative $0.85)
swap 20261105-101500-swap-a1b2 · 2nd comparison of these variants

Decision summary
  Worse        script-ja (ja, raw) 99.3% → 70.0%, failures ×45
               script-ko (ko, raw) 99.3% → 82.0%, drop confirmed · margin not decided
  Better       none
  Undecided    script-ko (ko, raw): run again with 15 repeats
  Operations   discard rate 0.2% → 3.0% · cost per trial ×2.20 · latency p95 ×1.37
  Scope        target chat · 9 of 11 rules judged · 2 review rules in the side-by-side view

Gate, 6 cells: 1 blocked · 1 undecided · 4 held   → BLOCK

✗ script-ja   ja  raw    blocking  base  99.3%  cand  70.0%  diff -29.3pp [-37.1, -19.2]  margin 10pp  Regressed     masked 0.7% → 27.3%
? script-ko   ko  raw    blocking  base  99.3%  cand  82.0%  diff -17.3pp [-25.1,  -7.9]  margin 10pp  Inconclusive  a new run with 15 repeats gives this cell 450 trials per variant (now 150) and the run 1,350; about 80% chance of a verdict (estimate)
✓ completed   en  trial  blocking  base 100.0%  cand  96.3%  diff  -3.7pp  [-8.4,  +1.4]  margin 10pp  Held          15 candidate transient errors excluded (no systematic failure)
  3 more gated cells held

Not gated (reference)
  no-emoji           ko  raw  major  98.7% → 98.0%   -0.7pp  [-4.5,  +3.0]  Held
  mood-not-revealed  ko  raw  major  93.3% → 86.7%   -6.7pp [-23.7, +10.0]  Too few samples (30 trials per variant < 35)

Low baseline (baseline compliance < 90%, not gated)
  question-mark-ko   ko  raw  base 82.0%  cand 84.7%
Side by side: 2 review rules, see the result page

Operations       baseline           candidate
  rejections     0.0% [0.0, 0.8]    0.0% [0.0, 0.9]
  time-outs      0.0% [0.0, 0.8]    0.0% [0.0, 0.9]
  transient      0.0% [0.0, 0.8]    3.3% [2.0, 5.4]
  discards       0.2% [0.0, 1.2]    3.0% [1.8, 5.0]   warning: increase over baseline
  fallbacks      0.0% [0.0, 0.8]    0.5% [0.1, 1.7]
  latency p95    1.9s               2.6s (×1.37)
  cost per trial $0.00017           $0.00038 (×2.20)  warning: more than twice the baseline
  Operational metrics do not affect the exit code.

Result page  .model-eval/comparisons/cmp-3f9a1c0e2b7d/report.html
Report       .model-eval/comparisons/cmp-3f9a1c0e2b7d/report.md
```

- The lower bound of a difference uses the configured level; the upper bound of a gated cell is multiplicity-corrected (data-model §Statistics). Ungated cells use neither correction.
- Metric denominators follow the data model: here the candidate's 435 trials (450 minus 15 transient) are the denominator of discard, fallback, rejection and time-out rates, and the 450 finished trials that of the transient rate.
- Required repeats and trials are shown for gated cells only.
