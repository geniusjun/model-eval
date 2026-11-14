import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { Shape } from '../../components/Shape.js';
import { pageMessages } from '../../i18n/useMessages.js';
import styles from './WithheldBanner.module.css';

interface WithheldBannerProps {
  readonly comparison: Pick<Comparison, 'baseline' | 'candidate' | 'gate'>;
  readonly lang: Lang;
}

/**
 * Shown at the top of the page when a compared run is not `complete`. The gate then always
 * carries a `partial-run` reason (001 data-model §Gate, row 1), whose text names each unfinished
 * variant with its status and stop reason.
 */
export function WithheldBanner({ comparison, lang }: WithheldBannerProps) {
  const titleId = useId();
  const { baseline, candidate, gate } = comparison;
  const hasUnfinishedRun = [baseline, candidate].some((run) => run.status !== 'complete');
  if (!hasUnfinishedRun) {
    return null;
  }
  const messages = pageMessages(lang);
  const reason = gate.reasons.find((candidateReason) => candidateReason.code === 'partial-run');
  return (
    <section className={styles.banner} aria-labelledby={titleId}>
      <p id={titleId} className={styles.title}>
        <Shape kind="square" />
        {messages.text('summary.withheld')}
      </p>
      {reason !== undefined && <p className={styles.reason}>{messages.reason(reason)}</p>}
    </section>
  );
}
