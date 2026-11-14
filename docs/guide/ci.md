# Running in CI

Two jobs cover most setups: a lint job that runs on every change, including changes from people
without write access, and a swap job that calls models and runs only where API keys are allowed.

## Untrusted changes: `lint --no-adapter`

The adapter command comes from the config file, and every command that starts the adapter runs it.
Someone who can edit the config in a pull request can run any command next to your API keys. For
pull requests from forks, and any job whose config you have not reviewed, run only:

```bash
npx model-eval lint --no-adapter
```

It runs nothing from the config (only `git`, to check derived case files) and needs no secrets.
It still validates the config, rule and case files against their schemas, checks IDs and
references, and runs every rule's pass and fail examples through its check. It skips the checks
that need the adapter: case inputs against the target's input schema, unknown targets, anchors and
the helper version the adapter reports. Add `--max-warnings 0` to fail on the remaining warnings,
such as a `listed` rule that no case names. `--no-adapter` together with `--render` is a usage
error (exit 4).

## Trusted changes: lint, then swap

In a job that holds the keys and runs only on reviewed code:

```bash
npx model-eval lint --render --max-warnings 0
npx model-eval swap --from current --to next --json > swap.json
```

`lint --render` starts the adapter for every variant, renders every case and fails the job on a
missing anchor, so a prompt edit that drops a sentence a rule relies on is caught before any model
call. The keys are read by the adapter from the job's environment; do not put them in
`adapter.env`.

## Exit codes

The exit code is the result. Treat 0 as success and everything else as a failed step:

| Code | Name             | In CI                                                                               |
| ---- | ---------------- | ----------------------------------------------------------------------------------- |
| 0    | `ok`             | The gate is `pass` or `no-gate`; lint found no errors and warnings within the limit |
| 1    | `failed`         | The gate blocked; lint found errors or too many warnings                            |
| 2    | `undecided`      | Not a pass. Run again with the suggested `--repeats`, or add cases                  |
| 3    | `run-failed`     | Adapter or transient error limits, or an interrupt. The run is kept as `partial`    |
| 4    | `config-error`   | Files, prices, the adapter, credentials or the command line. Nothing is compared    |
| 5    | `over-budget`    | The cost cap. Before the start, no model was called                                 |
| 6    | `internal-error` | A bug in model-eval                                                                 |

Exit 2 is the one to think about. A run with too few trials to decide is not evidence that the
candidate holds, so a pipeline that treats 2 as success lets an untested swap through.

## Machine-readable output

With `--json`, stdout carries exactly one JSON document and nothing else; progress goes to stderr.
Every command uses the same envelope:

```json
{
  "schemaVersion": "1",
  "command": "swap",
  "exit": { "code": 1, "name": "failed" },
  "result": {
    "swapId": "20261111-095837-swap-56f6",
    "runs": ["20261111-095837-current-4fe8", "20261111-095837-next-6bdd"],
    "gate": {
      "outcome": "block",
      "reasons": [{ "code": "regressed", "ruleId": "script-ja", "lang": "ja", "surface": "raw" }],
      "blocking": [{ "ruleId": "script-ja", "lang": "ja", "surface": "raw" }],
      "undecided": [],
      "excluded": []
    }
  },
  "warnings": [
    {
      "code": "cost-ratio",
      "params": {
        "costPerTrialUsd": { "current": 0.00001473472222222222, "next": 0.00003226944444444444 },
        "ratio": 2.190027335281365,
        "threshold": 2
      },
      "variants": ["current", "next"]
    }
  ]
}
```

This is the Pogo swap with `result.comparison` left out for length; `result.gate` equals
`result.comparison.gate`. Each command's envelope follows `schemas/<command>.schema.json`, such
as [`schemas/swap.schema.json`](../../schemas/swap.schema.json). Findings carry codes and
params, never sentences, and the JSON does not change with `--lang`. `result` is `null` when the
command ends with exit code 4 or 6 before it has a result.

## Posting the report

`swap` and `compare` write `.model-eval/comparisons/<comparisonId>/report.md`, with the ID in
`result.comparison.comparisonId`. The report is meant to be posted as a pull request comment:
every model or service string in it sits in a code block, so mentions, links and HTML in model
output do not render. The result page `report.html` next to it is a single file that opens
without a network, so it can be attached as a build artifact on its own
([result page guide](result-page.md)).

## What to keep between jobs

Keep the output directory (`output.dir`, `.model-eval` by default) in a cache when you can:

- The cost estimate of the next run uses the previous run of the same variant instead of the
  first-run assumption.
- The result counts earlier comparisons of the same two variants.
- An interrupted run can be resumed.

Do not publish the whole directory as a public build artifact. The trial records and grades under
`runs/` hold raw answers and are not redacted, because checks must read the original text.
`comparisons/` (`comparison.json`, `report.md` and `report.html`), `index.html`, stdout, stderr and
logs go through the config's `redact` rules.

## Cost

`budget.maxCostUsd` caps the spend over both runs of a swap and defaults to 1 USD. Check the
estimate first:

```bash
npx model-eval swap --from current --to next --dry-run
```

It exits 5 without calling a model when the expected cost exceeds the cap. `--max-cost-usd <x>`
overrides the cap for one command, and `--max-cost-usd none` runs without one. A run that reaches
the cap stops as `partial` with exit code 5.

## Cancelled and failed jobs

A cancelled or killed job leaves the comparison `undecided`, never a pass. With the output
directory still there, resume the swap; only the cut trials are sent again:

```bash
npx model-eval swap --from current --to next --resume <swapId>
```

Each swap is recorded as `.model-eval/swaps/<swapId>.json`; `--json` output carries the ID as
`result.swapId`.

Resume keeps the first run's settings and refuses to continue when the service code changed in
between ([details](../../specs/001-swap-check/data-model.md#resume-and-locking)). After exit code 3
from transient errors or an outage, start a new run rather than resuming: resume does not resend
trials that already used their retries.

## Output

Colour is off with `--no-color` or the `NO_COLOR` environment variable. `--lang ko` prints human
output in Korean.
