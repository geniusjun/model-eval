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

**Scale/Scope**: Six regions (decision summary, grid, cell detail, side by side, operational metrics, scope and reproduction) plus the list page

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Grade What the Service Actually Ships | PASS | Shows raw and final separately, with the masked rate |
| II. No Conclusion From a Single Sample | PASS | Every rate is shown with its interval; undecided cells are never shown as passes; partial comparisons carry the withheld banner |
| III. Deterministic Checks First | PASS | `review` rules are shown as samples for people, not as rates |
| IV. People Set Policy, the Tool Shows Evidence | PASS | The page shows evidence and the gate outcome; it decides nothing |
| V. Real User Data Stays Out of the Repository | PASS | Only redacted comparison data is embedded; the public demo uses the synthetic example |
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
    │   ├── grid/                 # RuleLanguageGrid, GridCell, CellDetail, useSelectedCell, buildGrid
    │   ├── side-by-side/         # SideBySide, useSampleCursor
    │   ├── metrics/              # MetricsTable, LatencyChart
    │   └── scope/                # ScopePanel, ReproductionPanel
    ├── report/                   # readEmbeddedReport.ts, uses the shared schema from src/report/schema.ts
    ├── components/               # shared pieces: IntervalBar, VerdictBadge, CodeText
    ├── hooks/                    # useHashParam.ts
    ├── i18n/                     # en.json, ko.json, useMessages.ts
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
3. Text enters the page only as React text nodes. `dangerouslySetInnerHTML` is banned by lint (`react/no-danger`).
4. The build has no dynamic import and no extra chunk, because `file://` cannot load them.
5. `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src data:">` blocks every outside request. The script hash is computed at build time, so the page itself guarantees that data stays on the machine.

Tests use a fixture whose texts contain `</script>`, `<!--`, `$&` and HTML tags to check 1 and 3 (SC-004).

### D6. Two hand-drawn SVG charts

Interval bars for rates and differences, and a latency distribution. Each SVG has `role="img"` and a `<title>`. A chart library would grow the bundle for two shapes.

### D7. Accessible by structure

The grid is a real `<table>` with a `<button>` per cell that opens its detail; verdicts are text plus colour; focus returns to the cell when the detail closes. `eslint-plugin-jsx-a11y` runs with `control-has-associated-label` turned on, so lint rejects any button without a text label or `aria-label`.

### D8. English and Korean messages in files

All page strings live in `viewer/src/i18n/en.json` and `ko.json`, both embedded. The page starts in the language of the command (`lang` in the payload, [contracts/page-data.md](contracts/page-data.md#payloads)) and offers a switch. Adding a language adds a file and touches no component.

### D9. Styling with CSS Modules and tokens

CSS Modules for components and CSS custom properties in `styles/tokens.css` for colours, spacing and type, with a dark scheme under `prefers-color-scheme`. Both are built into Vite and inline into the single file without a runtime.

### D10. Tests

- vitest for pure utilities (`buildGrid`, formatting, hash parsing).
- vitest with Testing Library for components, queried by role (`getByRole('button', {name: …})`) so tests follow what assistive technology sees.
- Playwright opens the built `report.html` over `file://` for SC-001, SC-002 and SC-004, records network requests and drives the grid by keyboard. This is the only test that proves the single-file build works.

### D11. Public demo

CI on `main` builds a comparison from `examples/pogo` and publishes its page to GitHub Pages. Only synthetic data is used.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Page grows past the budget on real runs | Slow to open, hard to attach | Each text stored once per key, failing examples capped by `report.samples`; the 1 MB budget is checked on the example in CI |
| Scope grows (decision recording, labelling) | Delays the P1 regions | Only the six regions and the list page are in this feature |
| A browser restricts `file://` behaviour | Navigation or scripts break when opened from disk | Hash-only state, no chunks, CSP hash; Playwright runs on `file://` in Chromium, Firefox and WebKit |
| The comparison schema changes in feature 001 | The page shows wrong values | The shared zod schema and the committed comparison fixture are used by both features' tests |
