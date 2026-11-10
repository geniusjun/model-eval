import { z } from 'zod';

import { bareFinding, excludedCauseSchema, finding } from './finding.js';
import { surfaceSchema } from './schema.js';

/** Lint codes of data-model §Validation Rules. */
export const lintCodeSchema = z.enum([
  'schema',
  'duplicate-id',
  'unknown-rule',
  'input-schema',
  'missing-lang',
  'unresolved-ref',
  'derived-tracked',
  'example-mismatch',
  'adapter-failed',
  'render-failed',
  'anchor-missing',
  'rule-without-case',
  'rule-filter-mismatch',
  'completed-not-gated',
  'language-gap',
  'few-cases',
  'margin-unreachable',
  'excluded-from-gate',
  'vcs-unknown',
  'helper-outdated',
  'unanchored',
]);

export type LintCode = z.infer<typeof lintCodeSchema>;
export type Level = 'error' | 'warning' | 'info';

export const LINT_LEVELS: Readonly<Record<LintCode, Level>> = {
  schema: 'error',
  'duplicate-id': 'error',
  'unknown-rule': 'error',
  'input-schema': 'error',
  'missing-lang': 'error',
  'unresolved-ref': 'error',
  'derived-tracked': 'error',
  'example-mismatch': 'error',
  'adapter-failed': 'error',
  'render-failed': 'error',
  'anchor-missing': 'warning',
  'rule-without-case': 'warning',
  'rule-filter-mismatch': 'warning',
  'completed-not-gated': 'warning',
  'language-gap': 'warning',
  'few-cases': 'warning',
  'margin-unreachable': 'warning',
  'excluded-from-gate': 'warning',
  'vcs-unknown': 'warning',
  'helper-outdated': 'warning',
  unanchored: 'info',
};

const text = z.string();

/** Each lint code with the params of its data-model §Validation Rules row. */
export const lintFindingSchema = z
  .discriminatedUnion('code', [
    finding('schema', z.object({ path: text, detail: text })),
    finding(
      'duplicate-id',
      z.object({ kind: z.enum(['rule', 'case', 'variant']), id: z.string().min(1) }),
    ),
    bareFinding('unknown-rule'),
    finding('input-schema', z.object({ target: z.string().min(1), detail: text })),
    finding('missing-lang', z.object({ target: z.string().min(1) })),
    finding('unresolved-ref', z.object({ path: z.string().min(1) })),
    finding('derived-tracked', z.object({ cause: z.enum(['tracked', 'not-ignored']) })),
    finding('example-mismatch', z.object({ example: text, expected: z.enum(['pass', 'fail']) })),
    finding('adapter-failed', z.object({ detail: text })),
    finding('render-failed', z.object({ detail: text })),
    finding('anchor-missing', z.object({ quote: text })),
    bareFinding('rule-without-case'),
    bareFinding('rule-filter-mismatch'),
    finding('completed-not-gated', z.object({ cause: z.enum(['no-rule', 'not-gated']) })),
    bareFinding('language-gap'),
    finding('few-cases', z.object({ surface: surfaceSchema, cases: z.int().min(0) })),
    finding(
      'margin-unreachable',
      z.object({
        surface: surfaceSchema,
        plannedTrials: z.int().min(0),
        nMin: z.int().min(1),
        margin: z.number().gt(0).lt(1),
      }),
    ),
    finding('excluded-from-gate', z.object({ cause: excludedCauseSchema })),
    bareFinding('vcs-unknown'),
    finding(
      'helper-outdated',
      z.object({ version: z.string().min(1), bundled: z.string().min(1) }),
    ),
    bareFinding('unanchored'),
  ])
  .meta({ id: 'LintFinding' });

export type LintFinding = z.infer<typeof lintFindingSchema>;

export type Diagnostic = LintFinding & {
  readonly level: Level;
  /**
   * The validator's detail in the `--lang` language, for human output only. `--json` writes
   * `params.detail`, which stays English so JSON output does not depend on `--lang`.
   */
  readonly localDetail?: string;
};

export function diagnostic(finding: LintFinding, localDetail?: string): Diagnostic {
  const level = LINT_LEVELS[finding.code];
  return localDetail === undefined ? { ...finding, level } : { ...finding, level, localDetail };
}

/** The finding as `--json` writes it. */
export function toFinding({
  level: _level,
  localDetail: _localDetail,
  ...finding
}: Diagnostic): LintFinding {
  return finding;
}
