# Page Data Contract

**Feature**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

Feature 001 writes these payloads into the page template; the page reads them and nothing else. Everything in them is redacted (001 FR-031).

## Embedded Block

The template has one data block:

```html
<script type="application/json" id="model-eval-data">__MODEL_EVAL_DATA__</script>
```

1. The writer serialises the payload as JSON and writes every `<` as `\u003c`, so `</script>` or `<!--` inside a model output cannot end the block.
2. It replaces the placeholder with a replacer function, not a replacement string, because string replacement interprets `$&`, `$1` and similar patterns.
3. The page parses the block once at start and validates it with `src/report/schema.ts`, the zod schema feature 001 writes with. An unknown `schemaVersion` or a failed validation shows the error screen with the version found (FR-012).

## Payloads

Both payloads share an envelope:

| Field | Description |
|---|---|
| `schemaVersion` | `"1"` |
| `kind` | `comparison` for `report.html`, `list` for the output root's `index.html` |
| `lang` | `en` or `ko`, the language of the command that wrote the page; the page starts in it (FR-013) |

`kind: comparison` adds:

| Field | Description |
|---|---|
| `comparison` | The 001 Comparison ([001 data-model §Comparison](../../001-swap-check/data-model.md#comparison)) |
| `gate` | The 001 Gate ([001 data-model §Gate](../../001-swap-check/data-model.md#gate)) |

`kind: list` adds `comparisons[]`, one entry per comparison folder in the output directory, newest first, folders starting with `.tmp-` skipped:

| Field | Description |
|---|---|
| `comparisonId` | The folder name |
| `href` | Relative link to that comparison's `report.html` |
| `baseline`, `candidate` | `variant.id` of the Comparison's `baseline` and `candidate` |
| `createdAt` | The Comparison's `createdAt` |
| `gate` | `outcome` of the Gate (`pass`, `block`, `undecided`, `no-gate`) |

## Location Hash

The page keeps the reader's place in `location.hash`, so a link to one view can be pasted next to the file:

| Hash | View |
|---|---|
| empty or `#/` | Decision summary at the top |
| `#/cell/<ruleId>/<lang>/<surface>` | Grid with that cell's detail open |
| `#/side/<ruleId>/<caseId>/<repeat>` | Side-by-side view of that rule's `review` sample or failing example at that case and repeat |

- Each segment is encoded with `encodeURIComponent`.
- `?lang=en` or `?lang=ko` may follow any hash and overrides the payload language.
- A hash that names no existing cell, rule, case or repeat opens the decision summary.
