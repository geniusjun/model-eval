import { percent, percentInterval, points, pointsInterval } from '../../../src/report/format.js';
import { shareX } from '../utils/format.js';
import styles from './IntervalBar.module.css';

const WIDTH = 100;
const HEIGHT = 10;
const MARK_WIDTH = 1.5;

/** A rate runs from 0 to 1; a difference of two rates runs from -1 to 1, with 0 in the middle. */
export type IntervalKind = 'rate' | 'difference';

interface IntervalBarProps {
  /** Names the value in the chart's title, for example the variant. */
  readonly label: string;
  readonly value: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly kind?: IntervalKind;
}

/** Where `value` sits on the chart, as a share of its width. */
function share(value: number, kind: IntervalKind): number {
  return kind === 'difference' ? (value + 1) / 2 : value;
}

/** `next: 70.0% [62.9, 80.8]` for a rate, `Difference: -29.3pp [-37.1, -19.2]` for a difference. */
function titleText({ label, value, low, high, kind = 'rate' }: IntervalBarProps): string {
  if (kind === 'rate') {
    return [`${label}:`, percent(value), percentInterval(low, high)].join(' ').trim();
  }
  const interval = low === null || high === null ? '' : pointsInterval(low, high);
  return [`${label}:`, value === null ? percent(null) : points(value), interval].join(' ').trim();
}

/** A rate or a difference with its interval, as an image whose title states both (plan D6). */
export function IntervalBar({ label, value, low, high, kind = 'rate' }: IntervalBarProps) {
  const x = (point: number) => shareX(share(point, kind), WIDTH);
  return (
    <svg
      className={styles.chart}
      role="img"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      preserveAspectRatio="none"
    >
      <title>{titleText({ label, value, low, high, kind })}</title>
      {value !== null && <rect className={styles.track} width={WIDTH} height={HEIGHT} />}
      {value !== null && low !== null && high !== null && (
        <rect
          className={styles.interval}
          x={x(low)}
          width={x(high) - x(low)}
          y={HEIGHT / 4}
          height={HEIGHT / 2}
        />
      )}
      {value !== null && kind === 'difference' && (
        <line className={styles.zero} x1={x(0)} x2={x(0)} y1={0} y2={HEIGHT} />
      )}
      {value !== null && (
        <rect
          className={styles.mark}
          x={x(value) - MARK_WIDTH / 2}
          width={MARK_WIDTH}
          height={HEIGHT}
        />
      )}
    </svg>
  );
}
