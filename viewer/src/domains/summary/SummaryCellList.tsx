import { percent } from '../../../../src/report/format.js';
import type { Cell, Summary } from '../../../../src/report/schema.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './DecisionSummary.module.css';
import { cellLabel, failRatioText, isSameCell } from '../../utils/cell.js';

type SummaryCell = Summary['worse'][number];

interface SummaryCellListProps {
  readonly entries: readonly SummaryCell[];
  readonly cells: readonly Cell[];
  /** Undecided cells also say what a new run needs. */
  readonly withNeeded: boolean;
  readonly messages: Messages;
}

/** Rates, failure-rate ratio, note and, when asked, `needed`, after the verdict. */
function details(
  entry: SummaryCell,
  cell: Cell | undefined,
  withNeeded: boolean,
  messages: Messages,
): string[] {
  const parts: string[] = [];
  if (cell !== undefined) {
    parts.push(
      `${percent(cell.baseline.rate)} → ${percent(cell.candidate.rate)}`,
      failRatioText(cell, messages.lang),
    );
  }
  if (entry.note !== undefined) {
    parts.push(messages.note(entry.note));
  }
  if (withNeeded && entry.needed !== undefined) {
    parts.push(messages.needed(entry.needed, cell?.candidate.trials ?? 0));
  }
  return parts;
}

/** One line per cell: `script-ja (ja, raw): Regressed · 99.3% → 70.0% · ×45`. */
export function SummaryCellList({ entries, cells, withNeeded, messages }: SummaryCellListProps) {
  if (entries.length === 0) {
    return <p className={styles.none}>{messages.text('summary.none')}</p>;
  }
  return (
    <ul className={styles.list}>
      {entries.map((entry) => {
        const label = cellLabel(entry);
        const cell = cells.find((candidate) => isSameCell(candidate, entry));
        const rest = details(entry, cell, withNeeded, messages)
          .map((part) => ` · ${part}`)
          .join('');
        return (
          <li key={label}>
            <span className={styles.cell}>{label}</span>
            {': '}
            <VerdictBadge verdict={entry.verdict} lang={messages.lang} />
            {rest}
          </li>
        );
      })}
    </ul>
  );
}
