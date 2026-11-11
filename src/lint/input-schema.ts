import { compileSchema, schemaErrorText } from '../checks/json-schema.js';
import type { LintFinding } from '../config/diagnostics.js';
import type { LintSubject } from './subject.js';

// FR-002: each case input against its target's `inputSchema`, which the tool validates with and
// never interprets (data-model §Target).

/**
 * `input-schema` per case whose input its target's schema rejects. A schema that does not compile
 * breaks the protocol, so it is `adapter-failed`. Without adapter targets nothing is checked.
 */
export function inputSchemaFindings(subject: LintSubject): LintFinding[] {
  const validators = new Map(
    (subject.targets ?? []).map((target) => [target, compileSchema(target.inputSchema)]),
  );
  const broken = [...validators].flatMap(([target, compiled]): LintFinding[] =>
    compiled.ok
      ? []
      : [
          {
            code: 'adapter-failed',
            params: {
              detail: `the inputSchema of target ${target.name} does not compile: ${compiled.detail}`,
            },
            ...subject.configAt(['adapter', 'command']),
          },
        ],
  );
  const rejected = subject.cases.flatMap(({ definition, target, at }): LintFinding[] => {
    const compiled = target === undefined ? undefined : validators.get(target);
    if (compiled?.ok !== true || compiled.validate(definition.input)) {
      return [];
    }
    return [
      {
        code: 'input-schema',
        params: {
          target: definition.target,
          detail: (compiled.validate.errors ?? []).map(schemaErrorText).join('; '),
        },
        caseIds: [definition.id],
        ...at(['input']),
      },
    ];
  });
  return [...broken, ...rejected];
}
