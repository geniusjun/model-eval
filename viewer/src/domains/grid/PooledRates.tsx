import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { NONE, percent, points } from '../../../../src/report/format.js';
import type { Aggregate } from '../../../../src/report/schema.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { ROLES } from '../../report/variants.js';
import styles from './ReferenceTables.module.css';
import tableStyles from './table.module.css';

type Pooled = Aggregate['baseline'];

interface PooledRatesProps {
  readonly aggregates: readonly Aggregate[];
  readonly lang: Lang;
}

/** `99.3% (149 of 150)`. */
function pooledText(pooled: Pooled, messages: Messages): string {
  const counts = messages.text('grid.countOf', { count: pooled.passes, total: pooled.trials });
  return `${percent(pooled.rate)} (${counts})`;
}

/**
 * Each rule's rate pooled over languages per surface; for reference, so it has no verdict and
 * starts closed.
 */
export function PooledRates({ aggregates, lang }: PooledRatesProps) {
  const messages = pageMessages(lang);
  const headingId = useId();
  return (
    <section className={styles.reference} aria-labelledby={headingId}>
      <h3 id={headingId}>{messages.text('grid.pooled.heading')}</h3>
      <p className={styles.intro}>{messages.text('grid.pooled.intro')}</p>
      <Disclosure label={messages.text('grid.pooled.show', { count: aggregates.length })}>
        <table
          className={[tableStyles.table, tableStyles.minor].filter(Boolean).join(' ')}
          aria-labelledby={headingId}
        >
          <thead>
            <tr>
              <th scope="col">{messages.text('grid.column.rule')}</th>
              <th scope="col">{messages.text('grid.column.surface')}</th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className={tableStyles.number}>
                  {messages.text(`role.${role}`)}
                </th>
              ))}
              <th scope="col" className={tableStyles.number}>
                {messages.text('grid.column.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {aggregates.map((aggregate) => (
              <tr key={`${aggregate.ruleId}/${aggregate.surface}`}>
                <th scope="row">{aggregate.ruleId}</th>
                <td>{aggregate.surface}</td>
                {ROLES.map((role) => (
                  <td key={role} className={tableStyles.number}>
                    {pooledText(aggregate[role], messages)}
                  </td>
                ))}
                <td className={tableStyles.number}>
                  {aggregate.diff === null ? NONE : points(aggregate.diff)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>
    </section>
  );
}
