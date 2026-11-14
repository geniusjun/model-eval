import type { Lang } from '../../../../src/config/schema.js';
import type { Gate } from '../../../../src/report/schema.js';
import { OUTCOME_SHAPE, Shape } from '../../components/Shape.js';
import styles from './GateOutcome.module.css';
import { outcomeText } from './summaryText.js';

const OUTCOME_CLASS: Readonly<Record<Gate['outcome'], string | undefined>> = {
  pass: styles.pass,
  block: styles.block,
  undecided: styles.undecided,
  'no-gate': styles['no-gate'],
};

interface GateOutcomeProps {
  readonly outcome: Gate['outcome'];
  readonly lang: Lang;
  /** `large` for the summary, where the outcome is the page's answer; `small` for the top bar. */
  readonly size: 'large' | 'small';
}

/** The gate outcome in the words of report.md, with its shape. */
export function GateOutcome({ outcome, lang, size }: GateOutcomeProps) {
  const className = [styles.outcome, styles[size], OUTCOME_CLASS[outcome]]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={className}>
      <Shape kind={OUTCOME_SHAPE[outcome]} />
      {outcomeText(lang, outcome)}
    </span>
  );
}
