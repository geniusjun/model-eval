import type { Comparison, Samples, SampleText } from '../../../src/report/schema.js';
import { loadComparison } from '../fixtures.js';

export const REVIEW_RULE = 'no-unprompted-self-state';
export const FAILING_RULE = 'script-ja';
const ROLES = ['baseline', 'candidate'] as const;

type Key = Samples['review'][number]['keys'][number];

/** The stored text of a key: its raw and final answer name the key. */
export function answer(key: Key): SampleText {
  return {
    ...key,
    raw: `${key.variant} ${key.caseId} ${String(key.repeat)}`,
    finalKind: 'model',
    final: `${key.variant} ${key.caseId} ${String(key.repeat)} final`,
    finishReason: 'stop',
  };
}

function bothVariants(caseId: string, repeat: number): Key[] {
  return ROLES.map((variant) => ({ variant, caseId, repeat }));
}

/**
 * The block fixture with two cases and two repeats for the review rule, and failing examples of
 * script-ja in two cells that share one (case, repeat) pair. Keys are listed out of order.
 */
export function derivedComparison(): Comparison {
  const comparison = loadComparison('block');
  const reviewKeys = [
    ...bothVariants('mood-vague-ko', 1),
    ...bothVariants('mood-busy-ko', 0),
    ...bothVariants('mood-vague-ko', 0),
    ...bothVariants('mood-busy-ko', 1),
  ];
  const failingRaw: Key[] = [
    { variant: 'candidate', caseId: 'greet-ja', repeat: 1 },
    { variant: 'candidate', caseId: 'ask-ja', repeat: 0 },
    { variant: 'candidate', caseId: 'greet-ja', repeat: 0 },
  ];
  const failingFinal: Key[] = [
    { variant: 'candidate', caseId: 'ask-ja', repeat: 1 },
    { variant: 'candidate', caseId: 'greet-ja', repeat: 1 },
  ];
  const failingPairs = [...failingRaw, ...failingFinal].flatMap(({ caseId, repeat }) =>
    bothVariants(caseId, repeat),
  );
  const unique = new Map(
    [...reviewKeys, ...failingPairs].map((key) => [JSON.stringify(key), key] as const),
  );
  comparison.samples = {
    texts: [...unique.values()].map(answer),
    review: [{ ruleId: REVIEW_RULE, keys: reviewKeys }],
    failing: [
      { ruleId: FAILING_RULE, lang: 'ja', surface: 'raw', keys: failingRaw },
      { ruleId: FAILING_RULE, lang: 'ja', surface: 'final', keys: failingFinal },
    ],
  };
  return comparison;
}
