import type { MetricRate } from '../../../../src/report/schema.js';
import { IntervalBar } from '../../components/IntervalBar.js';
import type { Messages } from '../../i18n/useMessages.js';
import { rateText } from '../../utils/cell.js';
import styles from './metrics.module.css';

interface MetricRateValueProps {
  /** Names the rate and its variant in the chart's title. */
  readonly label: string;
  readonly rate: MetricRate;
  readonly messages: Messages;
}

/** An operational rate with its interval bar, its interval and its count of total. */
export function MetricRateValue({ label, rate, messages }: MetricRateValueProps) {
  return (
    <span className={styles.rate}>
      <IntervalBar label={label} value={rate.rate} low={rate.low} high={rate.high} />
      <span>{rateText(rate)}</span>
      <span className={styles.count}>
        {messages.text('metrics.countOf', { count: rate.count, total: rate.total })}
      </span>
    </span>
  );
}
