import { useId } from 'react';

import type { ListPage } from '../../../src/report/schema.js';
import { LanguageSwitch } from '../components/LanguageSwitch.js';
import { outcomeText } from '../domains/summary/summaryText.js';
import { useMessages, type Messages } from '../i18n/useMessages.js';
import styles from './ComparisonListPage.module.css';

type ListEntry = ListPage['comparisons'][number];

interface ComparisonListPageProps {
  readonly page: ListPage;
}

interface ComparisonTableProps {
  readonly comparisons: readonly ListEntry[];
  readonly labelledBy: string;
  readonly messages: Messages;
}

/** One row per comparison in payload order, which the writer sorts newest first. */
function ComparisonTable({ comparisons, labelledBy, messages }: ComparisonTableProps) {
  return (
    <table className={styles.table} aria-labelledby={labelledBy}>
      <thead>
        <tr>
          <th scope="col">{messages.text('list.column.comparison')}</th>
          <th scope="col">{messages.text('list.column.baseline')}</th>
          <th scope="col">{messages.text('list.column.candidate')}</th>
          <th scope="col">{messages.text('list.column.createdAt')}</th>
          <th scope="col">{messages.text('list.column.gate')}</th>
        </tr>
      </thead>
      <tbody>
        {comparisons.map((entry) => (
          <tr key={entry.comparisonId}>
            <th scope="row" className={styles.id}>
              <a href={entry.href}>{entry.comparisonId}</a>
            </th>
            <td>{entry.baseline}</td>
            <td>{entry.candidate}</td>
            <td className={styles.time}>{entry.createdAt}</td>
            <td>{outcomeText(messages.lang, entry.gate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The output root's list of comparisons; each row opens that comparison's page by its relative link. */
export function ComparisonListPage({ page }: ComparisonListPageProps) {
  const messages = useMessages(page.lang);
  const headingId = useId();
  return (
    <main>
      <header className={styles.header}>
        <h1 id={headingId}>{messages.text('list.heading')}</h1>
        <LanguageSwitch lang={messages.lang} />
      </header>
      {page.comparisons.length === 0 ? (
        <p className={styles.empty}>{messages.text('list.empty')}</p>
      ) : (
        <ComparisonTable
          comparisons={page.comparisons}
          labelledBy={headingId}
          messages={messages}
        />
      )}
    </main>
  );
}
