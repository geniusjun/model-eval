import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent } from '../../../../src/report/format.js';
import { isLowBaseline } from '../../../../src/report/low-baseline.js';
import type { Cell } from '../../../../src/report/schema.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages } from '../../i18n/useMessages.js';
import { ROLES } from '../../report/variants.js';
import { cellId, rateText } from '../../utils/cell.js';
import styles from './ReferenceTables.module.css';
import tableStyles from './table.module.css';

interface LowBaselineCellsProps {
  readonly cells: readonly Cell[];
  /** `config.report.lowBaseline` of the comparison. */
  readonly lowBaseline: number;
  readonly lang: Lang;
}

/** The cells whose baseline compliance is below the configured level, as `report.md` lists them. */
export function LowBaselineCells({ cells, lowBaseline, lang }: LowBaselineCellsProps) {
  const messages = pageMessages(lang);
  const headingId = useId();
  const level = percent(lowBaseline);
  const lowCells = cells.filter((cell) => isLowBaseline(cell, lowBaseline));
  return (
    <section className={styles.reference} aria-labelledby={headingId}>
      <h3 id={headingId}>{messages.text('grid.lowBaseline.heading')}</h3>
      {lowCells.length === 0 ? (
        <p className={styles.intro}>{messages.text('grid.lowBaseline.none', { level })}</p>
      ) : (
        <>
          <p className={styles.intro}>{messages.text('grid.lowBaseline.intro', { level })}</p>
          <Disclosure label={messages.text('grid.lowBaseline.show', { count: lowCells.length })}>
            <table
              className={[tableStyles.table, tableStyles.minor].filter(Boolean).join(' ')}
              aria-labelledby={headingId}
            >
              <thead>
                <tr>
                  <th scope="col">{messages.text('grid.column.rule')}</th>
                  <th scope="col">{messages.text('grid.column.lang')}</th>
                  <th scope="col">{messages.text('grid.column.surface')}</th>
                  {ROLES.map((role) => (
                    <th key={role} scope="col" className={tableStyles.number}>
                      {messages.text(`role.${role}`)}
                    </th>
                  ))}
                  <th scope="col">{messages.text('grid.column.verdict')}</th>
                </tr>
              </thead>
              <tbody>
                {lowCells.map((cell) => (
                  <tr key={cellId(cell)}>
                    <th scope="row">{cell.ruleId}</th>
                    <td>{cell.lang}</td>
                    <td>{cell.surface}</td>
                    {ROLES.map((role) => (
                      <td key={role} className={tableStyles.number}>
                        {rateText(cell[role])}
                      </td>
                    ))}
                    <td>
                      <VerdictBadge verdict={cell.verdict} lang={lang} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Disclosure>
        </>
      )}
    </section>
  );
}
