# Feature Specification: Result Page

**Feature Branch**: `002-report-viewer`

**Created**: 2026-11-09

**Status**: In Progress

**Input**: User description: "A result page for each swap check where the team sees where the candidate model got better or worse, what stayed undecided and how cost and latency change, and decides on the swap."

**Builds On**: `001-swap-check` (comparison output)

## Context

Feature 001 ends with a comparison: cell verdicts, a decision summary, operational metrics, failing examples and samples, as JSON and Markdown. A table of numbers is hard for a team to decide on. People need to follow a regression from the summary to the failing answers and the prompt sentence behind the rule, and to read two answers to the same input side by side; semantic rules are judged that way until LLM judges exist.

This feature turns every comparison into one HTML file that opens without a server or network, so it can be attached to a pull request or a chat message.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Decide a swap from the result page (Priority: P1)

When a swap check finishes, a result page is written next to the comparison, also for a check that stopped early. The operator and the team open it and see first what got worse, what got better, what stayed undecided and how cost and latency change, then drill into any cell.

**Why this priority**: The swap decision is made here. Without it the team reads JSON or a long Markdown table.

**Independent Test**: Build the page from the example comparison fixture and check in a browser test that the decision summary, the grid, a cell detail and the side-by-side view render. No model is called.

**Acceptance Scenarios**:

1. **Given** a finished swap check, **When** the page file is opened without network, **Then** the first screen shows the decision summary: worse cells, better cells, undecided cells, changes in operational metrics including cost and latency, and the judged scope.
2. **Given** the rule × language grid, **When** a regressed cell is selected, **Then** the detail shows both compliance rates with an interval chart, the failure-rate ratio, the masked rate, failing examples (raw and final), the anchored prompt sentence and the rule's origin.
3. **Given** a swap check that stopped on the cost cap, **When** the page is opened, **Then** the top says the verdict is withheld because the check did not finish, and the cell verdicts and metrics so far are visible.
4. **Given** keyboard use only, **When** moving through the grid, **Then** every cell detail can be opened and closed.

---

### User Story 2 - Judge semantic rules side by side (Priority: P1)

For `review` rules, people read the baseline's and the candidate's answers to the same case next to each other and move across cases and repeats.

**Why this priority**: Semantic rules are judged by people in this feature set, and this view is the tool for it.

**Independent Test**: Open the example page, choose a `review` rule and step through its cases; both answers of each case and repeat appear next to each other.

**Acceptance Scenarios**:

1. **Given** a `review` rule, **When** the side-by-side view opens, **Then** the baseline's and the candidate's answers to the same case appear next to each other, raw and final, and the reader can step through cases and repeats.
2. **Given** a sample whose trial ended in an error, **When** it is shown, **Then** the error kind and message appear in place of the text.

---

### User Story 3 - Share the page safely (Priority: P1)

The page is passed around as a file. It must show only redacted text, must not execute anything found in model output and must not send data anywhere.

**Why this priority**: Model output is untrusted text and comparisons can contain user-like data; a page that leaks or runs it cannot be shared.

**Independent Test**: Build the page from a fixture whose texts contain `</script>`, `<!--`, `$&` and HTML tags, open it from `file://`, and check that the texts appear literally and that no network request is made.

**Acceptance Scenarios**:

1. **Given** redaction rules, **When** the page is built, **Then** every text in the page is the redacted value.
2. **Given** model output containing `</script>`, `<!--`, `$&` or HTML, **When** the page is opened, **Then** the text appears as written and nothing in it runs.
3. **Given** the page opened from disk, **When** it loads and is used, **Then** it makes no network request.

---

### User Story 4 - Find earlier comparisons (Priority: P1)

The output directory has a list page of all comparisons, so people can open an earlier one without searching folders.

**Why this priority**: Swap decisions are revisited as runs accumulate, and the output directory holds one folder per comparison under an ID; without the list, finding an earlier result means opening folders one by one.

**Independent Test**: Run two comparisons of the example and open the output's `index.html`; both are listed and open.

**Acceptance Scenarios**:

1. **Given** two comparisons in the output directory, **When** `index.html` is opened, **Then** both are listed and each opens its page.

---

### Edge Cases

- **What if the comparison is partial?** A withheld banner stays at the top and the gate outcome shows as `undecided` (FR-007).
- **What if a cell has no failing example?** The detail says so instead of showing an empty list (FR-004).
- **What if the baseline has no failure in a cell?** The failure-rate ratio shows "baseline 0" instead of a number (FR-004).
- **What if a confirmed drop is also undecided?** The cell appears under worse cells and under undecided cells, as in the comparison (FR-002).
- **What if the embedded data has an unsupported schema version or fails validation?** The page shows an error screen with the version it found, not a broken view (FR-012).
- **What if model text contains markup or script?** It is rendered as text only (FR-009).
- **What if the page is opened offline or from a mail attachment?** It works the same, because everything is inside the file (FR-001).
- **What if the reader prefers Korean or a dark theme?** The page switches language and follows the system colour scheme (FR-013, FR-014).
- **What if a variant declares no post-processing?** The page says so in place of that variant's post-processing figures (FR-016).
- **What if the comparison is large?** Each trial text is stored once and referenced by key, and failing examples are limited per cell (FR-015).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST write each comparison's result page as one HTML file that embeds the redacted comparison data and opens without a server or network.
- **FR-002**: The page MUST start with the decision summary of the comparison, in the order of 001 FR-028.
- **FR-003**: The page MUST show a rule × language grid per output surface in which every cell states its verdict in text as well as colour.
- **FR-004**: The cell detail MUST show both rates with an interval chart, the difference and its interval, the failure-rate ratio, the masked rate, failing examples (raw and final), the anchored prompt sentence and the rule's origin.
- **FR-005**: The page MUST offer a side-by-side view of baseline and candidate samples of the same case for `review` rules and failing examples, with navigation across cases and repeats.
- **FR-006**: The page MUST show the operational metrics of each variant: the eight rates with their counts and intervals, systematic failures, discard reasons, typical error messages per error kind, side-call failures, abandoned trials per cause, finish reasons, the latency distribution with p50 and p95, tokens and cost per trial, and response model snapshots; and the warnings of the comparison.
- **FR-007**: The page MUST show the judged scope (targets; judged, not judged, `review` and excluded rules; coverage; the baseline completion rate per language), reproduction details (comparison ID, runs, grade sets, variants, versions, statistics settings, the settings used and the commands that reproduce the comparison), and a withheld banner at the top for a comparison of unfinished runs.
- **FR-008**: The output directory MUST contain an `index.html` that lists every comparison and opens each one's page.
- **FR-009**: The page MUST treat every model, service and provider string as text and never interpret it as markup.
- **FR-010**: The page MUST make no network request while it loads or is used.
- **FR-011**: Every cell detail and the side-by-side navigation MUST be operable with the keyboard alone.
- **FR-012**: The page MUST validate the embedded data before rendering and show an error screen that names the found schema version when it cannot render it.
- **FR-013**: The page MUST offer English and Korean text, starting in the language chosen for the command (001 FR-034) and switchable in the page.
- **FR-014**: The page MUST support light and dark colour schemes.
- **FR-015**: The page MUST store each trial text once per (variant, case, repeat) and reference it from cells, and include at most the configured number of failing examples per cell.
- **FR-016**: The page MUST show everything the Markdown report (001 FR-029) shows for the same comparison. Beyond FR-002 to FR-007 this is: the gated cell count and the number of prior comparisons with the gate result; per cell whether it is gated, its cases and dropped cases, its margin, its note and its systematic failures; the pooled rate per rule and surface; the post-processing figures of each variant (masked rates, discard, fallback and regeneration rates, discard reasons) or that it declares no post-processing; the cells whose baseline compliance is below the configured level; and the anchors and origins of every rule.

### Key Entities *(include if feature involves data)*

- **Comparison**: The 001 Comparison and its Gate after redaction (cells, summary, operational metrics, samples, warnings, scope, gate outcome). The page reads it and never changes it.
- **Page state**: What the reader is looking at: selected surface, cell, side-by-side position and language. It lives in the page and its address, never in the file's data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The example comparison's page is a single file of at most 1 MB that opens without network, and a browser test sees the decision summary, the grid, a cell detail and the side-by-side view, with zero network requests and every cell detail opened by keyboard alone.
- **SC-002**: The decision summary is visible within 2 seconds of opening the example page.
- **SC-003**: A person new to the repository can tell, from the example page alone, which rule, language and prompt sentence caused the block.
- **SC-004**: A fixture whose texts contain `</script>`, `<!--`, `$&` and HTML tags renders those texts literally in a browser test.

## Assumptions

- The page shows one comparison of feature 001 and reads only its data; anything it shows is already in the comparison.
- The 1 MB budget applies to the example comparison. Real runs can produce larger pages with more cases and rules.
- Two kinds of charts are enough: interval bars and latency distributions.
- A public demo built from the synthetic example is published on GitHub Pages; it contains no real data.
- Out of scope for this feature: recording decisions or labels in the page, editing rules, comparing more than two variants, a local server and a hosted dashboard.
