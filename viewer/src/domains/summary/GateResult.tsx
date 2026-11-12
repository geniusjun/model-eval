import type { Comparison, Gate } from '../../../../src/report/schema.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './DecisionSummary.module.css';
import { cellLabel, placeLabel } from '../../utils/cell.js';
import { outcomeText } from './summaryText.js';

const OUTCOME_CLASS: Readonly<Record<Gate['outcome'], string | undefined>> = {
  pass: styles.pass,
  block: styles.block,
  undecided: styles.undecided,
  'no-gate': styles['no-gate'],
};

interface GateResultProps {
  readonly comparison: Pick<Comparison, 'gate' | 'stats' | 'priorComparisons'>;
  readonly messages: Messages;
}

/** The gate outcome with the gated cell count, its reasons, the blocking cells and prior comparisons. */
export function GateResult({ comparison, messages }: GateResultProps) {
  const { gate, stats, priorComparisons } = comparison;
  const none = <p className={styles.none}>{messages.text('summary.none')}</p>;
  const outcomeClass = [styles.outcome, OUTCOME_CLASS[gate.outcome]].filter(Boolean).join(' ');
  return (
    <dl className={styles.facts}>
      <dt>{messages.text('summary.gate')}</dt>
      <dd>
        <span className={outcomeClass}>{outcomeText(messages.lang, gate.outcome)}</span>
      </dd>
      <dt>{messages.text('summary.gatedCells')}</dt>
      <dd>{String(stats.gatedCells)}</dd>
      <dt>{messages.text('summary.reasons')}</dt>
      <dd>
        {gate.reasons.length === 0 ? (
          none
        ) : (
          <ul className={styles.list}>
            {gate.reasons.map((reason, index) => {
              const place = placeLabel(reason);
              const text = messages.reason(reason);
              return (
                <li key={`${String(index)}-${reason.code}`}>
                  {place === undefined ? text : `${place}: ${text}`}
                </li>
              );
            })}
          </ul>
        )}
      </dd>
      <dt>{messages.text('summary.blocking')}</dt>
      <dd>
        {gate.blocking.length === 0 ? (
          none
        ) : (
          <ul className={styles.list}>
            {gate.blocking.map((key) => {
              const label = cellLabel(key);
              return <li key={label}>{label}</li>;
            })}
          </ul>
        )}
      </dd>
      <dt>{messages.text('summary.priorComparisons')}</dt>
      <dd>{String(priorComparisons)}</dd>
    </dl>
  );
}
