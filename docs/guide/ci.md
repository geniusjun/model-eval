# Running in CI

Set up two jobs:

1. A lint job that runs on every change, including changes from people without write access. It
   calls no model and needs no secrets.
2. A swap job that calls models. Run it only on reviewed code, in a job that holds the API keys.

## Untrusted changes: `lint --no-adapter`

The adapter command comes from the config file, and every command that starts the adapter runs
it. Someone who can edit the config in a pull request can run any command next to your API keys.
For pull requests from forks, and any job whose config you have not reviewed, run only:

```bash
npx model-eval lint --no-adapter
```

It runs nothing from the config (only `git`, to check derived case files), needs no secrets and
skips the checks that need the adapter ([`lint` options](../reference/cli.md#lint)).

- Add `--max-warnings 0` to fail on the remaining warnings, such as a `listed` rule that no case
  names.
- Do not combine it with `--render`: that is a usage error (exit 4).

## Trusted changes: lint, then swap

In a job that holds the keys and runs only on reviewed code:

```bash
npx model-eval lint --render --max-warnings 0
npx model-eval swap --from current --to next --json > swap.json
```

With `--max-warnings 0`, `lint --render` fails the job on a missing anchor before any model is
called, so a prompt edit that drops a sentence a rule relies on is caught early. The adapter reads
the keys from the job's environment; do not put them in `adapter.env`.

## Exit codes

The exit code is the result. Treat 0 as success and everything else as a failed step. The codes
are listed in the [CLI reference](../reference/cli.md#exit-codes).

Do not treat exit 2 (`undecided`) as success. Too few trials to decide is not evidence that the
candidate holds. Run again with the suggested `--repeats`, or add cases; see
[When the result is undecided](statistics.md#when-the-result-is-undecided).

## Machine-readable output

With `--json`, stdout carries one JSON document and nothing else. This is the Pogo swap, with
`result.comparison` left out for length:

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

`result.gate` equals `result.comparison.gate`. Envelope and schemas:
[CLI reference](../reference/cli.md#--json).

## Posting the report

`swap` and `compare` write `.model-eval/comparisons/<comparisonId>/report.md`. The ID is in
`result.comparison.comparisonId`.

- Post `report.md` as a pull request comment. Every model or service string in it sits in a code
  block, so mentions, links and HTML in model output do not render.
- Attach `report.html`, next to it, as a build artifact. It is a single file that opens without a
  network ([result page guide](result-page.md)).

## What to keep between jobs

Keep the output directory (`output.dir`, `.model-eval` by default) in a cache when you can:

- The cost estimate of the next run uses the previous run of the same variant instead of the
  first-run assumption.
- The result counts earlier comparisons of the same two variants.
- An interrupted run can be resumed.

Do not publish the whole directory as a public build artifact. Reports, saved comparisons,
`index.html`, `adapter.log` and terminal output go through the config's `redact` rules; the rest
of `runs/` and `swaps/` does not ([redaction](../reference/config.md#redaction)).

## Cost

`budget.maxCostUsd` caps the spend over both runs of a swap and defaults to 1 USD. Check the
estimate first:

```bash
npx model-eval swap --from current --to next --dry-run
```

- The dry run exits 5 without calling a model when the expected cost exceeds the cap.
- `--max-cost-usd <x>` overrides the cap for one command; `--max-cost-usd none` runs without one.
- A run that reaches the cap stops as `partial` with exit code 5.

## Cancelled and failed jobs

A cancelled or killed job leaves the comparison `undecided`, never a pass. If the output directory
is still there, resume the swap. Only the cut trials are sent again:

```bash
npx model-eval swap --from current --to next --resume <swapId>
```

The swap ID is in `result.swapId` of the `--json` output and in the file name
`.model-eval/swaps/<swapId>.json`.

- Resume keeps the first run's settings.
- It refuses to continue when the service code changed in between
  ([details](../../specs/001-swap-check/data-model.md#resume-and-locking)).
- After exit code 3 from transient errors or an outage, start a new run instead. Resume does not
  resend trials that already used their retries.
