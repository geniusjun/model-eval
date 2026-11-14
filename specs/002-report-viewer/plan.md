# Implementation Plan: Result Page

**Branch**: `002-report-viewer` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-report-viewer/spec.md`

## Summary

A React app in `viewer/` is built with Vite into one HTML template that inlines its JavaScript and CSS. `compare`, `swap` and `report` (feature 001) put the redacted comparison into the template's data block ([contracts/page-data.md](contracts/page-data.md)) and write `report.html`; the output root gets `index.html`, the comparison list. The page validates the data once at start, keeps the reader's position in the URL hash, renders every untrusted string as a React text node, draws its two charts as hand-written SVG and blocks all network access with a Content Security Policy.

## Technical Context

**Language/Version**: TypeScript 5.x (`strict`, `noUncheckedIndexedAccess`), React 19

**Primary Dependencies**: React and ReactDOM, bundled into the template at build time. `zod` comes in through the comparison schema shared with feature 001 (D4). Build only: Vite and `vite-plugin-singlefile`

**Storage**: None. The data is inside the file; reader state lives in the URL hash

**Testing**: vitest with Testing Library (jsdom) for utilities and components, Playwright against the built `report.html` over `file://`

**Target Platform**: Current Chromium, Firefox and Safari, opened from disk

**Project Type**: Single-page app compiled into a template shipped inside the npm package (`dist/viewer/report.html`)

**Performance Goals**: Decision summary visible within 2 s; example page at most 1 MB

**Constraints**: `file://` only: no server, no network, no dynamic imports or extra chunks

**Scale/Scope**: Five regions (decision summary, grid with the cell detail, side by side, operational metrics, scope) and a footer, plus the list page; together they show everything `report.md` shows but its reproduction details (FR-016)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Grade What the Service Actually Ships | PASS | Shows raw and final separately, with the masked rate |
| II. No Conclusion From a Single Sample | PASS | Every rate is shown with its interval; undecided cells are never shown as passes; partial comparisons carry the withheld banner |
| III. Deterministic Checks First | PASS | `review` rules are shown as samples for people, not as rates |
| IV. People Set Policy, the Tool Shows Evidence | PASS | The page shows evidence and the gate outcome; it decides nothing |
| V. Real User Data Stays Out of the Repository | PASS | Only redacted comparison data is embedded; the pages CI keeps come from the synthetic example |
| VI. Same Records, Same Conclusion | PASS | The page is a pure function of the comparison JSON |
| VII. Know the Cost Before Starting, Stay Under the Cap | PASS | Cost per trial and its ratio are in the summary and the metrics |
| VIII. Humans and Agents Read the Same Result | PASS | Reads the same comparison JSON that `--json` returns |
| IX. Every Requirement Has a Test | PASS | Component and Playwright tests named `002 FR-###` |
| X. Stay Small | PASS | No runtime dependency added to the package; React is bundled into the template |

Re-checked after Phase 1 design (contracts): no change.

## Project Structure

### Documentation (this feature)

```text
specs/002-report-viewer/
├── spec.md
├── plan.md              # This file
├── research.md          # R1–R4
├── quickstart.md
├── contracts/
│   └── page-data.md     # Embedded payloads, escaping, location hash
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks), not created by /speckit.plan
```

### Source Code (repository root)

```text
viewer/
├── index.html                    # template with the data placeholder and CSP meta
├── vite.config.ts                # single-file build, CSP hash step
└── src/
    ├── main.tsx                  # read and validate the embedded data, render <App> or <InvalidReport>
    ├── App.tsx                   # picks the page from the hash
    ├── pages/
    │   ├── ReportPage.tsx        # lays out the regions and passes data slices down
    │   └── ComparisonListPage.tsx
    ├── domains/
    │   ├── summary/              # DecisionSummary, WithheldBanner
    │   ├── grid/                 # RuleLanguageGrid, GridCell, CellDetail, PooledRates, LowBaselineCells, useSelectedCell, buildGrid
    │   ├── side-by-side/         # SideBySide, useSampleCursor
    │   ├── metrics/              # MetricsTable, LatencyChart, PostprocessPanel, WarningList
    │   └── scope/                # ScopePanel, RuleList
    ├── report/                   # readEmbeddedReport.ts, uses the shared schema from src/report/schema.ts
    ├── components/               # shared pieces: IntervalBar, VerdictBadge, CodeText
    ├── hooks/                    # useHashParam.ts
    ├── i18n/                     # en.json, ko.json (interface strings), useMessages.ts
    ├── utils/                    # format.ts (percent, points, currency)
    └── styles/                   # tokens.css (colour schemes), global.css
test/browser/                     # Playwright specs against dist/viewer and fixtures
```

**Structure Decision**: The app is laid out by domain (research R2): shared `components/`, `hooks/` and `utils/` at the top of `src`, and one folder per domain under `src/domains/` with its own components, hooks and utilities. A domain never imports from another domain; pages compose them and `report/` is the only shared data module. Deleting a region means deleting one folder, and cross-domain imports stand out in review.

## Design Decisions

### D1. One HTML file with the data inside

The build inlines all JavaScript and CSS into `dist/viewer/report.html`. Feature 001 fills the template's data block with the redacted comparison ([contracts/page-data.md](contracts/page-data.md)). The file opens from disk, attaches to a pull request or a message, and the data never leaves the machine (research R1). The output's `index.html` uses the same template with the list payload.

### D2. Code is written to be easy to change

Readability, predictability, cohesion and coupling (research R2):

- Name conditions and thresholds (`isConfirmedDrop`, `MAX_FAILING_EXAMPLES`), avoid nested ternaries, and keep code that does not run together in separate components.
- Functions of one kind return one shape; the data reader returns `{ok: true, comparison} | {ok: false, error}` instead of throwing.
- One hook per responsibility (`useSelectedCell`, `useSampleCursor`, `useHashParam`).
- Props come from the page; composition before Context, and no global store.
- Components are `export function PascalCase`, hooks `useX`, handler props `onSelectCell` with local `handleSelectCell`. No barrel `index.ts` files.

### D3. Reader state lives in the URL hash

The location hash keeps the reader's place ([page-data §Location Hash](contracts/page-data.md#location-hash)), so a link to a cell can be pasted next to the file. The hash is read with `useSyncExternalStore` on `hashchange` and written through `location.hash`. `history.pushState` is avoided because `file://` pages have an opaque origin and browsers reject some URL updates there.

Local `useState` covers everything else. No router library.

### D4. The data is validated once, with the schema feature 001 writes

`src/report/schema.ts` defines the comparison with zod; feature 001 uses it to write the JSON and the viewer imports the same module to validate it before the first render. One schema keeps writer and reader from drifting, the way files changed together should live together. An unsupported `schemaVersion` or a failed validation renders `<InvalidReport>` with the found version (FR-012). No Suspense, since there is no asynchronous data; one root error boundary catches rendering bugs.

### D5. Model output is untrusted text

1. The data block is escaped and inserted as [page-data §Embedded Block](contracts/page-data.md#embedded-block) defines, so `</script>`, `<!--` or `$&` in the data can neither end the block nor alter it.
2. The page validates the data once before the first render (D4).
3. Text enters the page only as React text nodes. `dangerouslySetInnerHTML` is banned by lint (`react-dom/no-dangerously-set-innerhtml` of `eslint-plugin-react-dom`).
4. The build has no dynamic import and no extra chunk, because `file://` cannot load them.
5. `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src data:">` blocks every outside request. The script hash is computed at build time, so the page itself guarantees that data stays on the machine.

Tests use a fixture whose texts contain `</script>`, `<!--`, `$&` and HTML tags to check 1 and 3 (SC-004).

### D6. Hand-drawn SVG charts

- Interval bars for rates and differences in the cell detail and the metrics.
- A latency distribution: 20 equal-width bins from the smaller of the two variants' fastest latency to the larger of their slowest, with both ends written under the chart; a bin's height is the share of that variant's values in it, on a height scale shared by both variants, and only non-empty bins get a mark.
- The difference in the cell detail, drawn as a row of the change chart on its own scale.
- The change chart of the decision summary: one row per charted cell in a real `<table>`, each with a difference chart on one scale shared by every row, which runs in round steps from below the lowest interval or −margin to above 0. A row draws the interval (red for regressed, green for better, grey otherwise), the estimate, the zero line and a dashed line at −margin; the table cell draws the zero and margin lines as its background over the full height of the row, so down the table they read as one line, and the chart then leaves them out. Axis labels are HTML text in the column head. On a narrow screen each cell takes two rows, its name and figures with the difference at the right edge, then its chart across the full width under an axis of the same width; the chart column stays in the table with no width.
- The operational changes of the decision summary: the baseline and candidate values as two dots on one line from 0, grey then teal.

Each SVG has `role="img"` and a `<title>` that states its values in words, and the same values are text beside it. A chart library would grow the bundle for a few shapes.

### D7. Accessible by structure

The grid is a real `<table>` with a `<button>` per cell that opens its detail; verdicts are text plus colour; focus returns to the cell when the detail closes. Lint is the first line: `eslint-plugin-jsx-a11y-x` runs with `control-has-associated-label` turned on, so lint rejects any button without a text label or `aria-label`. The guarantee is an axe check (`@axe-core/playwright`) in the browser tests, which finds no violation on the rendered pages, so accessibility does not rest on one lint plugin.

### D8. English and Korean messages in files

The page renders the codes of the comparison (cell notes, `needed`, warnings, gate reasons) with the message files of feature 001, `src/messages/en.json` and `ko.json`, bundled into the template like `src/report/schema.ts` (D4), so the command line and the page give a code the same text. `viewer/src/i18n/en.json` and `ko.json` hold only the page's own interface strings. Both sets are embedded. The page starts in the language of the command (`lang` in the payload, [contracts/page-data.md](contracts/page-data.md#payloads)) and offers a switch. Adding a language adds a file to each set and touches no component.

### D9. Styling with CSS Modules and tokens

CSS Modules for components and CSS custom properties in `styles/tokens.css` for colours, spacing and type, with a dark scheme under `prefers-color-scheme`. Both are built into Vite and inline into the single file without a runtime.

### D10. Tests

- vitest for pure utilities (`buildGrid`, formatting, hash parsing).
- vitest with Testing Library for components, queried by role (`getByRole('button', {name: …})`) so tests follow what assistive technology sees.
- Playwright opens the built `report.html` over `file://` for SC-001, SC-002 and SC-004, records network requests and drives the grid by keyboard. This is the only test that proves the single-file build works.
- `@axe-core/playwright` runs axe on the rendered pages in those browser tests (WCAG 2.1 A and AA and best-practice rules); it is the accessibility guarantee of D7.

### D11. Example pages in CI

Comparisons are test results; the tool never publishes them to a website, and neither does this repository. CI runs the `examples/pogo` swap on every push and pull request and keeps `index.html` and each `comparisons/<comparisonId>/report.html` as a build artifact of the run for 14 days, so a reviewer can download and open the page of that exact commit. Nothing else from the output directory is kept (constitution V). Fourteen days covers a review cycle, and every run builds the pages again, so older copies have no use.

### D12. Visual system

The page reads as one calm column in which only change draws the eye. The first screen ends with a handful of large numbers; supporting detail starts closed.

- **Decision summary.** It answers, in order, the questions a reader asks, which is the order of 001 FR-028. Should we switch: the gate outcome in large type and one sentence built from the comparison alone (which cell blocks, how far it fell and its margin; that nothing gated got worse; or why there is no result yet), with the gate's reasons, blocking cells and counts one click away. What changed and how sure is it: the change chart (D6) of the worse, better and undecided cells in that order, the largest drop first within each, and of the gated cells that held; each row names its cell as a link to its detail, marks it `blocking` when it is in `gate.blocking`, and states the verdict, both rates, each with its passes of trials in smaller muted figures (`99.3% (149/150) → 70.0% (105/150)`), the failure-rate ratio named as failures (or that the baseline had none), the note and what a new run needs, the difference and its interval. A cell outside the gate is drawn as an outline. A cell with a confirmed drop that is still undecided is charted once, among the worse. A note every row of a group shares is said once in the group's head. Groups without a cell share one quiet line, held cells fold into a button from three on, and a line under the chart says what the bars, the solid line and the dashed line mean. What did the candidate write: up to two failing answers of the largest drop that has failing examples, quoted with each piece of evidence marked where it occurs (`<mark>` in the regressed colours, touching evidence as one mark, with a note for assistive technology; evidence that does not occur is listed), and a link to the same case side by side. What does it cost, marked as not part of the verdict: cost per 1,000 trials (the same ratio as cost per trial, in amounts a reader can compare), latency p50 and p95, and every error rate the summary lists or either variant has, as dots on one line (D6) with the change as a ratio or a difference in points, set smaller than the cells' differences; all are better lower, so a rise carries the red triangle and a fall the green circle, a change past its warning level names that level (`past the warning level ×2.00`) with the warning square, and a measure that did not move says so in place of its dots. What does it rest on: judged rules plus review rules, common cases, languages, repeats and targets on one line.
- **Closed by default.** Supporting detail sits in `<details>` that start closed and open by mouse or keyboard: the gate's reasons and counts, the pooled rates and low-baseline cells, the full metrics table with the top messages, side-call failures and response models, the post-processing figures and the rule list. Region headings stay in view, and closed content stays in the document, so FR-016 holds and the hash views work as before.
- **Side by side.** With no position in the hash, the first position of the first rule with a regressed cell shows, without changing the hash or taking focus; choosing a rule opens it through the hash as before. A column whose answer is a failing example says so with its evidence before the answer and marks the evidence in it. When the service shipped the raw answer unchanged, one box says so; finish reasons and final kinds read as words. A move that is not available is dashed and faint.
- **Words.** One word per idea, the same as the codes' texts of feature 001: the variants are the baseline and the candidate, and their IDs appear in the title and the cost legend; the page's Korean says 나빠짐, 마진, 폐기, 시도 and 검토 규칙, and the Korean verdict texts of feature 001 say 나빠짐 as well. The ratio warnings of feature 001 state the warning level as a ratio (`past the warning level of 2.00×`, `경고 기준 2.00배를 넘습니다`), with no particle after a number. Section headings are nouns, and a sentence that only repeats a heading is left out.
- **Latency.** When p50 and p95 are each within 5% between the variants, one line says there is no latency difference and the distribution opens from a disclosure; otherwise it shows, each row with its p50 and p95.
- **Metrics.** One line under the region's heading says that none of its figures affect the verdict or the exit code. A cost or latency warning reads as the decision summary writes the change: the measure, both values, the ratio and the warning level (`Cost per 1,000 trials: $0.0147 → $0.0323, ×2.19, past the warning level ×2.00`). Other warnings take the text of feature 001 after the rule, language and case IDs they name, and a variant only when the warning names one, by its role.
- **Scope.** The scope region lists what is there: the judged rules, the review rules and each list that is not empty get a row; one sentence under the rows names the empty lists, with cases only in the baseline and only in the candidate as cases on one side only when both are empty, and a completion of 100% in every language is one line.
- **Reproduction.** The page ends with a footer that names the comparison and when it was written, in UTC to the minute (`2026-11-14 16:47 UTC`) with the ISO time as the `datetime` of a `<time>`. The runs, versions, statistics settings, settings used and commands stay in `report.md` (FR-007, FR-016).
- **Layout.** One column, at most 72rem wide, in the order of research R1. Regions are separated by space, a hairline and their `h2`, not by boxes. Inside a region, CSS grid sets parts side by side on a wide screen (the two failing answers of the summary, and the two variants of the side-by-side view and of post-processing) without changing the DOM order. The grid tables of all surfaces have the same columns: the rule column, then one column per language of the comparison in one order (T026), each of the same width, so a column position names the same language in every table; a language a surface has no cell in is a column of empty positions. Below 48rem everything stacks, and the grid scrolls sideways inside its region, never the page, with the rule column fixed and a focused cell kept clear of it.
- **Top bar.** A `<header>` holds the `h1`, the gate outcome (a copy of the summary's, hidden from assistive technology) and the language switch, then a `<nav>` with a button per region. A button scrolls its region into view and focuses the region's `h2` (`tabIndex=-1`); it never touches the hash (D3). The button of the region in view carries `aria-current`, set from an `IntersectionObserver`. The grid's button shows the number of blocking cells and the metrics' button the number of warnings, as a shape and a number with the same count in words for assistive technology. The buttons wrap onto more lines rather than scroll, and on a phone they are small enough to stay on one; there the language menu keeps its label for assistive technology only. The bar is sticky from 48rem up, and `scroll-padding-top` keeps scrolled-to regions and focused elements clear of it; a `ResizeObserver` writes the bar's rendered height into that padding, so a title that wraps is covered too.
- **Verdicts.** A verdict is its word with a shape: a triangle for regressed, a circle for better, an equals sign for held, a half circle for inconclusive, a dotted circle for too few samples and a slashed circle for not applicable; a square marks a warning. Shapes are inline SVG, `aria-hidden`, in the text colour of their badge. In the grid only a regressed cell is coloured, tinted with a bar on its left and the candidate's rate set large; every other cell is one line of text that wraps between words: its rate, its passes of trials and its verdict as a small muted word with its shape, like a heat map that colours drops only. A held cell, the common case, shows the equals sign alone and keeps its word for assistive technology, so the key names the sign. A position without a cell stays empty. A line under the key says what the surfaces are. A cell whose two rates print the same shows the rate once. On a phone the rule column narrows and a shadow on the right edge shows that more columns scroll. The cell detail opens in place under its table with the verdict's colour on its left edge; its rates carry their passes of trials, its difference is drawn as the change chart draws it, and a ratio it cannot compute says why.
- **Tokens.** `styles/tokens.css` names colours by role: one neutral scale (background, surface, two border strengths, three text strengths), one blue accent for links, focus, selection and the current section, a teal for the candidate in charts so blue keeps one meaning, and status colours used only for shapes, lines, fills and badges, never for numbers or sentences. Every colour is opaque. Text reaches 4.5:1 on the surface it sits on, each verdict's text and background reach 4.5:1, and chart marks, the chart axis and status shapes reach 3:1 against what they sit on, in both schemes. The dark scheme picks its own steps rather than inverting the light ones. Korean text breaks between words (`word-break: keep-all`), and a long ID still breaks where it must. Type is the system stack in eight sizes: 12, 13, 14, 15 and 18px for labels, code, tables, text and titles, 20px for a moved cell's rate and a regressed difference, 28px for the cost ratio and 44px for the gate outcome, with tabular figures in tables and lists of numbers. A row of the metrics table that is 0 for both variants is drawn in the muted text colour and stays in the table.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Page grows past the budget on real runs | Slow to open, hard to attach | Each text stored once per key, failing examples capped by `report.samples`; the 1 MB budget is checked on the example in CI |
| Scope grows (decision recording, labelling) | Delays the P1 regions | Only the five regions and the list page are in this feature |
| A browser restricts `file://` behaviour | Navigation or scripts break when opened from disk | Hash-only state, no chunks, CSP hash; Playwright runs on `file://` in Chromium, Firefox and WebKit |
| The comparison schema changes in feature 001 | The page shows wrong values | The shared zod schema and the committed comparison fixture are used by both features' tests |
