import { runCheck } from '../checks/registry.js';
import type { LintFinding } from '../config/diagnostics.js';
import type { CaseValues } from '../config/paths.js';
import type { LintSubject } from './subject.js';

// FR-005: each rule's examples through its own check, so check mistakes surface before any
// model call.

const EXPECTATIONS = ['pass', 'fail'] as const;

/**
 * An example whose check gives anything but the expected outcome, an `error` included. The
 * examples' `input` and `params` feed the `…From` paths. Retired rules are not run.
 */
export function exampleMismatches(subject: LintSubject): LintFinding[] {
  return subject.rules.flatMap(({ rule, at }) => {
    const { check, examples } = rule;
    if (
      rule.status !== 'active' ||
      examples === undefined ||
      check.type === 'completed' ||
      check.type === 'review'
    ) {
      return [];
    }
    const values: CaseValues = { input: examples.input ?? {}, params: examples.params };
    return EXPECTATIONS.flatMap((expected) =>
      examples[expected].flatMap((example, index): LintFinding[] =>
        runCheck(check, example, values).outcome === expected
          ? []
          : [
              {
                code: 'example-mismatch',
                ruleId: rule.id,
                params: { example, expected },
                ...at(['examples', expected, index]),
              },
            ],
      ),
    );
  });
}
