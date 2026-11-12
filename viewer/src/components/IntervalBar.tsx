import { percent, percentInterval } from '../../../src/report/format.js';
import { shareX } from '../utils/format.js';
import styles from './IntervalBar.module.css';

const WIDTH = 100;
const HEIGHT = 10;
const MARK_WIDTH = 1.5;

interface IntervalBarProps {
  /** Names the rate in the chart's title, for example the variant. */
  readonly label: string;
  readonly rate: number | null;
  readonly low: number | null;
  readonly high: number | null;
}

/** A rate between 0 and 1 with its interval, as an image whose title states both (plan D6). */
export function IntervalBar({ label, rate, low, high }: IntervalBarProps) {
  const title = [`${label}:`, percent(rate), percentInterval(low, high)].join(' ').trim();
  const hasInterval = low !== null && high !== null;
  return (
    <svg
      className={styles.chart}
      role="img"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      preserveAspectRatio="none"
    >
      <title>{title}</title>
      {rate !== null && <rect className={styles.track} width={WIDTH} height={HEIGHT} />}
      {rate !== null && hasInterval && (
        <rect
          className={styles.interval}
          x={shareX(low, WIDTH)}
          width={shareX(high, WIDTH) - shareX(low, WIDTH)}
          y={HEIGHT / 4}
          height={HEIGHT / 2}
        />
      )}
      {rate !== null && (
        <rect
          className={styles.mark}
          x={shareX(rate, WIDTH) - MARK_WIDTH / 2}
          width={MARK_WIDTH}
          height={HEIGHT}
        />
      )}
    </svg>
  );
}
