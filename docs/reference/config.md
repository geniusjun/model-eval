# Config reference

The config is `model-eval.config.yaml` in the folder you run from, or the file `--config` names.
Relative paths in it (`adapter.cwd`, the `files` globs, `output.dir`) resolve from the config
file's folder. Unknown keys are errors.

- [`examples/pogo/model-eval.config.yaml`](../../examples/pogo/model-eval.config.yaml) is a working
  config.
- [contracts/config.md](../../specs/001-swap-check/contracts/config.md#config-file) has an
  annotated config with every default.
- [`schemas/config.schema.json`](../../schemas/config.schema.json) is the JSON Schema. Editors with
  a YAML language server pick it up from a comment on the first line:

```yaml
# yaml-language-server: $schema=./node_modules/model-eval/schemas/config.schema.json
```

## Required keys

| Key               | Type     | Meaning                                                                                                                    |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version`         | `1`      | Config format version                                                                                                      |
| `adapter.command` | string[] | The adapter command as an array; no shell is involved                                                                      |
| `variants`        | list     | `{id, model, params?}` per variant. `params` is passed to the adapter and stored in the run as is; never put secrets in it |
| `pricing`         | map      | USD per 1M tokens per model: `{input, output, cachedInput?, cacheWrite?}`. The tool ships no prices                        |

## Optional keys

| Key                                    | Default           | Meaning                                                                                                        |
| -------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `lang`                                 | `en`              | Language of human output: `en` or `ko`                                                                         |
| `adapter.cwd`                          | `.`               | Working directory of the adapter                                                                               |
| `adapter.env`                          | `{}`              | Variables added to the adapter's environment. Not for API keys                                                 |
| `adapter.timeoutMs`                    | `120000`          | How long the tool waits for one trial. Make it longer than one service call can take, SDK retry waits included |
| `files.rules`                          | `rules/**/*.yaml` | Glob of rule files                                                                                             |
| `files.cases`                          | `cases/**/*.yaml` | Glob of case files                                                                                             |
| `sampling.repeats`                     | `5`               | Repeats per case                                                                                               |
| `sampling.seed`                        | `1729`            | Seed from which per-trial seeds derive                                                                         |
| `stats.confidence`                     | `0.95`            | Two-sided confidence per cell                                                                                  |
| `stats.minCases`                       | `3`               | Minimum common cases for a passing verdict; at least 3                                                         |
| `gate.severities`                      | `[]`              | Severities of gated rules. Empty: nothing blocks                                                               |
| `gate.margin`                          | `0.10`            | Margin for rules without their own                                                                             |
| `run.concurrency`                      | `4`               | Concurrent requests per adapter process                                                                        |
| `run.retries`                          | `2`               | Retries of transient failures. Time-outs are never retried                                                     |
| `run.maxAdapterErrorRate`              | `0.05`            | Above this share of adapter errors after 20 finished trials, the run stops                                     |
| `run.maxTransientRate`                 | `0.5`             | Above this share of trials still transient after retries, the run stops                                        |
| `budget.maxCostUsd`                    | `1`               | Cap on the spend the tool counts; `null` for no cap                                                            |
| `estimate.outputTokens`                | `600`             | Output tokens per trial, reasoning included, when no previous run exists                                       |
| `estimate.inputTokens`                 | none              | Input tokens per trial; required when the adapter cannot render                                                |
| `report.lowBaseline`                   | `0.9`             | Cells with lower baseline compliance are listed apart and not gated                                            |
| `report.samples`                       | `3`               | Failing examples per regressed cell                                                                            |
| `report.warn.transientRate`            | `0.05`            | Warning threshold of the transient error rate                                                                  |
| `report.warn.discardRateIncrease`      | `0.01`            | Warning threshold of candidate minus baseline discard rate                                                     |
| `report.warn.regenerationRateIncrease` | `0.03`            | Warning threshold of candidate minus baseline regeneration rate                                                |
| `report.warn.latencyP95Ratio`          | `1.5`             | Warning threshold of the latency p95 ratio                                                                     |
| `report.warn.costRatio`                | `2.0`             | Warning threshold of the cost-per-trial ratio                                                                  |
| `output.dir`                           | `.model-eval`     | Runs, swaps and comparisons                                                                                    |
| `redact`                               | `[]`              | `{pattern, replace}` regex replacements applied to everything written except raw trial records and grades      |

Warning thresholds compare point estimates and never change the exit code.

## Prices

```yaml
pricing:
  model-a: { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 }
  model-b: { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 }
```

Add every model the service calls, side calls included.

- With a cap, a variant model without a price ends the command with exit code 4. So does an
  unpriced model that first appears during a run.
- Without a cap, unpriced calls are charged at the most expensive known price per bucket and
  reported as `unpriced-model`.
- Without `cachedInput`, cache hits are charged at `input`.
- Give `cacheWrite` only for models that bill cache writes.

Pricing rules: [data-model §Cost](../../specs/001-swap-check/data-model.md#cost).

## Redaction

```yaml
redact:
  - { pattern: "\\b01[0-9]-?\\d{3,4}-?\\d{4}\\b", replace: '<phone>' }
```

- Patterns are JavaScript regular expressions with the `u` flag. A pattern that matches the empty
  string is rejected.
- `replace` must not be empty, so a reader can see that text was removed.
- Redaction applies to free text (model and service output, error and log messages, rule titles,
  anchor quotes, case notes) in reports, saved comparisons, stdout, stderr and logs.
- Identifiers, hashes and codes are written as they are.
- Everything else under `runs/` (`trials.jsonl`, grades, `manifest.json`) and `swaps/` is written
  unredacted. Trial records and grades keep the original text because checks must read it. Keep
  the output directory out of version control and public artifacts.
- `report` rewrites a saved comparison with the redaction it was saved under. A changed `redact`
  takes effect through `compare`.

## Rule and case files

| File       | Schema                                                         | Fields                                                                                                                                             |
| ---------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule files | [`schemas/rules.schema.json`](../../schemas/rules.schema.json) | [data-model §Rule](../../specs/001-swap-check/data-model.md#rule), [§Anchor](../../specs/001-swap-check/data-model.md#anchor), [checks](checks.md) |
| Case files | [`schemas/cases.schema.json`](../../schemas/cases.schema.json) | [data-model §Case](../../specs/001-swap-check/data-model.md#case)                                                                                  |

Rule, case and variant IDs match `^[a-z0-9][a-z0-9._-]{0,63}$`. See
[Writing rules and cases](../guide/rules.md).
