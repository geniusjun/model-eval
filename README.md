# model-eval

model-eval checks whether an LLM service's prompt rules and post-processing still hold when the
service moves to another model. It runs your service's own prompt assembly, model call and
post-processing with the current model and the candidate, grades every answer against rules you
write, and compares compliance per rule and language with confidence intervals. The exit code says
whether the swap passes, blocks or needs more data, so it can run in CI.

It does not score answer quality. It answers narrower questions: do Japanese answers still use
only Japanese script, does the model still avoid what the prompt forbids, does it still finish its
answers, and what does the candidate cost per trial.

## Install

Node.js 22.17 or later.

```bash
npm i -D model-eval
# or
pnpm add -D model-eval
```

To run from a clone:

```bash
pnpm install && pnpm build
node dist/cli.js --version
```

## Example

[`examples/pogo`](examples/pogo) is a synthetic chat service with an adapter that stands in for
the model, so it runs without API keys and gives the same result every time. Its candidate model
mixes a Korean word into some Japanese answers.

```bash
cd examples/pogo
model-eval lint --render
model-eval swap --from current --to next --dry-run
model-eval swap --from current --to next
```

From a clone, use `node ../../dist/cli.js` in place of `model-eval`.

`lint --render` asks the adapter for the prompt of every case and finds one rule whose sentence the
English prompt does not contain. Its first and last lines, with the case list shortened:

```text
warning: rules/pogo.yaml:40:9: no-emoji (en): The rendered prompt does not contain "Never use emoji". (variants: current, next · cases: greet-en, mood-vague-en, rain-en, …)
errors 0 · warnings 1 · info 13
```

`swap` runs 90 cases in three languages, 5 times each, with both models, then compares them:

```text
model-eval swap  current (model-a) → next (model-b)   90 cases (en, ja, ko × 30) · 5 repeats · 900 trials · $0.0212 (expected $0.199 · conservative $0.208)
swap 20261111-111120-swap-f940 · 1st comparison of these variants

Decision summary
  Worse        script-ja (ja, raw) 100.0% → 56.7%
               script-ja (ja, final) 100.0% → 56.7%
  Better       none
  Undecided    none
  Operations   cost per trial ×2.19
  Scope        targets chat · rules judged 7 of 8 · review rules 1 (side by side in samples.review of .model-eval/comparisons/cmp-3370d141dbd9/comparison.json)

Gate, 5 cells: 1 blocked · 0 undecided · 4 held   → BLOCK

✗ script-ja  ja  raw  blocking  base 100.0%  cand 56.7%  diff -43.3pp [-51.3, -32.5]  margin 10pp  Regressed
  4 more gated cells held
```

The output goes on with the ungated cells, operational metrics and the path of the Markdown
report, `.model-eval/comparisons/cmp-3370d141dbd9/report.md`, which lists failing answers and the
prompt sentence the rule relies on. The command exits 1. Its `--json` output carries the same
result for scripts.

## How it works

- An adapter, a small program in any language, runs the service's turn function for one model and
  reports the raw answer, the shipped text, token usage and failures over
  [a JSON-RPC protocol on stdio](specs/001-swap-check/contracts/adapter-protocol.md).
- Rules are YAML: a check (script, emoji, pattern, phrases, overlap, length, JSON, completion), a
  severity and optionally the prompt sentence it relies on. Cases are YAML inputs to the service.
- `swap` runs both variants, grades every rule on the raw answer and on the shipped text, and
  judges each rule × language × surface cell against a non-inferiority margin.
- The gate blocks when a gated cell regressed beyond its margin. Too few trials to decide is
  `undecided`, never a pass.
- A cost cap (1 USD by default) holds over both runs, and `--dry-run` shows the estimate first.

## Commands

| Command                                      | Calls models | Does                                                                                              |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `model-eval init`                            | no           | Creates a config template, example rules and cases                                                |
| `model-eval lint`                            | no           | Checks files, references, rule examples, case inputs and the sample plan; anchors with `--render` |
| `model-eval run --variant <id>`              | yes          | Runs every case with one variant                                                                  |
| `model-eval grade <runId>`                   | no           | Re-grades a stored run with the current rules                                                     |
| `model-eval compare <baseRunId> <candRunId>` | no           | Compares two runs, applies the gate and writes the report                                         |
| `model-eval swap --from <id> --to <id>`      | yes          | `run` for both variants, then `compare`                                                           |
| `model-eval report <comparisonId>`           | no           | Rewrites the report from a saved comparison                                                       |

`lint`, `run` and `swap` start the adapter command from the config file. Do not run them on
untrusted pull requests in a job that holds API keys; use `lint --no-adapter` there.

## Exit codes

| Code | Name             | Meaning                                                                                                          |
| ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0    | `ok`             | Finished. `compare` and `swap`: the gate is `pass` or `no-gate`. `lint`: no errors and warnings within the limit |
| 1    | `failed`         | `compare` and `swap`: the gate is `block`. `lint`: errors, or warnings above the limit                           |
| 2    | `undecided`      | Nothing blocks, but the result cannot count as a pass                                                            |
| 3    | `run-failed`     | The run stopped on the adapter or transient error limits or an interrupt                                         |
| 4    | `config-error`   | Files, prices, the adapter, credentials, resume or the command line                                              |
| 5    | `over-budget`    | The cost cap                                                                                                     |
| 6    | `internal-error` | A bug in model-eval                                                                                              |

## Documentation

Guides:

- [Writing an adapter](docs/guide/adapter.md)
- [Writing rules and cases](docs/guide/rules.md)
- [Reading the results](docs/guide/statistics.md)
- [The result page](docs/guide/result-page.md)
- [Running in CI](docs/guide/ci.md)

Reference:

- [CLI](docs/reference/cli.md)
- [Config](docs/reference/config.md)
- [Checks](docs/reference/checks.md)
- [JSON Schemas](schemas) for the config, rule and case files, the adapter protocol, the `--json`
  output of every command and the records under the output directory

Specification: [spec](specs/001-swap-check/spec.md),
[data model](specs/001-swap-check/data-model.md),
[CLI contract](specs/001-swap-check/contracts/cli.md),
[config contract](specs/001-swap-check/contracts/config.md),
[adapter protocol](specs/001-swap-check/contracts/adapter-protocol.md).

The package also exports the functions the CLI is built on (loading the config, lint, runs, the
swap check, re-grading, comparing and the report writers); see [`src/index.ts`](src/index.ts).
