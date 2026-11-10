import type { RuleInput } from './project.js';

// Rules the e2e projects share. The completion rule is called `answered` so that its ID never
// collides with an English word in human output.

export const ANSWERED: RuleInput = {
  id: 'answered',
  title: 'The user gets a complete answer from the model',
  severity: 'blocking',
  scope: 'global',
  check: { type: 'completed' },
};

export const SCRIPT_JA_QUOTE = '日本語だけで話す';

export const SCRIPT_JA: RuleInput = {
  id: 'script-ja',
  title: 'Japanese answers use only kana, kanji and Latin letters',
  severity: 'blocking',
  scope: 'global',
  languages: ['ja'],
  check: { type: 'script', allow: ['Hiragana', 'Katakana', 'Han', 'Latin', 'Common', 'Inherited'] },
  anchors: [{ lang: 'ja', quote: SCRIPT_JA_QUOTE }],
};

export const NO_EMOJI: RuleInput = {
  id: 'no-emoji',
  title: 'No emoji',
  severity: 'major',
  scope: 'global',
  check: { type: 'emoji' },
};

export const SELF_STATE_REVIEW: RuleInput = {
  id: 'no-unprompted-self-state',
  title: 'Does not describe its own clothes, room or activity before being asked',
  severity: 'major',
  scope: 'global',
  check: { type: 'review', samples: 1 },
};

/** The same rule with another severity, for example to put it in the gate. */
export function withSeverity(rule: RuleInput, severity: RuleInput['severity']): RuleInput {
  return { ...rule, severity };
}
