import type { Lang } from '../../../src/config/schema.js';
import { SCHEMA_VERSION } from '../../../src/report/schema.js';
import { LanguageSwitch } from '../components/LanguageSwitch.js';
import { useMessages, type Messages } from '../i18n/useMessages.js';

/** Why the report cannot be shown: data the page cannot read, or a bug while drawing it. */
export type ReportProblem =
  { readonly kind: 'data'; readonly foundVersion: string | null } | { readonly kind: 'render' };

interface InvalidReportProps {
  readonly problem: ReportProblem;
  /** The language to start in when the hash names none: English for data the page cannot read, the payload's for a rendering bug. */
  readonly lang: Lang;
}

function problemText(problem: ReportProblem, messages: Messages): string {
  if (problem.kind === 'render') {
    return messages.text('invalid.render');
  }
  if (problem.foundVersion === null) {
    return messages.text('invalid.noVersion');
  }
  if (problem.foundVersion === SCHEMA_VERSION) {
    return messages.text('invalid.mismatch', { found: problem.foundVersion });
  }
  return messages.text('invalid.unsupported', {
    found: problem.foundVersion,
    supported: SCHEMA_VERSION,
  });
}

/** The error screen of FR-012, in place of a broken view. */
export function InvalidReport({ problem, lang }: InvalidReportProps) {
  const messages = useMessages(lang);
  return (
    <main>
      <h1>{messages.text('invalid.heading')}</h1>
      <LanguageSwitch lang={messages.lang} />
      <p>{problemText(problem, messages)}</p>
    </main>
  );
}
