import type { Lang } from '../../../src/config/schema.js';
import { verdictText } from '../../../src/report/code-text.js';
import type { Verdict } from '../../../src/report/schema.js';
import styles from './VerdictBadge.module.css';

const VERDICT_CLASS: Readonly<Record<Verdict, string | undefined>> = {
  improved: styles.improved,
  'non-inferior': styles['non-inferior'],
  regressed: styles.regressed,
  inconclusive: styles.inconclusive,
  insufficient: styles.insufficient,
  'not-applicable': styles['not-applicable'],
};

interface VerdictBadgeProps {
  readonly verdict: Verdict;
  readonly lang: Lang;
}

/** The verdict as text and colour, so it reads without colour too (FR-003). */
export function VerdictBadge({ verdict, lang }: VerdictBadgeProps) {
  const className = [styles.badge, VERDICT_CLASS[verdict]].filter(Boolean).join(' ');
  return <span className={className}>{verdictText(lang, verdict)}</span>;
}
