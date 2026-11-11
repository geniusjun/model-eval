import type { Diagnostic, Level } from '../../config/diagnostics.js';
import type { Lang } from '../../config/schema.js';
import type { MessageKey } from '../../messages/index.js';
import {
  counted,
  lintText,
  placeLabel,
  positionLabel,
  quote,
  textOf,
  withPlace,
  type Text,
} from './text.js';

// Human output of `lint`: one line per finding, errors first and info last, then the counts.

const LEVELS: readonly Level[] = ['error', 'warning', 'info'];

const LEVEL_KEYS: Readonly<Record<Level, MessageKey>> = {
  error: 'human.lint.error',
  warning: 'human.warning',
  info: 'human.lint.info',
};

/** Adapter messages are shown quoted, as everywhere adapter text reaches the terminal. */
function detailText(finding: Diagnostic): string | undefined {
  if (finding.code === 'adapter-failed' || finding.code === 'render-failed') {
    return quote(finding.params.detail);
  }
  return finding.localDetail;
}

/** The variants and cases a finding names, in parentheses after its text. */
function scopeText(t: Text, finding: Diagnostic): string {
  const parts = [
    ...(finding.variants === undefined
      ? []
      : [t('human.lint.variants', { variants: finding.variants.join(', ') })]),
    ...(finding.caseIds === undefined
      ? []
      : [t('human.lint.cases', { cases: finding.caseIds.join(', ') })]),
  ];
  return parts.length === 0 ? '' : ` (${parts.join(' · ')})`;
}

function findingLine(t: Text, finding: Diagnostic): string {
  const text = withPlace(
    positionLabel(finding),
    withPlace(placeLabel(finding), lintText(t, finding, detailText(finding))),
  );
  return t(LEVEL_KEYS[finding.level], { text: `${text}${scopeText(t, finding)}` });
}

/** `maxWarnings` is `--max-warnings`, `null` without a limit. */
export function lintLines(
  lang: Lang,
  findings: readonly Diagnostic[],
  maxWarnings: number | null,
): string[] {
  const t = textOf(lang);
  const count = (level: Level): number =>
    findings.filter((finding) => finding.level === level).length;
  const warnings = count('warning');
  return [
    ...LEVELS.flatMap((level) =>
      findings
        .filter((finding) => finding.level === level)
        .map((finding) => findingLine(t, finding)),
    ),
    t('human.lint.summary', { errors: count('error'), warnings, info: count('info') }),
    ...(maxWarnings !== null && warnings > maxWarnings
      ? [counted(t, 'human.lint.overLimit', warnings, { warnings, max: maxWarnings })]
      : []),
  ];
}
