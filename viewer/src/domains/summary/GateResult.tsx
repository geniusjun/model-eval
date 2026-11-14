import type { Comparison } from '../../../../src/report/schema.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './DecisionSummary.module.css';
import { cellLabel, placeLabel } from '../../utils/cell.js';
import { GateOutcome } from './GateOutcome.js';
import { conclusionText } from './summaryText.js';

interface GateResultProps {
  readonly comparison: Pick<
    Comparison,
    'gate' | 'stats' | 'priorComparisons' | 'cells' | 'summary'
  >;
  readonly messages: Messages;
}

/** The gate outcome as the page's answer, with the sentence that explains it. */
export function GateResult({ comparison, messages }: GateResultProps) {
  const { gate } = comparison;
  return (
    <dl className={styles.gate}>
      <div className={styles.outcomeFact}>
        <dt>{messages.text('summary.gate')}</dt>
        <dd>
          <GateOutcome outcome={gate.outcome} lang={messages.lang} size="large" />
        </dd>
        <dd className={styles.conclusion}>{conclusionText(comparison, messages)}</dd>
      </div>
    </dl>
  );
}

/**
 * The facts behind the gate outcome, which its sentence sums up: the gated cell count, the prior
 * comparisons, the reasons and the blocking cells.
 */
export function GateFacts({ comparison, messages }: GateResultProps) {
  const { gate, stats, priorComparisons } = comparison;
  const none = <p className={styles.none}>{messages.text('summary.none')}</p>;
  return (
    <dl className={styles.gateFacts}>
      <div className={styles.countFact}>
        <dt>{messages.text('summary.gatedCells')}</dt>
        <dd>{String(stats.gatedCells)}</dd>
      </div>
      <div className={styles.countFact}>
        <dt>{messages.text('summary.priorComparisons')}</dt>
        <dd>{String(priorComparisons)}</dd>
      </div>
      <div className={styles.wideFact}>
        <dt>{messages.text('summary.reasons')}</dt>
        <dd>
          {gate.reasons.length === 0 ? (
            none
          ) : (
            <ul className={styles.reasons}>
              {gate.reasons.map((reason, index) => {
                const place = placeLabel(reason);
                const text = messages.reason(reason);
                return (
                  <li key={`${String(index)}-${reason.code}`}>
                    {place === undefined ? (
                      text
                    ) : (
                      <>
                        <span className={styles.cell}>{place}</span>
                        {`: ${text}`}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
      </div>
      <div className={styles.wideFact}>
        <dt>{messages.text('summary.blocking')}</dt>
        <dd>
          {gate.blocking.length === 0 ? (
            none
          ) : (
            <ul className={styles.blocking}>
              {gate.blocking.map((key) => {
                const label = cellLabel(key);
                return (
                  <li key={label} className={styles.cell}>
                    {label}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}
