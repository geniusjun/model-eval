import './report/jitless.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/tokens.css';
import './styles/global.css';

import { App } from './App.js';
import { InvalidReport } from './pages/InvalidReport.js';
import { RootErrorBoundary } from './pages/RootErrorBoundary.js';
import { readEmbeddedReport } from './report/readEmbeddedReport.js';

/** The error screen starts in English unless the hash names a language. */
const FALLBACK_LANG = 'en';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('the page template has no #root element');
}

const result = readEmbeddedReport(document);
createRoot(container).render(
  <StrictMode>
    {result.ok ? (
      <RootErrorBoundary lang={result.page.lang}>
        <App page={result.page} />
      </RootErrorBoundary>
    ) : (
      <InvalidReport
        problem={{ kind: 'data', foundVersion: result.error.foundVersion }}
        lang={FALLBACK_LANG}
      />
    )}
  </StrictMode>,
);
