# Tasks: Result Page

**Input**: Design documents from `/specs/002-report-viewer/`

**Prerequisites**: plan.md, spec.md, research.md, contracts/, quickstart.md. This branch carries `001-swap-check` merged in: the 001 code, the contract freeze (001 T022, T023) and the latest 001 and 002 docs.

**Tests**: Required (constitution IX). Every test name carries `002 FR-###` or `002 SC-###` for the requirement it checks, and tests call no model: they read the committed fixtures of `test/fixtures/contracts/` or a comparison of `examples/pogo` made with its Node adapter.

**Organization**: Tasks are grouped by user story. User Story 1 is the MVP: the result page of one comparison with the decision summary, the grid, the cell detail, the operational metrics, the scope and reproduction details, and everything else `report.md` shows. Each task ends with the requirements it serves.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions
- Task IDs of feature 001 are written `001 T###`

## Path Conventions

- The page app lives in `viewer/`, laid out as [plan §Project Structure](plan.md#project-structure); `pnpm build` builds it into `dist/viewer/report.html`
- The page imports these node-free 001 modules and never changes their behaviour: `src/report/schema.ts` (Comparison and page payloads), `src/messages/` and `src/report/code-text.ts` (text of codes), `src/report/format.ts` (numbers, imported directly so the page and `report.md` print the same values). It never imports `src/report/page-data.ts`, `src/report/markdown.ts` or `src/compare/`, which reach `node:` modules
- Tests use `fillTemplate`, `comparisonPage` and `listPage` of `src/report/page-data.ts`, `renderReport` of `src/report/markdown.ts` and `createRedactor` of `src/report/redact.ts`; browser tests import them from `src/` like the other tests, while the template and the CLI they run are build outputs (`dist/viewer/report.html`, `dist/cli.js`)
- Tests: `test/viewer/` (vitest with Testing Library in jsdom, project `viewer`), `test/browser/` (Playwright over `file://` against `dist/viewer/report.html`, after `pnpm build`), `test/contract/viewer/` (project `contract`), `test/e2e/` (project `e2e`)
- Fixtures: the page payloads and comparisons of `test/fixtures/contracts/` (001 T023). Payloads a test needs beyond them (an unknown `schemaVersion`, a planted secret, a low-baseline cell, two cases with two repeats) are derived from those files inside the test
- Network requests: a page "makes no request" when, after its own navigation, no request has a URL other than a `file://` URL of the page files of that test
- Writing `report.html` and the output `index.html` from `compare`, `swap` and `report` is 001 T126, which connects the template this feature builds

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Build, lint, test and CI tooling for the page

- [ ] T001 Extend `package.json`: development dependencies React 19 and ReactDOM with their types, Vite (the major the installed vitest uses), `@vitejs/plugin-react`, `vite-plugin-singlefile`, `@testing-library/react`, `@testing-library/user-event`, jsdom, `@playwright/test`, `@axe-core/playwright`, and the lint plugins that declare ESLint 10 support: `eslint-plugin-react-dom` 5.x (peer `eslint` `*`), `eslint-plugin-react-hooks` 7.x (peer up to `^10`) and `eslint-plugin-jsx-a11y-x` 0.2.x (peer `^9 || ^10`); `dependencies` stay `zod`, `ajv` and `yaml`; `build` also runs `vite build --config viewer/vite.config.ts`; add `test:browser` (`playwright test`); `files` keeps `dist`, so `dist/viewer/report.html` ships in the package (plan §Technical Context, constitution X)
- [ ] T002 [P] Create `viewer/tsconfig.json` for `viewer/src/` (DOM libraries and no Node types, so page code that touches Node fails the type-check, `jsx` `react-jsx`, `moduleResolution` `bundler`, and from `tsconfig.json`: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `resolveJsonModule`, `verbatimModuleSyntax`, `isolatedModules`, `noEmit`) and `viewer/tsconfig.node.json` for `viewer/vite.config.ts`, `playwright.config.ts`, `test/viewer/` and `test/browser/` (the same checks plus `jsx` `react-jsx`, Node types and the DOM library, since `test/viewer/` renders components and imports `src/report/markdown.ts`); exclude `test/viewer` and `test/browser` from `tsconfig.json`; `typecheck` checks all three projects (plan §Technical Context)
- [ ] T003 [P] Extend `eslint.config.js`: lint `viewer/src/` with `parserOptions.project` `viewer/tsconfig.json`, and `viewer/vite.config.ts`, `playwright.config.ts`, `test/viewer/` and `test/browser/` with `viewer/tsconfig.node.json`, instead of the project service; React Hooks recommended rules; `react-dom/no-dangerously-set-innerhtml` as an error (the `dangerouslySetInnerHTML` ban of plan D5 item 3); jsx-a11y-x recommended rules with `jsx-a11y-x/control-has-associated-label` set to `error`, since `recommended` leaves it off (plan D7) (FR-009, FR-011)
- [ ] T004 [P] Add the `viewer` project to `vitest.config.ts` (`test/viewer/**/*.test.{ts,tsx}`, jsdom, automatic JSX runtime, CSS Modules), and create `playwright.config.ts`: `testDir` `test/browser`, files `*.test.ts`, projects Chromium, Firefox and WebKit, no web server (plan D10, Risks)
- [ ] T005 [P] Create the layout of [plan §Project Structure](plan.md#project-structure): `viewer/src/{pages,domains/summary,domains/grid,domains/side-by-side,domains/metrics,domains/scope,report,components,hooks,i18n,utils,styles}/`, `test/viewer/`, `test/browser/`, `test/contract/viewer/` (plan §Project Structure)
- [ ] T006 [P] Make `scripts/check-spec-coverage.ts` also read test names from `test/**/*.test.tsx`, and add a case with a `.test.tsx` file to `test/unit/check-spec-coverage.test.ts` (constitution IX)
- [ ] T007 [P] Extend `.github/workflows/ci.yml`: run the `viewer` vitest project with the others; a browser job on Node 22 that installs the Playwright browsers and runs `pnpm build` and `pnpm test:browser --pass-with-no-tests`; after `pnpm pack`, fail when the tarball has no `package/dist/viewer/report.html` (SC-001, constitution IX)
- [ ] T008 [P] Set `**Status**` in `specs/002-report-viewer/spec.md` to `In Progress`, so `scripts/check-spec-coverage.ts` requires a test for every FR of this feature (constitution IX)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single-file template, the data reader, the page shells, the location hash, messages, colour schemes and the shared pieces every region uses. Tests T009 to T015 are written first and fail before the implementation.

**CRITICAL**: No user story work can begin until this phase is complete. T016 produces the `dist/viewer/report.html` that 001 T126 connects.

- [ ] T009 [P] Write template contract tests in `test/contract/viewer/template.test.ts` on `dist/viewer/report.html` per [page-data §Embedded Block](contracts/page-data.md#embedded-block) and [plan D5](plan.md#d5-model-output-is-untrusted-text): exactly one executable inline script; no `src` or `href` attribute in the HTML and no `url(` in the inline CSS other than `data:`; no `import(`; the CSP meta reads `default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src data:` with the SHA-256 of that script; `__MODEL_EVAL_DATA__` appears once, inside `<script type="application/json" id="model-eval-data">`, and in no file under `viewer/src/`; filling it with `fillTemplate` and each `test/fixtures/contracts/page-*.json` leaves the script and the CSP unchanged; `package.json` `dependencies` are `zod`, `ajv` and `yaml` only (FR-001, FR-010)
- [ ] T010 [P] Write data reader tests in `test/viewer/report/read-embedded-report.test.ts`: each `test/fixtures/contracts/page-*.json` returns `{ok: true}` with its payload; `schemaVersion` `"2"` returns `{ok: false}` naming `"2"`; a payload with `schemaVersion` `"1"` that fails `pageDataSchema` returns `{ok: false}` naming `"1"`; text that is not JSON (an unfilled placeholder) or a missing block returns `{ok: false}` with no version found; the reader never throws; and in `test/viewer/report/root-error-boundary.test.tsx`, a region that throws while rendering shows the error screen (FR-012)
- [ ] T011 [P] Write location hash tests in `test/viewer/utils/hash.test.ts` per [page-data §Location Hash](contracts/page-data.md#location-hash): empty and `#/` open the summary; `#/cell/<ruleId>/<lang>/<surface>` and `#/side/<ruleId>/<caseId>/<repeat>` parse and format back to the same string; segments go through `encodeURIComponent`, including IDs with `/` and non-ASCII text; `?lang=en` and `?lang=ko` after any hash override the payload language and other values are ignored; a hash naming no existing cell, rule, case or repeat of the fixture resolves to the summary (FR-004, FR-005, FR-013)
- [ ] T012 [P] Write message tests in `test/viewer/i18n/messages.test.ts`: `viewer/src/i18n/en.json` and `ko.json` have the same keys and no empty value; the page language is `?lang=` first, then the payload `lang`; verdicts, notes, `needed`, warnings and gate reasons of the fixtures give the same text as `src/report/code-text.ts` with a `quote` that returns the text unchanged (FR-013, plan D8)
- [ ] T013 [P] Write shared component tests in `test/viewer/components/`: `IntervalBar` is an SVG with `role="img"` and a `<title>` stating the rate and its interval, and draws no bar for `null` values; `VerdictBadge` shows the display name of 001 data-model §Cell for each of the six verdicts as text, with a colour class per verdict; `CodeText` renders `</script>`, `<!--`, `$&`, `<img src=x onerror=alert(1)>` and `<b>` as text, adds no element, and keeps newlines (its `textContent` equals the input and it is styled `white-space: pre-wrap`); `LanguageSwitch` is a labelled control that writes `?lang=` into the hash (FR-003, FR-004, FR-009, FR-013)
- [ ] T014 [P] Create the browser test helpers in `test/browser/pages.ts`: fill `dist/viewer/report.html` with a payload through `fillTemplate`, write it alone into a new temporary folder, open it over `file://` in an offline context, and record requests as §Path Conventions defines them, CSP violations (`securitypolicyviolation`) and dialogs; and `test/browser/global-setup.ts`, set as `globalSetup` in `playwright.config.ts`: copy `examples/pogo` to a temporary folder, run `node dist/cli.js swap --from current --to next --json` there (exit 1 expected, any other code fails), and write the example page from its `comparison.json` with `comparisonPage` and `fillTemplate` (SC-001)
- [ ] T015 Write invalid-data browser tests in `test/browser/invalid-data.test.ts` with the helpers of T014: pages filled with `schemaVersion` `"2"`, with a `"1"` payload missing `comparison`, and with the placeholder left as it is show the error screen naming the found version (or that none was found) and no region of the report; a valid fixture page validates and renders with zero CSP violations (FR-012, FR-010)
- [ ] T016 Create `viewer/index.html` (the data block of [page-data §Embedded Block](contracts/page-data.md#embedded-block), the CSP meta, `<link rel="icon" href="data:,">` so no browser asks for `/favicon.ico`, and the root element) and `viewer/vite.config.ts`: React plugin and `vite-plugin-singlefile`; a build that fails on a second chunk, a dynamic import or a bundled `node:` module; a step after inlining that writes the SHA-256 of the inline script into the CSP and emits `dist/viewer/report.html` (FR-001, FR-010, research R3)
- [ ] T017 [P] Move `isLowBaseline` and `BaselineOfCell` from `src/compare/gate.ts` into the node-free `src/report/low-baseline.ts`, imported by `src/compare/gate.ts`, `src/report/markdown.ts`, `src/cli/human/compare.ts`, `bench/sc003.ts` and the viewer, so the page and `report.md` share one definition; the existing gate, report and human output tests and `pnpm bench` pass unchanged (FR-016)
- [ ] T018 Implement `viewer/src/report/readEmbeddedReport.ts`: call `z.config({ jitless: true })` before any schema is built, that is before `src/report/schema.ts` is evaluated, since zod 4 probes `new Function` when it constructs an object schema and the CSP reports that probe; read the block once, `JSON.parse` (an unfilled placeholder fails here), validate with `pageDataSchema` of `src/report/schema.ts`, return `{ok: true, page} | {ok: false, error: {foundVersion}}` (FR-012, FR-010, plan D4)
- [ ] T019 Implement `viewer/src/main.tsx`, `viewer/src/App.tsx`, `viewer/src/pages/InvalidReport.tsx` and `RootErrorBoundary` in `viewer/src/pages/RootErrorBoundary.tsx`: read and validate the data, render `<InvalidReport>` with the found version or `<App>`, which picks `ReportPage` for `kind: comparison` and `ComparisonListPage` for `kind: list`; create `viewer/src/pages/ReportPage.tsx` and `viewer/src/pages/ComparisonListPage.tsx` rendering only their heading, for T042 and T056 to fill; the boundary shows the error screen for a rendering bug (FR-012, plan D4)
- [ ] T020 [P] Implement `parseHash`, `formatHash` and `resolveView` in `viewer/src/utils/hash.ts`, and `useHashParam` in `viewer/src/hooks/useHashParam.ts` with `useSyncExternalStore` on `hashchange`, writing through `location.hash` only (FR-004, FR-005, FR-013, plan D3)
- [ ] T021 [P] Create `viewer/src/styles/tokens.css` (colours, spacing and type as custom properties, a dark scheme under `prefers-color-scheme: dark`, one token pair per verdict) and `viewer/src/styles/global.css` (FR-014, plan D9)
- [ ] T022 Create `viewer/src/i18n/en.json`, `viewer/src/i18n/ko.json` and `viewer/src/i18n/useMessages.ts`: interface strings of the page, the starting language from `?lang=` through `parseHash` or the payload `lang`, code texts through `src/report/code-text.ts` with a `quote` that returns the text unchanged; set `<html lang>` to the current language (FR-013, plan D8)
- [ ] T023 Implement `IntervalBar`, `VerdictBadge`, `CodeText` and `LanguageSwitch` in `viewer/src/components/` with the hash of T020, the messages of T022 and the tokens of T021; numbers through `src/report/format.ts`; `viewer/src/utils/format.ts` holds only page-only helpers such as chart scales (FR-003, FR-004, FR-009, FR-013, plan D6)

**Checkpoint**: The template builds into one file, reads and validates its data, shows the error screen and the empty page shells; user story work can begin.

---

## Phase 3: User Story 1 - Decide a swap from the result page (Priority: P1) MVP

**Goal**: The page of one comparison shows the decision summary first, the rule × language grid per surface with pooled rates and low-baseline cells, a cell detail that opens and closes by keyboard, the operational metrics with post-processing figures and warnings, the scope, every rule's anchors and origins, the reproduction details, and the withheld banner for unfinished runs: everything `report.md` shows.

**Independent Test**: Build the page from `test/fixtures/contracts/page-comparison-block.json` and check in a browser test that the decision summary, the grid and a cell detail render. No model is called.

### Tests for User Story 1

> Write these tests first and make sure they fail before the implementation.

- [ ] T024 [P] [US1] Write decision summary tests in `test/viewer/summary/decision-summary.test.tsx`: on the block fixture, the gate outcome with the gated cell count, the text of each reason in `gate.reasons[]` order, the cells of `gate.blocking[]` marked as blocking and the number of prior comparisons, all above the sections in the order of 001 FR-028 (worse, better, undecided with the text of `needed`, operational changes, judged scope) from `comparison.summary`; a cell with a confirmed drop that is also undecided appears under worse and undecided; operational changes show cost per trial and latency p95 with their ratios and warning codes, as `report.md` shows them (FR-002, FR-016)
- [ ] T025 [P] [US1] Write withheld banner tests in `test/viewer/summary/withheld-banner.test.tsx`: on `comparison-undecided-partial.json` the banner is the first element of the page, above the header and the decision summary, and names the unfinished variant `next` and its stop reason `budget` through the text of `partial-run`; the gate shows `undecided` and the cells and metrics still render; the complete fixtures show no banner (FR-007)
- [ ] T026 [P] [US1] Write grid model tests in `test/viewer/grid/build-grid.test.ts`: one grid per surface present in `cells[]`; rows in `rules[]` order; columns are the languages of that surface's cells in order of first appearance in `cells[]`, so `completed` (ko, en, ja on `trial`) and `no-emoji` (ko, ja on `raw`), whose `languages` is empty, get their columns; a rule and language without a cell is an empty position, not a button (FR-003)
- [ ] T027 [P] [US1] Write grid tests in `test/viewer/grid/rule-language-grid.test.tsx`: the grid is a `<table>`; every cell is a `<button>` whose name holds rule, language and verdict text; the verdict is text and a colour class; Enter or Space on a cell opens its detail directly after that surface's table, moves focus to the detail's heading and sets `#/cell/<ruleId>/<lang>/<surface>`; the close button and Escape close it, clear the hash and return focus to that cell; opening the page on a cell hash opens that detail (FR-003, FR-011)
- [ ] T028 [P] [US1] Write cell detail tests in `test/viewer/grid/cell-detail.test.tsx`: for `script-ja` (ja, raw) of the block fixture, both rates with intervals and an `IntervalBar` each, the difference with its interval, the failure-rate ratio, the masked rate per variant, failing examples resolved by key from `samples.texts`, each with its variant, case and repeat, the finish reason, raw, `finalKind`, final or the no-final text, evidence, and their newlines, the anchor `日本語だけで話す` for the cell's language and the rule's origin; whether the cell is gated, its cases and dropped cases, its margin, its note and, for `completed` cells, systematic failures per variant; a cell with `failRatio` `null` and a baseline rate of 1 shows "baseline 0" (`script-ja` ja final), and one with a `null` baseline rate shows `—` (`no-emoji` ja raw); a cell that is not `raw` shows no masked rate; a cell without failing examples says so; `needed` text when present (FR-004, FR-016)
- [ ] T029 [P] [US1] Write pooled-rate and low-baseline tests in `test/viewer/grid/pooled-low-baseline.test.tsx`: `PooledRates` shows each entry of `aggregates[]` (rule, surface, both pooled rates with passes and trials, the difference) and no verdict; `LowBaselineCells`, on a payload derived from the block fixture with one non-`trial` cell's baseline rate below `config.report.lowBaseline`, lists that cell with both rates and its verdict and no `trial` cell, and on the block fixture says that no cell is below the level (FR-016)
- [ ] T030 [P] [US1] Write metrics tests in `test/viewer/metrics/metrics.test.tsx`: per variant every field of `comparison.ops`: the eight rates of `ops.rates` with counts and intervals, systematic trials and cases, top messages with their error kind and count, side-call failures per kind, abandoned trials per cause, finish reasons, p50 and p95, the five token means, cost per trial (`null` shown as `—`) and response models with their trials; `LatencyChart` is an SVG with `role="img"` and a `<title>` holding p50 and p95 that draws, for each variant, 20 equal-width bins from 0 to the larger of the two variants' largest `latencyMs.values`, each as high as the share of that variant's values in the bin on a height scale shared by both variants, with a mark only for a non-empty bin; for a variant with empty `values` it draws nothing and says that no latency was measured (FR-006)
- [ ] T031 [P] [US1] Write post-processing and warning tests in `test/viewer/metrics/postprocess-warnings.test.tsx`: `PostprocessPanel` shows the masked rates of every `raw` cell and, per variant, the discard, fallback and regeneration rates with counts and intervals and the discard reasons with counts; a variant with `postprocess: false` shows that it declares no post-processing in place of its figures (constitution I); `WarningList` shows each warning's text with its rule, language, variants and case IDs, and a message when there is none (FR-006, FR-016)
- [ ] T032 [P] [US1] Write scope and reproduction tests in `test/viewer/scope/scope.test.tsx`: judged targets; judged, not judged and `review` rules; `gate.excluded` with each cause; common cases, cases in one run only and cases with a changed hash from `coverage`; the baseline completion rate per language from `completion`; the comparison ID and `createdAt`; per variant the run ID, grade set ID, model, params as `JSON.stringify(variant.params)` (for example `{"reasoning":"none"}`), fingerprint, run status, the tool as one text `<name> <version>` (for example `model-eval 0.1.0`), adapter name, version and launch hash, helper, service version, `dirty` and tree hash, and post-processing; `stats`; the settings as `JSON.stringify(config, null, 2)` in a `<pre>`; the commands `model-eval compare <baseRunId> <candRunId>` and `model-eval report <comparisonId>`, one per line (FR-007)
- [ ] T033 [P] [US1] Write rule list tests in `test/viewer/scope/rule-list.test.tsx`: every entry of `rules[]` with ID, severity and title, each anchor with language, quote, target and cases, each origin with commit, date and layer, and a message for a rule without anchor or origin (FR-016)
- [ ] T034 [P] [US1] Write the report parity test in `test/viewer/pages/report-parity.test.tsx`: for each fixture comparison, the content of every code span and code block of `renderReport(comparison, 'en', 'result-page')` appears in the text of `ReportPage` with each cell detail opened in turn; a span's content is taken without its fence and without one padding space on each side, and page text and contents are compared with runs of whitespace collapsed to one space; so no quoted string of `report.md` is missing, while numbers and IDs are checked field by field by T024 to T033 (FR-016)
- [ ] T035 [P] [US1] Write report page browser tests in `test/browser/report-page.test.ts` on the block and partial fixture pages: the file opened alone and offline shows the decision summary, the grid, a cell detail, the metrics, the scope and the reproduction details; with the keyboard only, Tab reaches every cell button and Enter opens and Escape closes each detail with focus back on the cell; reloading with a cell hash opens that detail; the partial page shows the withheld banner on top and the gate `undecided` (FR-001, FR-002, FR-007, FR-011)
- [ ] T036 [P] [US1] Write example page browser tests in `test/browser/example-page.test.ts` on the page of `test/browser/global-setup.ts`: the file is at most 1,000,000 bytes; the decision summary is visible within 2 seconds of navigation and names `script-ja` (ja, raw) under worse cells and as the blocking cell; its detail shows the anchor `日本語だけで話す` and the rule's origin; every cell detail opens by keyboard alone; no request (SC-001, SC-002, SC-003)

### Implementation for User Story 1

- [ ] T037 [P] [US1] Implement `DecisionSummary` and `WithheldBanner` in `viewer/src/domains/summary/`: gate outcome, gated cell count, reasons, blocking cells and prior comparisons, then the sections in 001 FR-028 order from `comparison.summary`; the banner when a compared run's `status` is not `complete`, with the text of the `partial-run` reason (FR-002, FR-007, FR-016)
- [ ] T038 [P] [US1] Implement `buildGrid`, `useSelectedCell`, `RuleLanguageGrid`, `GridCell`, `PooledRates` and `LowBaselineCells` in `viewer/src/domains/grid/`: one `<table>` per surface with columns from its cells, a `<button>` per cell with a text label, selection kept in the hash, focus to the detail on open and back to the cell on close; pooled rates from `aggregates[]`; low-baseline cells with `isLowBaseline` of `src/report/low-baseline.ts` (FR-003, FR-011, FR-016, plan D7)
- [ ] T039 [US1] Implement `CellDetail` in `viewer/src/domains/grid/CellDetail.tsx`: the fields of FR-004 and the per-cell fields of FR-016 from the cell, `rules[]` and `samples`, with `IntervalBar`, `CodeText` for every sample and evidence text, "baseline 0" for a `null` ratio with a baseline rate of 1 and `—` for a `null` ratio with a `null` baseline rate, and the empty-examples message; close button and Escape (FR-004, FR-011, FR-016)
- [ ] T040 [P] [US1] Implement `MetricsTable`, `LatencyChart`, `PostprocessPanel` and `WarningList` in `viewer/src/domains/metrics/`: every field of `comparison.ops` per variant, the latency bins of `latencyMs.values` on one scale, the post-processing figures or the no-post-processing notice, warnings through `warningText`; every message and model string through `CodeText` (FR-006, FR-016, plan D6)
- [ ] T041 [P] [US1] Implement `ScopePanel`, `ReproductionPanel` and `RuleList` in `viewer/src/domains/scope/`: scope, excluded rules, coverage, completion, comparison ID, runs, variants with params as `JSON.stringify(variant.params)`, versions with the tool as one text `<name> <version>`, `postprocess`, statistics, the settings as `JSON.stringify(config, null, 2)` in a `<pre>`, the two reproduction commands one per line, and every rule's anchors and origins through `CodeText` (FR-007, FR-016)
- [ ] T042 [US1] Fill `ReportPage` in `viewer/src/pages/ReportPage.tsx`: the withheld banner first, then the header with the language switch, then the regions in the order of research R1 item 3 (the grid region holding pooled rates and low-baseline cells, the metrics region holding post-processing figures and warnings, the scope region holding the rule list), data slices passed down as props, the view from `resolveView` of the hash (FR-002, FR-007, FR-013, FR-016)

**Checkpoint**: The result page of one comparison works on its own from `file://` and shows everything `report.md` shows.

---

## Phase 4: User Story 2 - Judge semantic rules side by side (Priority: P1)

**Goal**: For `review` rules and failing examples, the baseline's and the candidate's answers to the same case and repeat appear next to each other, raw and final, with navigation across cases and repeats.

**Independent Test**: Open the block fixture page, choose `no-unprompted-self-state` and step through its cases; both answers of each case and repeat appear next to each other.

### Tests for User Story 2

> Write T044 to T046 first and make sure they fail before the implementation. T043 checks the samples 001 writes (001 T057) and passes once written.

- [ ] T043 [P] [US2] Write sample tests in `test/e2e/viewer-samples.test.ts` on the fixture comparisons and on the comparison of a `swap` of a temporary copy of `examples/pogo`: each (variant, `caseId`, `repeat`) appears once in `samples.texts`; every key of `samples.review` and `samples.failing` resolves to a text; no cell has more candidate failing keys than `config.report.samples` (FR-015)
- [ ] T044 [P] [US2] Write cursor tests in `test/viewer/side-by-side/use-sample-cursor.test.ts` on a payload derived from the block fixture with two cases and two repeats for `no-unprompted-self-state` and for the failing examples of `script-ja`: a `review` rule steps through its keys of `samples.review`; a rule with failing examples steps through the (case, repeat) pairs of its failing keys merged across its cells, each pair once and paired with the baseline text of the same case and repeat; order by case, then repeat; next and previous case and repeat stop at the ends; `#/side/<ruleId>/<caseId>/<repeat>` selects the position and an unknown one resolves to the summary (FR-005, FR-015)
- [ ] T045 [P] [US2] Write side-by-side tests in `test/viewer/side-by-side/side-by-side.test.tsx`: the rule chooser lists the `review` rules and the rules with failing examples; baseline and candidate columns show raw and final with `finalKind` and keep newlines; an error sample shows its kind and message in place of the text; previous and next buttons for case and repeat have text labels and work with the keyboard; a failing example in the cell detail links to its side-by-side position (FR-005, FR-011)
- [ ] T046 [P] [US2] Write side-by-side browser tests in `test/browser/side-by-side.test.ts`: on the block fixture page, with the keyboard only, open `no-unprompted-self-state`, see the transient error of `mood-vague-ko` in place of the candidate's text, and the move buttons stop at the ends; on the example page, step through its cases and repeats (FR-005, FR-011, SC-001)

### Implementation for User Story 2

- [ ] T047 [US2] Implement `useSampleCursor` and the key lookup into `samples.texts` in `viewer/src/domains/side-by-side/`: the key sets of T044, position in the hash (FR-005, FR-015)
- [ ] T048 [US2] Implement `SideBySide` in `viewer/src/domains/side-by-side/SideBySide.tsx`: rule chooser, two columns of raw and final through `CodeText`, error kind and message, labelled navigation buttons (FR-005, FR-011)
- [ ] T049 [US2] Add the side-by-side region to `viewer/src/pages/ReportPage.tsx` and the links from failing examples in `viewer/src/domains/grid/CellDetail.tsx` (passed as a prop from the page, so the grid domain does not import the side-by-side domain) (FR-005)

**Checkpoint**: User Stories 1 and 2 both work on their own.

---

## Phase 5: User Story 3 - Share the page safely (Priority: P1)

**Goal**: The page shows only redacted text, runs nothing found in model output and sends nothing anywhere.

**Independent Test**: Build the page from a fixture whose texts contain `</script>`, `<!--`, `$&` and HTML tags, open it from `file://`, and check that the texts appear literally and that no network request is made.

### Tests for User Story 3

> These tests check behaviour built in Phases 2 to 4 (text nodes, CSP, jitless validation) and by 001 (redaction); they pass once those phases are done. Only T053 adds code.

- [ ] T050 [P] [US3] Write untrusted text browser tests in `test/browser/untrusted-text.test.ts` named `002 FR-009 SC-004`: on the three fixture pages, the sample texts, error messages and top messages holding `</script>`, `<!--`, `$&`, `$1`, `<img src=x onerror=alert(1)>`, `<b>`, backtick runs and newlines appear with `textContent` equal to their fixture text in the cell detail, the side-by-side view and the metrics; the DOM holds no element made from them; no dialog opens (FR-009, SC-004)
- [ ] T051 [P] [US3] Write network browser tests in `test/browser/network.test.ts`: on the fixture and example pages, loading, opening every cell detail, stepping the side-by-side view and switching the language make no request and cause no CSP violation (FR-010)
- [ ] T052 [P] [US3] Write redaction browser tests in `test/browser/redaction.test.ts`: plant a phone number matching the `examples/pogo` `redact` rule in fixture sample texts, redact the Comparison with `createRedactor` and build the page; neither the file nor the page text after opening every region holds the number, and `<phone>` appears as text. Redaction by the writer is 001's (001 T036, and 001 T042, whose check reads every written file and so covers `report.html` once 001 T126 writes it) (FR-001)

### Implementation for User Story 3

- [ ] T053 [US3] Extend `eslint.config.js` for `viewer/src/`: `no-eval`, `no-new-func`, `no-implied-eval`, and bans of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` and `import()`, so no code path can run code or render markup from data or open a connection (FR-009, FR-010, plan D5)

**Checkpoint**: User Stories 1 to 3 work; the page can be passed around as a file.

---

## Phase 6: User Story 4 - Find earlier comparisons (Priority: P1)

**Goal**: The output root's `index.html` lists every comparison and opens each one's page.

**Independent Test**: Build an output directory with two comparisons, write its `index.html` from the `list` payload and open it; both are listed and open.

### Tests for User Story 4

> Write these tests first and make sure they fail before the implementation.

- [ ] T054 [P] [US4] Write list page tests in `test/viewer/pages/comparison-list-page.test.tsx` on `test/fixtures/contracts/page-list.json`: rows in payload order with comparison ID, baseline and candidate, `createdAt` and the gate outcome as text; each row links to its `href`; an empty list shows a message; Korean when the payload `lang` is `ko` (FR-008, FR-013)
- [ ] T055 [P] [US4] Write list browser tests in `test/browser/list.test.ts`: an output folder with two comparison folders built from the fixture comparisons under distinct IDs (`comparison.json` and `report.html`) and a `.tmp-` folder; `index.html` from `listPage` and `fillTemplate`; opened over `file://`, it lists both newest first and not the `.tmp-` folder, and each link opens its page without a request outside that output folder (FR-008, FR-010)

### Implementation for User Story 4

- [ ] T056 [US4] Fill `ComparisonListPage` in `viewer/src/pages/ComparisonListPage.tsx`: a table of the `comparisons[]` of the payload, relative links, the language switch (FR-008, FR-013)

**Checkpoint**: All user stories work on their own.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Language and theme across the page, docs, the parts that wait on 001 T126, the example pages in CI, and validation by people

- [ ] T057 [P] Write language and theme browser tests in `test/browser/lang-theme.test.ts`: a page whose payload `lang` is `ko` starts in Korean (`<html lang>`, headings from `ko.json`, verdict texts from `src/messages/ko.json`); switching to English changes every page string, writes `?lang=en` and survives a reload; `?lang=ko` overrides an `en` payload; under the light and the dark scheme the background differs and body text and every verdict badge reach a contrast ratio of at least 4.5:1 (FR-013, FR-014)
- [ ] T058 [P] Write accessibility browser tests in `test/browser/a11y.test.ts` with `@axe-core/playwright` (the guarantee of plan D7; lint is the first line), with the rule tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `best-practice`: on the block and partial fixture pages with each cell detail open in turn and with the side-by-side view open, on a page with a variant whose `latencyMs.values` is empty, on the invalid-data error screen and on the list page, in English and Korean and under the light and the dark scheme, axe reports no violation (FR-003, FR-011, FR-012, FR-014)
- [ ] T059 [P] Create `docs/guide/result-page.md`: the regions, cell and side-by-side links with `?lang=`, opening from disk, the CSP and what the page never does; link it from `README.md` (FR-001, FR-010, FR-013)
- [ ] T060 Once 001 T126 connects the template, switch `test/browser/global-setup.ts` to the `report.html` and `index.html` that `swap` writes in the example's output directory, and make `test/browser/list.test.ts` use two `swap` runs of the example, as the independent test of User Story 4 states (FR-001, FR-008)
- [ ] T061 Add example-page steps to the `browser` job of `.github/workflows/ci.yml`, after 001 T126: after the build, run the `examples/pogo` swap on a copy of the example (exit 1 expected, any other code fails), then upload the output `index.html` and each `comparisons/<comparisonId>/report.html` with `actions/upload-artifact` and `retention-days: 14`, nothing else from the output directory (plan D11, constitution V)
- [ ] T062 (manual, not for agents) Give a person new to the repository only the example page and record in `specs/002-report-viewer/checklists/validation.md` whether they named the rule, the language and the prompt sentence that caused the block (SC-003)
- [ ] T063 (manual, not for agents) Follow `specs/002-report-viewer/quickstart.md` in Chromium, Firefox and Safari with the network off, including the Korean and dark-mode steps, and record the result in `specs/002-report-viewer/checklists/validation.md` (SC-001, SC-002, FR-013, FR-014)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; T002 to T008 follow T001. From T008 on, `pnpm check:coverage` fails until every FR of this feature has a test (after T054).
- **Foundational (Phase 2)**: Depends on Setup. Blocks all user stories. Tests: T015 after T014. Implementation: T016, T017, T020 and T021 first; T018 after T016; T019 after T018; T022 after T020; T023 after T020 to T022. T009, T014 and T015 run against the build of T016.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on User Story 1 (`ReportPage` and `CellDetail` it extends).
- **User Story 3 (Phase 5)**: Its tests depend on User Stories 1 and 2, whose regions they open; T053 depends on T003 only.
- **User Story 4 (Phase 6)**: Depends on Foundational only.
- **Polish (Phase 7)**: T057 depends on User Stories 1 and 4; T058 on User Stories 1, 2 and 4. T060 and T061 depend on 001 T126, which depends on T016. T062 depends on T060. T063 depends on all user stories.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after Foundational. No dependency on other stories.
- **User Story 2 (P1)**: Starts after User Story 1.
- **User Story 3 (P1)**: Its tests start once User Stories 1 and 2 render.
- **User Story 4 (P1)**: Starts after Foundational. Can run in parallel with User Stories 1 to 3.

### Within Each User Story

- Tests are written and fail before implementation, except where a phase note says they check behaviour built earlier.
- Domain components before the page that composes them; T042 after T037 to T041; T039 after T038.
- `viewer/src/App.tsx` is written once, by T019. `viewer/src/pages/ReportPage.tsx` is created by T019 and edited by T042 and T049, `viewer/src/pages/ComparisonListPage.tsx` by T019 and T056, `viewer/src/domains/grid/CellDetail.tsx` by T039 and T049, and `eslint.config.js` by T003 and T053; those tasks run one after another.
- A domain never imports another domain; pages pass data and callbacks down (plan §Structure Decision).
- Commit after each task or logical group.

### Parallel Opportunities

- T002 to T008 in Setup.
- In Foundational, tests T009 to T014; then T016, T017, T020 and T021.
- In User Story 1, tests T024 to T036; then T037, T038, T040 and T041.
- In User Story 2, tests T043 to T046.
- In User Story 3, tests T050 to T052, and T053 at any time after T003.
- User Story 4 beside User Stories 1 to 3.

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Write decision summary tests in test/viewer/summary/decision-summary.test.tsx"
Task: "Write grid tests in test/viewer/grid/rule-language-grid.test.tsx"
Task: "Write metrics tests in test/viewer/metrics/metrics.test.tsx"
Task: "Write the report parity test in test/viewer/pages/report-parity.test.tsx"
Task: "Write example page browser tests in test/browser/example-page.test.ts"

# Launch independent domains for User Story 1 together:
Task: "Implement DecisionSummary and WithheldBanner in viewer/src/domains/summary/"
Task: "Implement buildGrid, useSelectedCell, RuleLanguageGrid, GridCell, PooledRates and LowBaselineCells in viewer/src/domains/grid/"
Task: "Implement MetricsTable, LatencyChart, PostprocessPanel and WarningList in viewer/src/domains/metrics/"
Task: "Implement ScopePanel, ReproductionPanel and RuleList in viewer/src/domains/scope/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational, so `dist/viewer/report.html` exists for 001 T126.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: the block and partial fixture pages and the example page pass T035 and T036, and the parity test T034 passes.

### Incremental Delivery

1. Setup and Foundational: the single-file template, data validation, page shells, hash, messages.
2. User Story 1: the result page of one comparison (MVP).
3. User Story 2: the side-by-side view.
4. User Story 3: untrusted text, network and redaction checks.
5. User Story 4: the comparison list.
6. Polish: language and theme, docs, the parts that wait on 001 T126, the example pages in CI, then validation by people.

### Parallel Team Strategy

1. The team completes Setup and Foundational together.
2. Then one person on User Stories 1 and 2, another on User Story 4.
3. User Story 3 once the regions render; the 001 T126 integration once T016 is merged.

---

## Notes

- [P] tasks touch different files and depend on no incomplete task.
- [Story] labels map tasks to user stories in spec.md.
- Payload fields, escaping and hash forms have one home in [contracts/page-data.md](contracts/page-data.md); the Comparison has its home in [001 data-model §Comparison](../001-swap-check/data-model.md#comparison). Tasks point to them and do not copy them.
- The page decides nothing: it shows the verdicts, the gate and the summary the comparison holds.
- Verify that tests fail before implementing.
- Stop at any checkpoint to validate a story on its own.

## Requirement Coverage

Every FR and SC of [spec.md](spec.md) and the tasks that serve it. Test tasks are the ones whose description starts with "Write" (T062 and T063 are manual).

| Requirement | Tasks |
|---|---|
| FR-001 | T009, T016, T035, T052, T059, T060 |
| FR-002 | T024, T035, T037, T042 |
| FR-003 | T013, T023, T026, T027, T038, T058 |
| FR-004 | T011, T013, T020, T023, T028, T039 |
| FR-005 | T011, T020, T044, T045, T046, T047, T048, T049 |
| FR-006 | T030, T031, T040 |
| FR-007 | T025, T032, T035, T037, T041, T042 |
| FR-008 | T054, T055, T056, T060 |
| FR-009 | T003, T013, T023, T050, T053 |
| FR-010 | T009, T015, T016, T018, T051, T053, T055, T059 |
| FR-011 | T003, T027, T035, T038, T039, T045, T046, T048, T058 |
| FR-012 | T010, T015, T018, T019, T058 |
| FR-013 | T011, T012, T013, T020, T022, T023, T042, T054, T056, T057, T059, T063 |
| FR-014 | T021, T057, T058, T063 |
| FR-015 | T043, T044, T047 |
| FR-016 | T017, T024, T028, T029, T031, T033, T034, T037, T038, T039, T040, T041, T042 |
| SC-001 | T007, T014, T036, T046, T063 |
| SC-002 | T036, T063 |
| SC-003 | T036, T062 |
| SC-004 | T050 |
