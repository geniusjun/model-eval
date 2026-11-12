import type { ListPage } from '../../../src/report/schema.js';
import { useMessages } from '../i18n/useMessages.js';

interface ComparisonListPageProps {
  readonly page: ListPage;
}

/** The output root's list of comparisons. */
export function ComparisonListPage({ page }: ComparisonListPageProps) {
  const messages = useMessages(page.lang);
  return (
    <main>
      <h1>{messages.text('list.heading')}</h1>
    </main>
  );
}
