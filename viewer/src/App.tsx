import type { PageData } from '../../src/report/schema.js';
import { ComparisonListPage } from './pages/ComparisonListPage.js';
import { ReportPage } from './pages/ReportPage.js';

interface AppProps {
  readonly page: PageData;
}

export function App({ page }: AppProps) {
  return page.kind === 'comparison' ? (
    <ReportPage page={page} />
  ) : (
    <ComparisonListPage page={page} />
  );
}
