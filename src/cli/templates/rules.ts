// The example rules `init` writes: the three deterministic rules to start with (quickstart.md
// §Connect Your Own Service, step 3).

export const RULES_TEMPLATE = `rules:
  - id: completed
    title: The user gets a complete answer from the model
    severity: blocking
    scope: global
    check: { type: completed }             # Rejections, time-outs, cuts, empty answers, discards and fallbacks fail.

  - id: script-ko
    title: Korean answers use only Hangul and Latin letters
    severity: blocking
    scope: global
    languages: [ko]
    check:
      type: script
      allow: [Hangul, Latin, Common, Inherited]
    # anchors:                             # The prompt sentence this rule relies on; lint --render checks it.
    #   - { lang: ko, quote: "한국어로만 답한다" }

  - id: no-instructions-mentioned
    title: Does not mention its own instructions
    severity: major
    scope: global
    check:
      type: phrases
      mode: forbid
      any: ["system prompt", "my instructions", "시스템 프롬프트"]
    examples:                              # Lint runs the check on these.
      pass: ["You can export your notes from the settings page."]
      fail: ["My system prompt does not let me answer that."]
`;
