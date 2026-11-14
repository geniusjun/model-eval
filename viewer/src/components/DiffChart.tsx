import styles from './DiffChart.module.css';

const WIDTH = 100;
const HEIGHT = 16;

/** The shared horizontal scale of every row of a change chart, in shares (−1 to 1). */
export interface DiffScale {
  readonly low: number;
  readonly high: number;
  /** Where the gridlines and the axis labels go. */
  readonly ticks: readonly number[];
}

/**
 * Red for a regression and green for an improvement; grey says the data cannot tell yet.
 * `outside` is an outline for a cell outside the gate, which cannot block.
 */
export type DiffTone = 'regressed' | 'improved' | 'neutral' | 'outside';

const TONE_CLASS: Readonly<Record<DiffTone, string | undefined>> = {
  regressed: styles.regressed,
  improved: styles.improved,
  neutral: styles.neutral,
  outside: styles.outside,
};

const STEPS = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5];

/**
 * One scale for every chart that shares it: wide enough for each interval, each −margin and 0,
 * in round steps, with a tick at each step.
 */
export function diffScale(
  intervals: readonly { readonly low: number; readonly high: number; readonly margin: number }[],
): DiffScale | undefined {
  if (intervals.length === 0) {
    return undefined;
  }
  const values = intervals.flatMap(({ low, high, margin }) => [low, high, -margin]);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const step = STEPS.find((size) => (high - low) / size <= 6) ?? 0.5;
  const from = Math.floor(low / step - 0.15) * step;
  const to = Math.ceil(high / step + 0.15) * step;
  const ticks: number[] = [];
  for (let tick = from; tick <= to + step / 2; tick += step) {
    ticks.push(Math.round(tick * 1000) / 1000);
  }
  return { low: Math.max(from, -1), high: Math.min(to, 1), ticks };
}

interface DiffChartProps {
  /** The chart's title, which states the difference, its interval and the margin in words. */
  readonly title: string;
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
  /** The non-inferiority margin; its line is drawn at minus this value. */
  readonly margin: number;
  readonly scale: DiffScale;
  readonly tone: DiffTone;
  /**
   * Whether the chart draws its own zero and margin lines. A table that draws them down a whole
   * column turns them off, so the two never overlap.
   */
  readonly guides?: boolean;
}

/** The x position of a difference on the shared scale, as a share of the width, clamped. */
export function scaleX(value: number, scale: DiffScale): number {
  const share = (value - scale.low) / (scale.high - scale.low);
  return Math.min(Math.max(share, 0), 1) * WIDTH;
}

/**
 * One row of the change chart (plan D6): a difference of compliance with its interval on a scale
 * shared by every row, the zero line, and the margin as a dashed line at −margin. The interval is
 * red when the cell regressed, green when it improved and grey otherwise; the title says it all
 * in words.
 */
export function DiffChart({
  title,
  estimate,
  low,
  high,
  margin,
  scale,
  tone,
  guides = true,
}: DiffChartProps) {
  const x = (value: number) => scaleX(value, scale);
  return (
    <svg
      className={styles.chart}
      role="img"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      preserveAspectRatio="none"
    >
      <title>{title}</title>
      {guides && (
        <line className={styles.margin} x1={x(-margin)} x2={x(-margin)} y1={0} y2={HEIGHT} />
      )}
      {guides && <line className={styles.zero} x1={x(0)} x2={x(0)} y1={0} y2={HEIGHT} />}
      <rect
        className={[styles.interval, TONE_CLASS[tone]].filter(Boolean).join(' ')}
        x={x(low)}
        width={Math.max(x(high) - x(low), 0.4)}
        y={HEIGHT / 2 - 3}
        height={6}
        rx={0}
      />
      <line className={styles.halo} x1={x(estimate)} x2={x(estimate)} y1={1} y2={HEIGHT - 1} />
      <line className={styles.point} x1={x(estimate)} x2={x(estimate)} y1={2} y2={HEIGHT - 2} />
    </svg>
  );
}
