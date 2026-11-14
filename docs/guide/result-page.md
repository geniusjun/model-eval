# The result page

`compare`, `swap` and `report` write each comparison's result as a page next to `report.md`:

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

`report.html` shows everything `report.md` shows, with each cell's detail one click away and the
answers of both models side by side. `index.html` lists every comparison in the output directory,
newest first, and links to each one's page.

## Opening it

Open the file in a browser straight from disk. There is no server to start and nothing to
install: the page is one HTML file with its script, styles and the comparison data inside it. It
works offline, and it works when you send the file on its own as an attachment.

`index.html` links to the pages by relative path, so move or copy the output directory as a whole
if you want the list to keep working.

`model-eval report <comparisonId>` writes `report.md`, `report.html` and `index.html` again from
the saved `comparison.json`, for example after you update model-eval.

If the data in the file is not schema version 1 or does not validate, the page shows an error
screen that names the version it found, instead of a partial report.

## What it shows

From top to bottom:

1. Withheld banner: only when a compared run did not finish. The gate result is `undecided`
   and the banner says which run stopped and why.
2. Decision summary: the gate result with its reasons, then the worse, better and undecided
   cells, operational changes and the judged scope.
3. Cells: one table per output surface, a row per rule and a column per language. Each cell
   states its verdict in words as well as colour. Select a cell to open its detail: both
   compliance rates with an interval chart, the difference and its interval, the failure-rate
   ratio, the rate the service masked, failing examples with the raw answer and the shipped text,
   the prompt sentence the rule is anchored to and the rule's origin. Below the tables are the
   rates pooled across languages, for reference only, and the cells whose baseline compliance is
   below `report.lowBaseline`.
4. Side by side: for each `review` rule and each rule with failing examples, the baseline
   and candidate answers to the same case and repeat. Buttons move to the previous or next case
   and repeat.
5. Operational metrics and warnings, per variant: the eight rates with counts and intervals,
   systematic failures, discard reasons, the most common error messages, side-call failures,
   abandoned trials, finish reasons, the latency distribution with p50 and p95, tokens and cost
   per trial, response models and the post-processing figures. Then the comparison's warnings.
6. Judged scope: targets; judged, not judged, `review` and excluded rules; case coverage;
   baseline completion per language; every rule with its anchors and origin.
7. Reproduction: the comparison ID, both runs with their grade sets, variants and versions,
   the statistics settings, the settings used and the commands that reproduce the comparison.

[Reading the results](statistics.md) explains the verdicts, intervals and the gate.

The cells and the side-by-side view work from the keyboard. Tab reaches every cell, Enter opens
its detail and moves focus to the detail's heading, and Escape closes it and puts focus back on the
cell. The browser's Back button also closes it.

## Links to one view

The page keeps your place in the part of the URL after `#`, so you can send a link to a single
cell or answer next to the file:

| Hash                                | Opens                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| empty or `#/`                       | The decision summary                                       |
| `#/cell/<ruleId>/<lang>/<surface>`  | The cells, with that cell's detail open                    |
| `#/side/<ruleId>/<caseId>/<repeat>` | The side-by-side view of that rule at that case and repeat |

Each part is percent-encoded as `encodeURIComponent` encodes it, and repeats count from 0. For
example:

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
hash and overrides the language the page was written in:

```text
report.html#/cell/script-ja/ja/raw?lang=ko
```

Rule IDs, case IDs and model answers stay as written in either language.

Colours follow the system's light or dark setting. Verdict colours keep a contrast of at least
4.5:1 in both.

## What the page never does

The page sets a Content Security Policy that blocks every resource and connection from outside the
file and allows only its own script, and its links send no referrer. So the page:

- makes no network request, while it loads or while you use it;
- reads nothing but the data inside the file;
- never treats a model, service or provider string as markup. An answer that contains
  `</script>`, `<!--` or HTML tags shows exactly as written;
- keeps no state outside the URL hash: no cookies and no browser storage.

The embedded data is the comparison as `comparison.json` holds it, after the config's `redact`
rules. Raw trial records under `runs/` are not included. Each answer text is stored once and
failing examples are capped by `report.samples`. The page still carries model answers, so share
it as you would share `report.md`.
