import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { NONE, percent, points } from '../../../../src/report/format.js';
import type { Aggregate } from '../../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { ROLES, type VariantIds } from '../../report/variants.js';
import tableStyles from './table.module.css';

type Pooled = Aggregate['baseline'];

interface PooledRatesProps {
  readonly aggregates: readonly Aggregate[];
  readonly variants: VariantIds;
  readonly lang: Lang;
}

/** `99.3% (149 of 150)`. */
function pooledText(pooled: Pooled, messages: Messages): string {
  const counts = messages.text('grid.countOf', { count: pooled.passes, total: pooled.trials });
  return `${percent(pooled.rate)} (${counts})`;
}

/** Each rule's rate pooled over languages per surface; for reference, so it has no verdict. */
export function PooledRates({ aggregates, variants, lang }: PooledRatesProps) {
  const messages = pageMessages(lang);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>{messages.text('grid.pooled.heading')}</h3>
      <p>{messages.text('grid.pooled.intro')}</p>
      <table className={tableStyles.table} aria-labelledby={headingId}>
        <thead>
          <tr>
            <th scope="col">{messages.text('grid.column.rule')}</th>
            <th scope="col">{messages.text('grid.column.surface')}</th>
            {ROLES.map((role) => (
              <th key={role} scope="col">
                {messages.text(`role.${role}`, { variant: variants[role] })}
              </th>
            ))}
            <th scope="col">{messages.text('grid.column.difference')}</th>
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
    </section>
  );
}
