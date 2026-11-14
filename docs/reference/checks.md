# Checks reference

A rule has exactly one `check`, selected by `type`. Full definitions are in
[data-model §Check](../../specs/001-swap-check/data-model.md#check). The schema is the `check`
property in [`schemas/rules.schema.json`](../../schemas/rules.schema.json).

| `type`              | Surfaces          | Fails when                                                    |
| ------------------- | ----------------- | ------------------------------------------------------------- |
| `script`            | raw, final        | A character of a script not allowed appears                   |
| `emoji`             | raw, final        | An emoji appears                                              |
| `pattern`           | raw, final        | A regex matches (`forbid`) or does not (`require`)            |
| `phrases`           | raw, final        | A listed phrase appears (`forbid`) or none does (`require`)   |
| `overlap`           | raw, final        | The answer shares a long enough run of text with a given text |
| `length`            | raw, final        | The length is outside a range                                 |
| `json`              | raw, final        | The answer is not JSON or violates a schema                   |
| `all`, `any`, `not` | as their children | Logical combination of the checks above                       |
| `completed`         | trial             | The user did not get a complete model answer                  |
| `review`            | none              | Never; collects answers for people to compare                 |

Text checks grade the raw answer and the shipped text separately. They skip an empty raw answer;
`completed` catches it instead.

## Values from the case

Fields ending in `From` (`ignoreFrom`, `anyFrom`, `withFrom`) take a path into the case:

- `input.<key>…` reads the case input.
- `params.<key>…` reads the `params` the case gives this rule.

A string value counts as a one-item list.

| Field        | Value missing from the case                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `ignoreFrom` | Empty list                                                                                          |
| `withFrom`   | Empty list                                                                                          |
| `anyFrom`    | Lint error `unresolved-ref`; empty strings are dropped, and a list with none left is the same error |

## `script`

```yaml
check:
  type: script
  allow: [Hangul, Latin, Common, Inherited]
  ignoreFrom: input.nickname
```

| Field        | Required | Meaning                                                   |
| ------------ | -------- | --------------------------------------------------------- |
| `allow`      | yes      | Unicode script names that may appear                      |
| `ignore`     | no       | Strings removed from the text before checking             |
| `ignoreFrom` | no       | Path to case values removed from the text before checking |

Each code point is checked by its Unicode `Script` property, not `Script_Extensions`.
Punctuation and digits are `Common`; combining marks are `Inherited`. List both unless the rule is
about them. Evidence is the characters that failed.

## `emoji`

```yaml
check: { type: emoji }
```

Fails when a character with the `Extended_Pictographic` property appears. Kaomoji such as `(^^)`
are not caught; ©, ™ and ♥ (U+00A9, U+2122, U+2665) are.

## `pattern`

```yaml
check:
  type: pattern
  regex: '((?<![필중])요|습니다|세요)[.?!]*$'
  flags: m
  mode: forbid
```

| Field   | Required | Meaning                                                  |
| ------- | -------- | -------------------------------------------------------- |
| `regex` | yes      | JavaScript regular expression, always compiled with `u`  |
| `flags` | no       | Any of `i`, `m`, `s`. `g` and `y` are rejected           |
| `mode`  | yes      | `forbid`: fails on a match. `require`: fails without one |

## `phrases`

```yaml
check: { type: phrases, mode: forbid, anyFrom: params.words }
```

| Field       | Required           | Meaning                                                                |
| ----------- | ------------------ | ---------------------------------------------------------------------- |
| `any`       | `any` or `anyFrom` | Phrases                                                                |
| `anyFrom`   | `any` or `anyFrom` | Path to case values with more phrases                                  |
| `mode`      | yes                | `forbid`: fails when a phrase appears. `require`: fails when none does |
| `normalize` | no, default `true` | NFKC-normalise and lower-case both sides before matching               |

Phrases match as substrings. With `normalize: false` they match verbatim.

## `overlap`

```yaml
check:
  type: overlap
  with: ['나라면 조용한 부분부터 다시 들을래']
  minChars: 10
```

| Field      | Required             | Meaning                                         |
| ---------- | -------------------- | ----------------------------------------------- |
| `with`     | `with` or `withFrom` | Texts the answer must not copy                  |
| `withFrom` | `with` or `withFrom` | Path to case values with more texts             |
| `minChars` | yes                  | Shortest shared run, in code points, that fails |

Use it to catch an answer that repeats an example line of the prompt. Both sides are
NFKC-normalised with all whitespace removed. The check fails when their longest common substring
has at least `minChars` code points.

## `length`

```yaml
check: { type: length, max: 200, unit: graphemes }
```

| Field  | Required       | Meaning                                                                   |
| ------ | -------------- | ------------------------------------------------------------------------- |
| `min`  | `min` or `max` | Shortest allowed length                                                   |
| `max`  | `min` or `max` | Longest allowed length                                                    |
| `unit` | yes            | `chars` counts code points; `graphemes` counts extended grapheme clusters |

Evidence is the measured length.

## `json`

```yaml
check:
  type: json
  schema:
    type: object
    required: [reply]
    properties: { reply: { type: string } }
```

Fails when the answer does not parse as JSON, or when it violates `schema` (JSON Schema draft
2020-12). Without `schema`, any valid JSON passes. Evidence lists each violation by instance path.

## `all`, `any`, `not`

```yaml
check:
  type: any
  checks:
    - { type: phrases, mode: require, any: ['?'] }
    - { type: length, max: 40, unit: graphemes }
```

`all` passes when every check in `checks` passes, `any` when at least one does, and `not` when its
`check` fails. They can contain each other and every text check, but not `completed` or `review`.

## `completed`

```yaml
check: { type: completed }
```

Graded once per trial on the surface `trial`, from the shipped result. It fails on:

- rejections and time-outs;
- empty answers and empty shipped text;
- discards and fallbacks;
- answers that did not finish with `stop`.

Transient and adapter errors are left out, unless one variant fails a case this way every time
while the other answers it. Those count as systematic failures. Full table:
[data-model §Trial Outcomes](../../specs/001-swap-check/data-model.md#trial-outcomes).

Gate on a `completed` rule, or a candidate that fails to answer cannot block. Lint warns with
`completed-not-gated` when a gate exists without one.

## `review`

```yaml
check: { type: review, samples: 3 }
```

Never graded and never gated. The comparison stores baseline and candidate answers to the same
cases for people to read side by side: `samples` per case (default 3, from the lowest repeats),
raw and shipped. A `review` rule of a gated severity is left out of the gate with the warning
`excluded-from-gate`.

## Examples

Every check except `completed` and `review` can carry examples, which lint runs:

```yaml
examples:
  params: { words: [짜증] }
  pass: ['오늘 좀 그랬구나. 무슨 일 있었어?']
  fail: ['오늘 짜증 골랐더라.']
```

`input` and `params` supply values for `From` fields. A mismatch is the lint error
`example-mismatch`.
