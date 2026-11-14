import type { Lang } from '../../../../src/config/schema.js';
import { dollars, ratio, seconds } from '../../../../src/report/format.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { Shape } from '../../components/Shape.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { placeLabel } from '../../utils/cell.js';
import styles from './metrics.module.css';

type Warning = Comparison['warnings'][number];

/** The variant IDs of the comparison, which the page calls the baseline and the candidate. */
interface VariantIds {
  readonly baseline: string;
  readonly candidate: string;
}

/**
 * `script-ja (ja)`, the variant and the case IDs, as much of them as the warning names. A
 * warning about both variants leaves them out, and one variant is named by its role.
 */
function warningLabel(warning: Warning, variants: VariantIds, messages: Messages): string {
  const rule = placeLabel(warning);
  const [only, ...others] = warning.variants ?? [];
  const roleOf = (id: string) => {
    if (id === variants.baseline) {
      return messages.text('role.baseline');
    }
    return id === variants.candidate ? messages.text('role.candidate') : id;
  };
  const role = only !== undefined && others.length === 0 ? roleOf(only) : undefined;
  const cases =
    warning.caseIds === undefined
      ? undefined
      : messages.text('metrics.warnings.cases', { cases: warning.caseIds.join(', ') });
  return [rule, role, cases].filter((part) => part !== undefined && part !== '').join(' · ');
}

/**
 * Cost and latency warnings read as the two values, the ratio and the warning level, the way the
 * decision summary writes them: `Cost per 1,000 trials: $0.0147 → $0.0323, ×2.19, past the
 * warning level ×2.00`. Other warnings use the text of the message files.
 */
function warningLine(warning: Warning, variants: VariantIds, messages: Messages): string {
  if (warning.code === 'cost-ratio') {
    const cost = warning.params.costPerTrialUsd;
    // A trial costs a fraction of a cent; a thousand trials read as an amount.
    const perThousand = (id: string) => {
      const value = cost[id];
      return dollars(value === undefined ? null : value * 1000);
    };
    return messages.text('metrics.warnings.ratio', {
      metric: messages.text('summary.cost.per1000'),
      baseline: perThousand(variants.baseline),
      candidate: perThousand(variants.candidate),
      ratio: ratio(warning.params.ratio),
      threshold: ratio(warning.params.threshold),
    });
  }
  if (warning.code === 'latency-p95-ratio') {
    const p95 = warning.params.p95Ms;
    return messages.text('metrics.warnings.ratio', {
      metric: messages.text('metrics.latencyP95'),
      baseline: seconds(p95[variants.baseline] ?? null),
      candidate: seconds(p95[variants.candidate] ?? null),
      ratio: ratio(warning.params.ratio),
      threshold: ratio(warning.params.threshold),
    });
  }
  return messages.warning(warning);
}

interface WarningListProps {
  readonly lang: Lang;
  readonly warnings: readonly Warning[];
  readonly variants: VariantIds;
}

/** The warnings of the comparison in the text of the message files (FR-006, plan D8). */
export function WarningList({ lang, warnings, variants }: WarningListProps) {
  const messages = pageMessages(lang);
  return (
    <div className={styles.block}>
      <h3>{messages.text('metrics.warnings.heading')}</h3>
      {warnings.length === 0 ? (
        <p className={styles.empty}>{messages.text('metrics.warnings.none')}</p>
      ) : (
        <ul className={styles.warnings}>
          {warnings.map((warning, index) => {
            const label = warningLabel(warning, variants, messages);
            return (
              // Warnings have no ID and the list never reorders, so the position identifies one.
              <li key={index}>
                <Shape kind="square" />
                {label !== '' && <span className={styles.muted}>{`${label} · `}</span>}
                {warningLine(warning, variants, messages)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
