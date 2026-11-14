import { percent, percentInterval } from '../../../../src/report/format.js';
import type { MetricRate } from '../../../../src/report/schema.js';
import { IntervalBar } from '../../components/IntervalBar.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './metrics.module.css';

interface MetricRateValueProps {
  /** Names the rate and its variant in the chart's title. */
  readonly label: string;
  readonly rate: MetricRate;
  readonly messages: Messages;
}

/**
 * An operational rate: the rate with a small interval bar beside it, then its interval and its
 * count of total in a quieter line below.
 */
export function MetricRateValue({ label, rate, messages }: MetricRateValueProps) {
  const counts = messages.text('metrics.countOf', { count: rate.count, total: rate.total });
  const below = [percentInterval(rate.low, rate.high), counts].filter((part) => part !== '');
  return (
    <span className={styles.rate}>
      <span className={styles.rateLine}>
        <IntervalBar
          label={label}
          value={rate.rate}
          low={rate.low}
          high={rate.high}
          size="compact"
        />
        <span className={styles.rateValue}>{percent(rate.rate)}</span>
      </span>
      <span className={styles.count}>{below.join(' · ')}</span>
    </span>
  );
}
