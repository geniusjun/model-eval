import type { Lang } from '../../../../src/config/schema.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { placeLabel } from '../../utils/cell.js';
import styles from './metrics.module.css';

type Warning = Comparison['warnings'][number];

/** `script-ja (ja)`, the variants and the case IDs, as much of them as the warning names. */
function warningLabel(warning: Warning, messages: Messages): string {
  const rule = placeLabel(warning);
  const variants = warning.variants?.join(', ');
  const cases =
    warning.caseIds === undefined
      ? undefined
      : messages.text('metrics.warnings.cases', { cases: warning.caseIds.join(', ') });
  return [rule, variants, cases].filter((part) => part !== undefined && part !== '').join(' · ');
}

interface WarningListProps {
  readonly lang: Lang;
  readonly warnings: readonly Warning[];
}

/** The warnings of the comparison in the text of the message files (FR-006, plan D8). */
export function WarningList({ lang, warnings }: WarningListProps) {
  const messages = pageMessages(lang);
  return (
    <div className={styles.block}>
      <h3>{messages.text('metrics.warnings.heading')}</h3>
      {warnings.length === 0 ? (
        <p>{messages.text('metrics.warnings.none')}</p>
      ) : (
        <ul>
          {warnings.map((warning, index) => {
            const label = warningLabel(warning, messages);
            return (
              // Warnings have no ID and the list never reorders, so the position identifies one.
              <li key={index}>
                {label !== '' && <span className={styles.muted}>{`${label} · `}</span>}
                {messages.warning(warning)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
