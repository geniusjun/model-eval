# Reading the results

A swap check answers one question per rule and language: does the candidate model keep this rule
at least about as well as the baseline? This page explains how the numbers in the output are made
and how the gate turns them into an exit code. The formulas are in
[data-model §Statistics](../../specs/001-swap-check/data-model.md#statistics) and the reasons
behind them in [research R3](../../specs/001-swap-check/research.md#r3-verdict-statistics).

## Cells

The unit of judgement is a cell: one rule, one language, one output surface.

- `raw` is the model's first answer.
- `final` is the text the service shipped after post-processing.
- `trial` is the whole trial, used only by `completed`.

Languages are never pooled for a verdict, because a model can break a rule in one language only.
The report shows pooled values per rule for reference, without a verdict.

## Compliance

A cell's compliance is the share of passing trials per case, averaged over cases, so each case
weighs the same however many of its trials were judged. Only cases that both runs share, with
identical content, are compared.

Intervals are Wilson score intervals, widened by a design effect when repeats of one case agree
with each other more than chance would explain. The difference between candidate and baseline has
its own interval:

```text
✗ script-ja  ja  raw  blocking  base 100.0%  cand 56.7%  diff -43.3pp [-51.3, -32.5]  margin 10pp  Regressed
```

The lower bound uses the configured confidence (`stats.confidence`, two-sided 95% by default). The
upper bound of a gated cell is corrected for the number of gated cells, so that more gated cells do
not mean more false blocks. In the Pogo example
there are 5 gated cells, so the gated `raw` cell above uses z = 2.576 for its upper bound, while
the ungated `final` cell of the same rule uses 1.96 on both sides:

```text
  script-ja          ja  final  blocking   100.0% → 56.7%  -43.3pp  [-51.3, -35.3]  Regressed
```

The lower bound is not corrected.

With fewer than 10 cases, the upper bound uses a Student t quantile with one degree of freedom
fewer than the number of cases, in place of the normal quantile, so that a few similar cases do not
block a candidate that is no worse. With 5 gated cells and 3 cases the quantile grows from 2.576 to
9.925, so such cells seldom block, even when a rule collapses. The lower bound, which decides
passing, keeps the normal quantile.

## Verdicts

Each cell gets one verdict. With margin m (the rule's `margin`, else `gate.margin`, else 0.10) and
the difference interval [L, U], the first matching row decides:

| Order | Condition                                              | Verdict          | Shown as        |
| ----- | ------------------------------------------------------ | ---------------- | --------------- |
| 1     | Neither run has a judged trial                         | `not-applicable` | Not applicable  |
| 2     | Fewer than 3 common cases                              | `insufficient`   | Too few samples |
| 3     | U < −m: the drop is larger than the margin             | `regressed`      | Regressed       |
| 4     | Fewer common cases than `stats.minCases`               | `insufficient`   | Too few samples |
| 5     | L > 0: the candidate is better                         | `improved`       | Better          |
| 6     | L > −m: any drop is within the margin                  | `non-inferior`   | Held            |
| 7     | Fewer trials per variant than the margin needs (n_min) | `insufficient`   | Too few samples |
| 8     | Otherwise                                              | `inconclusive`   | Inconclusive    |

`regressed` comes before the sample-size rows, so a cell with too few cases or trials to pass can
still block a collapse.
`inconclusive` and `insufficient` are both undecided; neither counts as passing.

n_min is the number of trials below which equal compliance can never pass: 73, 35 and 22 for
margins of 0.05, 0.10 and 0.15. Halving the margin roughly doubles n_min, and needs about four
times the trials to reach the same chance of a verdict. Lint and `--dry-run` warn with
`margin-unreachable` when a gated cell is planned below it.

A cell whose upper bound is below 0 has a confirmed drop whatever its verdict. Such cells are listed
under Worse in the decision summary with a note, such as "drop confirmed, within margin", so a drop
does not hide among held or undecided cells.

## The gate

The config's `gate.severities` names the severities to gate on. Gated cells are the cells of those
rules on the surface the rule's `gateOn` names, except cells of rules other than `completed` whose
baseline compliance is below `report.lowBaseline` (0.9 by default): the baseline does not hold such
a rule yet, so the report lists them separately and they never block. `review` rules are never
gated.

| Outcome     | When                                                                                                                  | Exit |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---- |
| `undecided` | A run is unfinished, a run has no judged trial, or the baseline completed fewer than half its trials in some language | 2    |
| `no-gate`   | `gate.severities` is empty or missing                                                                                 | 0    |
| `undecided` | No gated cell                                                                                                         | 2    |
| `block`     | A gated cell regressed                                                                                                | 1    |
| `undecided` | A gated cell is undecided, or a gated rule has no judged cell                                                         | 2    |
| `pass`      | Every gated cell held or got better                                                                                   | 0    |

Rows are checked from the top, so a half-finished or empty comparison is never a pass. `no-gate`
exits 0 because nothing can block, but it is shown apart from `pass` because nothing was judged. The full table, with
reason codes, is in [data-model §Gate](../../specs/001-swap-check/data-model.md#gate).

## When the result is undecided

Every undecided gated cell says what a new run needs. With one repeat instead of five, the Pogo
example gives:

```text
? completed  en  trial  blocking  base 100.0%  cand 100.0%  diff   0.0pp [-11.4, +18.1]  margin 10pp  Too few samples (30 trials per variant < 35)  a new run with 3 repeats gives this cell 90 trials per variant (now 30) and the whole run 270 trials per variant; about 80% chance of a verdict (estimate)
```

The suggested repeats aim at an 80% chance of a verdict if the observed rates are the true ones; it
is an estimate, not a promise. When the spread between cases is what keeps a cell undecided, more
repeats cannot help and the result asks for more cases instead.

Run again as a new run with the suggested `--repeats`. The new run is not pooled with the earlier
one. Rerunning until a pass appears raises the chance of a false pass with every try, so the output
says how many times the same pair of variants has been compared ("2nd comparison of these
variants").

## Operational metrics

Below the cells, the output compares rejections, time-outs, transient errors, discards,
fallbacks, empty answers, regenerations, latency and cost per trial. Rates come with intervals.
A metric whose point estimate passes its threshold in `report.warn` gets a warning:

```text
  cost per trial $0.0000147         $0.0000323 (×2.19)  warning: more than 2 times the baseline
```

Operational metrics never change the exit code. They tell you what the swap costs, not whether it
breaks a rule; the `completed` rule is where failures to answer can block.

For `raw` cells the report also shows the share masked by the service: trials that failed on the
raw answer and passed on the shipped text. A rise there means post-processing is hiding more of the
candidate's violations.

## Sample size

The defaults (30 cases per language, 5 repeats, margin 0.10, 95% confidence) are chosen so that,
per cell, an unchanged candidate passes about 94% of the time and a 30-point drop is caught about
97% of the time. Lint reports gated cells with fewer than 10 cases as `few-cases`: their upper bound
uses the t quantile above, so even a collapsed rule is often not blocked.
