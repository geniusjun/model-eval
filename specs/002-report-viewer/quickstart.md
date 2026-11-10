# Quickstart: Result Page

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

Run from the repository root after `pnpm install`.

## Verify: Page From the Example Comparison (SC-001, SC-002, SC-003)

1. Build the template and the example comparison.

   ```bash
   pnpm build
   cd examples/pogo && node ../../dist/cli.js swap --from current --to next
   ```

2. Open `.model-eval/comparisons/<comparisonId>/report.html` in a browser with the network turned off.

   Done when:
   - the decision summary is on the first screen within 2 seconds and names `script-ja` (ja, raw) under worse cells;
   - selecting that cell in the grid shows both rates with intervals, the failure-rate ratio, the masked rate, failing examples, the anchor `日本語だけで話す` and the rule's origin;
   - Tab and Enter open and close every cell detail;
   - the `review` rule `no-unprompted-self-state` opens a side-by-side view that steps through cases and repeats;
   - the file is at most 1 MB;
   - someone new to the repository, given only this page, names the rule, the language and the prompt sentence that caused the block.

3. Open `.model-eval/index.html`. Done when the comparison is listed and opens.

## Verify: Untrusted Text (SC-004)

```bash
pnpm test:browser --grep "002 FR-009"
```

Done when the fixture texts containing `</script>`, `<!--`, `$&` and HTML tags appear literally and the test records zero network requests.

## Verify: Language and Theme (FR-013, FR-014)

Run the example swap with `--lang ko`, open the page and switch to English in the page. Then switch the system to dark mode. Done when all page text changes language and both schemes are readable.
