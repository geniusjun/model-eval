import type { ComparisonPage } from '../../../src/report/schema.js';
import { useMessages } from '../i18n/useMessages.js';

interface ReportPageProps {
  readonly page: ComparisonPage;
}

/** The result page of one comparison. */
export function ReportPage({ page }: ReportPageProps) {
  const messages = useMessages(page.lang);
  return (
    <main>
      <h1>{messages.text('report.heading')}</h1>
    </main>
  );
}
