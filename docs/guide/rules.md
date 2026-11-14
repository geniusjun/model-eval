# Writing rules and cases

A rule is one thing your prompt or post-processing promises, written as a check the tool can run
on an answer. A case is one input to your service. Every applicable rule is graded on every answer
to every case, so one case serves many rules.

Rules go in `rules/**/*.yaml` and cases in `cases/**/*.yaml` by default (`files` in the config).
`lint` validates them against [`schemas/rules.schema.json`](../../schemas/rules.schema.json) and
[`schemas/cases.schema.json`](../../schemas/cases.schema.json) and reports each problem with file,
line and column.

## Start with three rules

Begin with checks nobody can argue with:

```yaml
rules:
  - id: completed
    title: The user gets a complete answer from the model
    severity: blocking
    scope: global
    check: { type: completed }

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
      - { lang: ja, quote: '日本語だけで話す' }

  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    check: { type: emoji }
```

- `completed` fails a trial when the user did not get a complete model answer: rejections,
  time-outs, cut or empty answers, discards and fallbacks. Without it, a candidate that fails to
  answer cannot block.
- `script-ja` catches words from another language mixed into a Japanese answer.
- `no-emoji` fails on any emoji.

Every check type and its fields are in the [checks reference](../reference/checks.md).

## Fields that decide what is judged

| Field       | Default       | Meaning                                                                                                     |
| ----------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `severity`  | required      | `blocking`, `major` or `minor`. The gate judges the severities in `gate.severities`                         |
| `scope`     | `listed`      | `global` applies to every case of a matching target and language; `listed` only where a case names the rule |
| `languages` | all           | Languages the rule applies to                                                                               |
| `targets`   | all           | Targets the rule applies to                                                                                 |
| `gateOn`    | `raw`         | Surface the gate reads: `raw`, `final` or `both`. `completed` always uses `trial`                           |
| `margin`    | `gate.margin` | How much compliance may drop before the rule counts as worse, 0 to 1                                        |
| `status`    | `active`      | `retired` rules are not run, graded or anchor-checked                                                       |

Every rule is graded on the raw answer and on the shipped text, and the report shows both. The
gate reads `raw` by default: post-processing that strips other scripts or emoji would make a rule
hold on the shipped text however often the model breaks it. Use `gateOn: final` for rules whose
accepted fix is post-processing or regeneration, where only what the user sees matters.

`origin` records where a rule came from (`commit`, `date`, `layer`: `prompt`, `code` or
`pipeline`). It is shown in the report and never used for grading.

## Anchors

An anchor is the prompt sentence a rule relies on:

```yaml
anchors:
  - { lang: ko, quote: '이모지를 붙이지 않는다' }
  - { lang: en, quote: 'Never use emoji' }
```

`lint --render` renders the prompt of every case and variant and reports a quote that does not
appear as `anchor-missing`. If a prompt edit removes the sentence, the rule loses its basis, and
lint says so before any model is called.

The Pogo example has a missing anchor on purpose: its English prompt says "Do not use emoji".
Lint reports it once, with the variants and cases that miss it (case list shortened):

```text
warning: rules/pogo.yaml:40:9: no-emoji (en): The rendered prompt does not contain "Never use emoji". (variants: current, next · cases: greet-en, mood-vague-en, …)
```

Rules without an anchor, such as fixes made in code, are reported as `unanchored` info and do not
count as warnings.

## Examples

Give each check texts it must pass and fail. `lint` runs the check on them, so a wrong regex shows
up before it grades anything:

```yaml
- id: banmal-ko
  title: Korean answers use the casual speech level
  severity: major
  scope: global
  languages: [ko]
  check:
    type: pattern
    regex: '((?<![필중])요|습니다|세요)[.?!]*$'
    flags: m
    mode: forbid
  examples:
    pass: ['오늘 어땠어?', '그건 필요.', '그게 중요.']
    fail: ['오늘 어땠어요?', '좋습니다.', '필요해요.']
```

Adding `'고마워요.'` to `pass` gives:

```text
error: rules/pogo.yaml:54:45: banmal-ko: The example "고마워요." should pass but does not.
```

For checks that read case values, `examples.input` and `examples.params` supply them.

## Values from the case

Fields ending in `From` read a value from the case by path: `input.<key>` from its input,
`params.<key>` from the values the case gives the rule. What happens when the value is missing:
[checks reference](../reference/checks.md#values-from-the-case).

```yaml
# rules/pogo.yaml
- id: mood-not-revealed
  title: Does not name the mood picked in the app during small talk
  severity: major
  check: { type: phrases, mode: forbid, anyFrom: params.words }

# cases/ko.yaml
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
```

## Rules that people judge

Some promises cannot be checked by a program, such as "does not describe its own clothes before
being asked". Write them as `review` rules:

```yaml
- id: no-unprompted-self-state
  title: Does not describe its own clothes, room or activity before being asked
  severity: major
  check: { type: review, samples: 3 }
```

A `review` rule is never graded and never gated. The comparison keeps baseline and candidate
answers to the same cases under `samples.review` in `comparison.json`, and the result page shows
them side by side ([`review`](../reference/checks.md#review)).

## Cases

```yaml
cases:
  - id: greet-ja
    target: chat
    lang: ja
    provenance: synthetic
    input:
      nickname: ソラ
      user: こんにちは
      state: { wearing: [マフラー] }
    note: A plain greeting. Every global rule applies.
```

- `input` must match the input schema the adapter declares for the target.
- `lang` is required when the target has more than one language. Each case belongs to one
  language, and each language is judged on its own cases.
- `provenance` is `synthetic` for made-up input or `derived` for input made from real user data.
  A `derived` case file must be ignored by git; lint reports a tracked or unignored one as
  `derived-tracked`.
- `rules` lists the `listed` rules to grade on this case, with per-case `params`.

## How many cases

Write at least 10 cases per language for every gated rule, and 30 to use the default settings.
With 30 cases, 5 repeats, margin 0.10 and 95% confidence, an unchanged candidate passes a cell
about 94% of the time and a 30-point drop is caught about 97% of the time.

A gated cell is one rule in one language on one surface. Lint and `--dry-run` warn when one has
too few:

- `few-cases`: fewer than 10 cases; such a cell seldom blocks, even when the rule collapses.
- `margin-unreachable`: fewer planned trials than the margin needs (35 for a margin of 0.10),
  so equal compliance cannot pass.

[Reading the results](statistics.md#verdicts) explains these numbers.

## Running lint

```bash
model-eval lint                    # files, references, examples, case inputs, sample plan
model-eval lint --render           # also renders every case and checks anchors
model-eval lint --render --max-warnings 0
```

Lint exits 1 on errors, or on warnings above `--max-warnings`, and 4 when the adapter fails to
start or breaks the protocol (`adapter-failed`). Info findings never count. The full list of codes
is in [data-model §Validation Rules](../../specs/001-swap-check/data-model.md#validation-rules).
