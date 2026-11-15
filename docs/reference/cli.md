# CLI reference

```text
model-eval <command> [options]
```

The full contract is [contracts/cli.md](../../specs/001-swap-check/contracts/cli.md).

## Commands

| Command                                      | Calls models | Does                                                                                                               |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `model-eval init`                            | no           | Creates a config template, example rules and cases, and adds the output directory to `.gitignore`                  |
| `model-eval lint`                            | no           | Checks the config, rule and case files, references, rule examples, case inputs and the sample plan                 |
| `model-eval run --variant <id>`              | yes          | Runs every case with one variant, records the run and grades it                                                    |
| `model-eval grade <runId>`                   | no           | Re-grades stored trials with the current rules                                                                     |
| `model-eval compare <baseRunId> <candRunId>` | no           | Grades both runs with the current rules, compares cells, applies the gate and writes `report.md` and `report.html` |
| `model-eval swap --from <id> --to <id>`      | yes          | `run` for both variants, then `compare`, in one command                                                            |
| `model-eval report <comparisonId>`           | no           | Rewrites `report.md`, `report.html` and the output `index.html` from a saved comparison                            |

- `init` keeps files that already exist. With an existing config it only adds that config's
  `output.dir` to `.gitignore`.
- `init --adapter python` or `init --adapter node` also writes an adapter skeleton that uses the
  helper, next to the config, and sets `adapter.command` in a new config to start it. For Python
  it copies the helper file `model_eval_adapter.py` there too
  ([Writing an adapter](../guide/adapter.md#helpers)).
- `lint`, `run` and `swap` start the adapter; `lint --no-adapter` does not. Read
  [Running in CI](../guide/ci.md#untrusted-changes-lint---no-adapter) before running them on
  changes you have not reviewed.
- In a source checkout whose viewer is not built, `compare`, `swap` and `report` skip
  `report.html` and `index.html` and print a warning on stderr. The exit code does not change.

## Common options

| Option            | Meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `--config <path>` | Config file. Default `./model-eval.config.yaml`                       |
| `--json`          | Write exactly one JSON document to stdout; progress goes to stderr    |
| `--lang <en\|ko>` | Language of human output. Default from the config's `lang`, else `en` |
| `--verbose`       | Show adapter stderr and per-stage timings                             |
| `--no-color`      | Disable colour. `NO_COLOR` is honoured too                            |

Without a command, `--version` prints the version and `--help` (`-h`) prints the commands and
common options.

## `lint`

| Option               | Meaning                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--render`           | Render every case through the adapter for every variant and check anchors. The adapter must declare `render`                  |
| `--variant <id>`     | With `--render`, render only this variant                                                                                     |
| `--max-warnings <n>` | Exit 1 when warnings exceed n. Info findings do not count                                                                     |
| `--no-adapter`       | Do not start the adapter; skip input-schema, target, anchor and helper-version checks. A usage error (exit 4) with `--render` |

- Without `--render`, lint still starts the adapter with the first variant to read the targets'
  input schemas.
- When the adapter names the helper library it is built on, lint warns with `helper-outdated` if
  that helper is older than the one bundled with this release.
- All lint codes: [data-model §Validation Rules](../../specs/001-swap-check/data-model.md#validation-rules).

## `run` and `swap`

`run` takes `--variant <id>`. `swap` takes `--from <id>` (the baseline) and `--to <id>` (the
candidate). Both accept:

| Option               | Meaning                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repeats <n>`      | Repeats for this run; overrides `sampling.repeats`                                                                                                       |
| `--cases <glob>`     | Run only cases whose ID matches, case-sensitively (`*`, `?`, `[...]`, `{a,b}`)                                                                           |
| `--max-cost-usd <x>` | Override `budget.maxCostUsd` once; `none` runs without a cap                                                                                             |
| `--dry-run`          | Show calls, tokens, expected and conservative cost, the reservation per attempt and the planned trials per gated cell, then exit without calling a model |
| `--concurrency <n>`  | Concurrent requests per adapter process, at most the adapter's `maxConcurrency`                                                                          |
| `--resume <id>`      | Resume a stopped run (`runId` for `run`, `swapId` for `swap`)                                                                                            |

`--dry-run` on the Pogo example:

```text
Plan for current (model-a) → next (model-b)
  current  450 trials · 450 calls · 33605 input tokens · 115200 output tokens · reservation $0.000143 per attempt · basis en structure, ja structure, ko structure
  next     450 trials · 450 calls · 33605 input tokens · 115200 output tokens · reservation $0.000336 per attempt · basis en structure, ja structure, ko structure
  expected $0.199 · conservative $0.208 · cap $1

Gated cells
  completed  en  trial  150 planned trials per variant · n_min 35
  completed  ja  trial  150 planned trials per variant · n_min 35
  completed  ko  trial  150 planned trials per variant · n_min 35
  script-ko  ko  raw    150 planned trials per variant · n_min 35
  script-ja  ja  raw    150 planned trials per variant · n_min 35
```

`basis` is the source of each language's estimate: `structure` (the rendered prompt and the
`estimate` settings) on a first run, `history` once the variant has a previous run.

More detail: [data-model §Cost](../../specs/001-swap-check/data-model.md#cost) for estimates and
the cap, [data-model §Resume and Locking](../../specs/001-swap-check/data-model.md#resume-and-locking)
for what resume resends, keeps and refuses.

## Output files

Everything is written under `output.dir` (default `.model-eval`) next to the config file. Which
files are redacted: [Redaction](config.md#redaction).

| Path                                         | Contents                                                        |
| -------------------------------------------- | --------------------------------------------------------------- |
| `runs/<runId>/manifest.json`                 | Versions, variant, hashes, prices, segments and status of a run |
| `runs/<runId>/trials.jsonl`                  | One line per attempt, raw                                       |
| `runs/<runId>/grades/<gradeSetId>.jsonl`     | A grade set: the grades of one run under one set of rules       |
| `runs/<runId>/adapter.log`                   | The adapter's `log` notifications, redacted                     |
| `swaps/<swapId>.json`                        | The two runs of a swap                                          |
| `comparisons/<comparisonId>/comparison.json` | The comparison, redacted                                        |
| `comparisons/<comparisonId>/report.md`       | The Markdown report                                             |
| `comparisons/<comparisonId>/report.html`     | The result page, redacted ([guide](../guide/result-page.md))    |
| `index.html`                                 | The list of comparisons, each linking to its result page        |

Record schemas in [`schemas/`](../../schemas/): `manifest.schema.json`, `trial.schema.json` (one
line of `trials.jsonl`), `swap-record.schema.json` and `comparison.schema.json`. Grade lines are
described in [data-model §Grade and GradeSet](../../specs/001-swap-check/data-model.md#grade-and-gradeset).

## Exit codes

| Code | Name             | Meaning                                                                                                          |
| ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0    | `ok`             | Finished. `compare` and `swap`: the gate is `pass` or `no-gate`. `lint`: no errors and warnings within the limit |
| 1    | `failed`         | `compare` and `swap`: the gate is `block`. `lint`: errors, or warnings above the limit                           |
| 2    | `undecided`      | Nothing blocks, but the result cannot count as a pass                                                            |
| 3    | `run-failed`     | The run stopped on the adapter or transient error limits or an interrupt; it stays `partial`                     |
| 4    | `config-error`   | Files, prices, token estimate, adapter start or protocol, credentials, resume or command line                    |
| 5    | `over-budget`    | The expected cost exceeded the cap before the start, or the cap was reached during the run                       |
| 6    | `internal-error` | An unexpected internal error; report it as a bug                                                                 |

Codes and names change only with a major version. Every cause of exit code 4, and which code wins
when several apply: [contracts/cli.md §Exit Codes](../../specs/001-swap-check/contracts/cli.md#exit-codes).

## `--json`

Every command writes the same envelope: `schemaVersion`, `command`, `exit` (`code` and `name`),
`result` and `warnings`. `result` is `null` when the command ends with exit code 4 or 6 before it
has a result. Findings carry codes and params, never sentences, so the JSON does not change with
`--lang`.

- [`schemas/envelope.schema.json`](../../schemas/envelope.schema.json) describes the envelope of
  any command.
- Each command has its own schema named after it, such as
  [`schemas/swap.schema.json`](../../schemas/swap.schema.json).
- Field details:
  [contracts/cli.md §`--json` Output](../../specs/001-swap-check/contracts/cli.md#--json-output).

[Running in CI](../guide/ci.md#machine-readable-output) shows a full example.
