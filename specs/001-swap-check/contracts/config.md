# Config, Rule and Case Files Contract

**Feature**: [../spec.md](../spec.md) | **Data model**: [../data-model.md](../data-model.md)

All files are YAML. The tool ships JSON Schemas (`schemas/config.schema.json` and others) for editor completion and lint. The examples below describe Pogo, the synthetic chat character of `examples/pogo`, and pass lint as written.

## Config File

`model-eval.config.yaml`:

Every value the example shows is the default for a key that is left out, with these exceptions: `version`, `adapter.command`, `variants` and `pricing` are required; `gate.severities` and `redact` default to empty lists, so a left-out gate blocks nothing; `gate.margin` defaults to 0.10; `estimate.inputTokens` has no default.

```yaml
version: 1
lang: en                                   # Human output and result page language: en or ko.

adapter:
  command: [node, adapter.mjs]             # An array; no shell is involved.
  cwd: .
  env: {}                                  # Do not put API keys here; the adapter reads them from its environment.
  timeoutMs: 120000                        # How long the tool waits for one trial. Make it longer than one service call
                                           # can take, SDK retry waits included. Without a service time limit this is
                                           # effectively the time limit (data-model §Trial Outcomes).

files:
  rules: rules/**/*.yaml
  cases: cases/**/*.yaml

variants:                                  # params are stored in the run as is; never put secrets here.
  - id: current
    model: model-a
  - id: next
    model: model-b
    params: { reasoning: none }            # Interpreted by the adapter.

pricing:                                   # USD per 1M tokens. The tool ships no prices (constitution VII).
  model-a: { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 }
  model-b: { input: 0.20, cachedInput: 0.02, cacheWrite: 0.25, output: 1.20 }
  # cacheWrite only for models that bill cache writes. When write prices differ per cache lifetime,
  # use the lifetime the service uses, or the most expensive one when it uses several.
  # Add every other model the service calls; with a cap, an unpriced call stops the run.
  # Missing prices and bucket rules: data-model §Cost.

sampling:
  repeats: 5                               # With 30 cases per language, an unchanged candidate passes a cell about 94% of
  seed: 1729                               # the time and a 30-point drop is caught about 97% (research R3). Per-trial seeds derive from this.

stats:
  confidence: 0.95                         # Two-sided 95% per cell. Only the blocking upper bound is corrected for the number of gated cells.
  minCases: 3                              # Minimum common cases for a passing verdict. Cannot be below 3.

gate:                                      # Omitted or with empty severities, nothing blocks: no-gate when the preconditions
                                           # hold, otherwise undecided (constitution IV, data-model §Gate).
  severities: [blocking]                   # Severities of gated rules.
  margin: 0.10                             # A rule's own margin wins. Used for cell verdicts even without a gate.

run:
  concurrency: 4                           # Concurrent requests per adapter process.
  retries: 2                               # Retries of transient failures (429, 5xx, connection failures and drops). Time-outs are never retried.
  maxAdapterErrorRate: 0.05                # Share of finished trials that ended as adapter errors; above it after 20 finished trials, stop as partial.
  maxTransientRate: 0.5                    # Share of finished trials still transient after retries; same rule.

budget:
  maxCostUsd: 1                            # Cap on the spend the tool counts (data-model §Cap Check). Omitted: 1. null: no cap.

estimate:                                  # Assumptions when no previous run exists (data-model §Cost).
  outputTokens: 600                        # Output tokens per trial, reasoning included. Use the service's usual answer length.
                                           # It usually decides a first run's expected cost; the first batch re-estimates it.
                                           # Also the floor of the reservation's output when the output limit is unknown.
  # inputTokens: 4000                      # Required when the adapter cannot render or the service uses stored prompts.

report:
  lowBaseline: 0.9                         # Cells whose baseline compliance is lower are listed separately (not gated).
  samples: 3                               # Failing examples per regressed cell in the result page.
  warn:                                    # Metric warning thresholds, compared with point estimates; never affect the exit code.
    transientRate: 0.05
    discardRateIncrease: 0.01              # Candidate discard rate minus baseline.
    regenerationRateIncrease: 0.03         # Candidate regeneration rate minus baseline.
    latencyP95Ratio: 1.5
    costRatio: 2.0

output:
  dir: .model-eval                         # Runs, comparisons and result pages. init adds it to .gitignore.

redact:                                    # Applied to every written surface of FR-031. Not applied to raw trial records.
  - { pattern: "\\b01[0-9]-?\\d{3,4}-?\\d{4}\\b", replace: "<phone>" }   # replace must not be empty, so readers see that text was removed.
```

- Relative paths (`adapter.cwd`, `files` globs, `output.dir`) resolve from the config file's folder, so every working directory points to the same files and resume starts the same adapter (`launchHash`).

## Rule Files

`rules/*.yaml`:

```yaml
rules:
  - id: completed
    title: The user gets a complete answer from the model
    severity: blocking
    scope: global
    check: { type: completed }             # Surface trial. Rejections, time-outs, cuts, empty answers, discards and fallbacks fail.

  - id: script-ko
    title: Korean answers use only Hangul and Latin letters
    severity: blocking
    scope: global
    languages: [ko]
    check:
      type: script
      allow: [Hangul, Latin, Common, Inherited]
      ignoreFrom: input.nickname           # The nickname's own spelling is allowed; missing means an empty list.
    origin:
      - { commit: 1a2b3c4, date: 2026-01-15, layer: code }

  - id: script-ja
    title: Japanese answers use only kana, kanji and Latin letters
    severity: blocking
    scope: global
    languages: [ja]
    check:
      type: script
      allow: [Hiragana, Katakana, Han, Latin, Common, Inherited]
      ignoreFrom: input.nickname
    anchors:
      - { lang: ja, quote: "日本語だけで話す" }

  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    anchors:
      - { lang: ko, quote: "이모지를 붙이지 않는다" }
      - { lang: en, quote: "Never use emoji" }
    check: { type: emoji }

  - id: banmal-ko
    title: Korean answers use the casual speech level
    severity: major
    scope: global
    languages: [ko]
    check:
      type: pattern
      regex: "((?<![필중])요|습니다|세요)[.?!]*$"
      flags: m
      mode: forbid
    examples:                              # Lint runs the check on these (FR-005).
      pass: ["오늘 어땠어?", "그건 필요.", "그게 중요."]   # Nouns ending in 요 would be caught here.
      fail: ["오늘 어땠어요?", "좋습니다.", "필요해요."]

  - id: mood-not-revealed
    title: Does not name the mood picked in the app during small talk
    severity: major
    check: { type: phrases, mode: forbid, anyFrom: params.words }   # Lint error when a case omits words.
    examples:
      params: { words: [짜증] }
      pass: ["오늘 좀 그랬구나. 무슨 일 있었어?"]
      fail: ["오늘 짜증 골랐더라."]

  - id: no-unprompted-self-state
    title: Does not describe its own clothes, room or activity before being asked
    severity: major
    check: { type: review, samples: 3 }    # Judged by people in the side-by-side view.

  - id: no-example-copy
    title: Does not copy the prompt's example lines
    severity: minor
    scope: global
    languages: [ko]
    check:
      type: overlap
      with: ["나라면 조용한 부분부터 다시 들을래"]
      minChars: 10
```

## Case Files

`cases/**/*.yaml`:

```yaml
cases:
  - id: greet-ko
    target: chat
    lang: ko                               # Required when the target has several languages.
    provenance: synthetic
    input:
      nickname: 하늘
      user: 안녕
      state: { wearing: [목도리] }
    note: A plain greeting. Every global rule applies.

  - id: mood-vague-ko
    target: chat
    lang: ko
    provenance: synthetic
    input:
      user: 나 오늘 좀 그래
      mood: { label: 짜증 }
    rules:
      - { id: mood-not-revealed, params: { words: [짜증] } }
      - no-unprompted-self-state
    note: A vague remark without naming a mood; does the answer name the picked mood? Without a nickname, script-ko uses an empty list.
```

- The target's input schema, declared by the adapter, decides the shape of `input`. `nickname`, `state` and `mood` are fields of the example adapter.
- `provenance: derived` cases may only live in paths git does not track and `.gitignore` ignores (lint `derived-tracked`).
- Gated cells should have 10 or more cases per language, and 30 for the default settings. Lint reports fewer as `few-cases`, and planned trials below the margin's minimum as `margin-unreachable`.
