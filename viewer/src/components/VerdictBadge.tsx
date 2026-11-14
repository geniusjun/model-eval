import type { Lang } from '../../../src/config/schema.js';
import { verdictText } from '../../../src/report/code-text.js';
import type { Verdict } from '../../../src/report/schema.js';
import { Shape, VERDICT_SHAPE } from './Shape.js';
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
  /**
   * Drops the fill of every verdict but regressed, for places where only a drop should catch the
   * eye, such as the grid. The word and the shape stay.
   */
  readonly quiet?: boolean;
  /** Shows only the shape; the word stays for assistive technology. */
  readonly shapeOnly?: boolean;
}

/**
 * The verdict as text, shape and colour, so it reads without colour too (FR-003). Held is a
 * quiet word with its equals sign, no outline or fill, so the cells that changed stand out.
 */
export function VerdictBadge({
  verdict,
  lang,
  quiet = false,
  shapeOnly = false,
}: VerdictBadgeProps) {
  const className = [
    styles.badge,
    VERDICT_CLASS[verdict],
    quiet && verdict !== 'regressed' ? styles.quiet : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={className}>
      <Shape kind={VERDICT_SHAPE[verdict]} />
      {shapeOnly ? (
        <span className={styles.hidden}>{verdictText(lang, verdict)}</span>
      ) : (
        verdictText(lang, verdict)
      )}
    </span>
  );
}
