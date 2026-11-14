# The result page

`compare`, `swap` and `report` write each comparison as a page, `report.html`, next to
`report.md`. Open it in a browser straight from disk. There is no server to start and nothing to
install: the page is one HTML file with its script, styles and the comparison data inside it. It
works offline and as a file sent on its own.

```text
.model-eval/
├── index.html
├── runs/
├── swaps/
└── comparisons/
    └── cmp-3370d141dbd9/
        ├── comparison.json
        ├── report.html
        └── report.md
```

- `report.html` shows everything `report.md` shows but its reproduction details, with each
  cell's detail one click away and the answers of both models side by side.
- `index.html` lists every comparison in the output directory, newest first, and links to each
  page by relative path. Move or copy the output directory as a whole to keep the links working.
- `model-eval report <comparisonId>` writes `report.md`, `report.html` and `index.html` again from
  the saved `comparison.json`, for example after you update model-eval.
- If the data in the file is not schema version 1 or does not validate, the page shows an error
  screen that names the version it found.

## What it shows

A bar at the top keeps the title, the gate result and the Language menu in view while you
scroll, with a button for each region below. A button moves to its region; the counts beside
Cells and Metrics are the cells that block the gate and the warnings. On a narrow screen the bar
stays at the top of the page instead of following you.

The page calls the two variants the baseline and the candidate; the title says which is which.

From top to bottom:

1. Withheld banner: only when a compared run did not finish. The gate result is `undecided`, and
   the banner says which run stopped and why.
2. Decision summary, in the order you would ask:
   - The gate result and one sentence that says why. The gate's reasons, blocking cells and
     counts open from the line under it.
   - Changed cells: a chart with a row per worse, better and undecided cell and per gated cell
     that held. Each row shows the difference in compliance with its interval against the cell's
     margin, both rates with their passes of trials, and what a new run needs when the data
     cannot tell yet. Rows that block the gate say so; a cell outside the gate is an outline.
     Select a cell's name to open its detail.
   - Failing answers of the candidate: up to two answers of the largest drop, with the text that
     broke the rule highlighted and a link to the same case side by side.
   - Cost, speed and errors, which are not part of the verdict: cost per 1,000 trials, latency
     and error rates of both variants, with the change as a ratio or a difference in points.
     ▲ marks a rise, ● a fall, and ■ a change past its warning level.
   - The judged scope on one line: judged and review rules, cases, languages, repeats and
     targets.
3. Cells: one table per output surface, a row per rule and a column per language. Each cell
   states its verdict in words and shape: ▲ regressed, ● better, = held, ◐ inconclusive, a
   dotted circle for too few samples and a slashed circle for not applicable. Only regressed
   cells are coloured, so the drops stand out, and a held cell shows = without the word. Select a cell to open its detail: both compliance
   rates with an interval chart, the difference and its interval, the failure-rate ratio, the
   rate fixed before shipping, failing examples (raw and shipped), the anchored prompt sentence
   and the rule's origin. Below the tables: rates pooled across languages, for reference only,
   and the cells whose baseline compliance is below `report.lowBaseline`.
4. Side by side: for each `review` rule and each rule with failing examples, the baseline and
   candidate answers to the same case and repeat. It opens on the first rule with a regressed
   cell; a failing answer says so and highlights its evidence. Buttons move to the previous or
   next case and repeat.
5. Operational metrics and warnings, per variant, none of which affect the verdict or the exit
   code: the warnings (a cost or latency warning as both values, the ratio and the warning
   level), the latency distribution from the fastest to the slowest trial (one line when the
   variants do not differ), then under "All metrics" the eight rates with counts and intervals,
   systematic failures, discard reasons, the most common error messages, side-call failures,
   abandoned trials, finish reasons, latency p50 and p95, tokens and cost per trial, response
   models and the post-processing figures.
6. Judged scope: targets; judged, not judged, `review` and excluded rules; case coverage;
   baseline completion per language; every rule with its anchors and origin. One sentence names
   the lists that are empty.

The page ends with the comparison ID and when it was written, in UTC. The runs, versions,
statistics settings, settings used and commands that reproduce the comparison are in
`report.md`.

Supporting detail starts closed, so the first screen shows what decides: the gate's reasons,
the pooled and low-baseline tables, all metrics, the post-processing figures and the rule list.
Select a line with an arrow, or press Enter on it, to open it.

[Reading the results](statistics.md) explains the verdicts, intervals and the gate.

The page works from the keyboard. Tab reaches every cell, Enter opens its detail and moves focus
to it, Escape or Back closes it and returns focus to the cell. Enter on a button of the top bar
moves focus to the heading of that region.

## Links to one view

The page keeps your place in the URL hash, so you can send a link to a single cell or answer
along with the file:

| Hash                                | Opens                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| empty or `#/`                       | The decision summary                                       |
| `#/cell/<ruleId>/<lang>/<surface>`  | The cells, with that cell's detail open                    |
| `#/side/<ruleId>/<caseId>/<repeat>` | The side-by-side view of that rule at that case and repeat |

Each part is encoded with `encodeURIComponent`, and repeats count from 0. For example:

```text
report.html#/cell/script-ja/ja/raw
report.html#/side/no-unprompted-self-state/mood-vague-ko/0
```

A hash that names a cell, rule, case or repeat the comparison does not have opens the decision
summary.

## Language and colours

The page starts in the language of the command that wrote it: `--lang`, else the config's `lang`,
else English. The Language menu switches between English and Korean and adds `?lang=en` or
`?lang=ko` to the hash, so a reload or a shared link keeps the choice. `?lang=` may follow any
hash and overrides the starting language:

```text
report.html#/cell/script-ja/ja/raw?lang=ko
```

Rule IDs, case IDs and model answers stay as written in either language.

Colours follow the system's light or dark setting.

## What the page never does

The page:

- makes no network request, while it loads or while you use it. A Content Security Policy blocks
  every outside resource and connection, and its links send no referrer;
- reads nothing but the data inside the file;
- never treats a model, service or provider string as markup. An answer that contains
  `</script>`, `<!--` or HTML tags shows exactly as written;
- keeps no state outside the URL hash: no cookies and no browser storage.

The embedded data is `comparison.json` after the config's `redact` rules. Raw trial records under
`runs/` are not included, and failing examples are capped by `report.samples`. The page still
carries model answers, so share it as you would share `report.md`.
