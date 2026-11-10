# Research: Result Page

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## R1. What form the result page takes

**Decision**:

1. One HTML file per comparison (`report.html`) with the redacted comparison inside and React drawing the screen. It opens without a server or network and can be attached to a pull request or a message.
2. A comparison list (`index.html`) at the output root.
3. Regions in decision order: decision summary (001 FR-028), rule × language grid, cell detail (interval chart, failure-rate ratio, masked rate, failing examples, anchored sentence, origin), side by side, operational metrics, scope and reproduction.
4. Hand-drawn SVG for interval bars and latency distributions, no chart library.
5. The page built from the synthetic example is published on GitHub Pages as a demo and rebuilt by CI when `main` changes.

**Rationale**:

- Deciding is not reading a table; it is following where and how something got worse. Failing examples, the prompt sentence and both models' answers to the same input must sit on one screen, and with dozens of cells a Markdown report is hard to follow.
- Semantic rules are judged by people until LLM judges exist, and the side-by-side view is how they do it.
- A single file is easy to share and keeps the data on the machine; only redacted data goes in (001 FR-031).
- The page needs two kinds of charts, so a chart library would only grow the bundle.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| A local server (`model-eval view`) | Needs a running process every time and cannot be shared as a file |
| A hosted dashboard | Sends run records off the machine; out of scope |
| Markdown only | Hard to follow with many cells and has no side-by-side view. Markdown stays as the pull request comment format |

## R2. Code conventions

**Decision**: Write code for readability, predictability, cohesion and low coupling, lay out directories by domain, keep state in `useState` and the URL hash, style with CSS Modules and custom properties, and add no runtime library beyond React.

**Rationale**:

- Code that is easy to change has four properties, each with concrete rules: readability (separate code that does not run together, abstract implementation details, name complex conditions and magic numbers, avoid nested ternaries), predictability (unique names, one return shape per kind of function, no hidden logic), cohesion (files changed together live together) and coupling (one responsibility per hook, allow duplication over premature sharing, prefer composition to Context for props drilling). Each rule has a checkable form, which suits a small codebase reviewed by people and agents.
- With shared `components/`, `hooks/` and `utils/` at the top and one folder per domain beside them, deleting a region is deleting a folder and cross-domain imports are visible.
- The page has no asynchronous data, no dialogs and one level of composition, so a store, a router, a data-fetching library or a Suspense wrapper would add code without solving a problem here.
- CSS Modules and custom properties are built into Vite, inline into the single file and need no runtime.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Emotion or another CSS-in-JS runtime | Adds a runtime to every page for styling that static CSS covers |
| vanilla-extract | Adds a build plugin for a handful of components |
| A global store (Redux, Zustand, Jotai) | State is a selected cell, a cursor and a language; the hash and local state hold it |
| React Router | Two pages and a few hash fragments; a router adds weight and `file://` edge cases |
| React Query, Suspense helpers | Nothing is fetched; the data is in the file |
| Overlay and hook libraries | The detail panel is in-page state, and each hook needed is a few lines |
| Feature-Sliced Design layers, separate packages | More structure than six regions need |

## R3. A single file that works from `file://`

**Decision**: Build with Vite and `vite-plugin-singlefile`, forbid dynamic imports, compute the script hash at build time for the CSP, and insert the data with a replacer function after escaping `<`.

**Rationale**:

- Browsers refuse to load extra chunks and ES module imports from `file://` pages, so everything must be inline.
- A CSP with `default-src 'none'` and a hashed script lets the page prove it makes no request, which keeps the "data stays on the machine" promise without trusting the code that renders model output.
- `</script>` and `<!--` inside JSON would end the script block; writing every `<` as `\u003c` keeps the JSON valid and inert.
- `String.prototype.replace` with a string interprets `$&`, `$1` and similar patterns; a replacer function inserts the data verbatim.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Separate script chunks or dynamic imports | Not loaded from `file://` pages (first bullet above) |
| Inserting the data with a replacement string | Patterns in model output would be expanded (last bullet above) |

## R4. Keeping the reader's place on `file://`

**Decision**: Encode the selected cell, the side-by-side position and the language in `location.hash`, read through `useSyncExternalStore` on `hashchange`.

**Rationale**:

- A hash link can be pasted next to the file ("look at `#/cell/script-ja/ja/raw`").
- `file://` documents have an opaque origin, and some browsers reject `history.pushState` with a URL there; changing the hash is allowed everywhere and fires `hashchange`.
- `useSyncExternalStore` keeps the hash the single source of truth without effects that copy it into state.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| `history.pushState` with a path or query | Some browsers refuse the URL update on `file://` (second bullet above) |
