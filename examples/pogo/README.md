# Pogo

A synthetic chat character for trying model-eval without an API key. `adapter.mjs` speaks the
adapter protocol and needs only Node; a stand-in model writes every answer, so no model is
called and every run gives the same result.

The stand-in for `model-b` mixes a Korean word into some Japanese answers, so a swap from
`current` (`model-a`) to `next` (`model-b`) blocks on the rule `script-ja`. The English prompt
says "Do not use emoji" where the rule `no-emoji` quotes "Never use emoji", which `lint --render`
reports as one `anchor-missing` warning.

From the repository root, after `pnpm install && pnpm build`:

```bash
cd examples/pogo
node ../../dist/cli.js lint --render
node ../../dist/cli.js swap --from current --to next --dry-run
node ../../dist/cli.js swap --from current --to next
```

The last command exits 1 and writes `.model-eval/comparisons/<comparisonId>/report.md`.

| File                     | Contents                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `model-eval.config.yaml` | Adapter command, the two variants, prices and the gate                                    |
| `rules/pogo.yaml`        | Eight rules: completion, scripts, emoji, speech level, mood, self-description and copying |
| `cases/*.yaml`           | 30 synthetic cases per language (Korean, English, Japanese)                               |
| `adapter.mjs`            | Prompt assembly, the stand-in model and post-processing                                   |
