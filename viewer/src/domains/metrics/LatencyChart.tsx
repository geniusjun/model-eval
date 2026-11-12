import type { Lang } from '../../../../src/config/schema.js';
import { seconds } from '../../../../src/report/format.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { binCounts } from '../../utils/format.js';
import { ROLES, type Role, type VariantIds } from '../../report/variants.js';
import styles from './LatencyChart.module.css';

type Latency = Comparison['ops'][Role]['latencyMs'];

const WIDTH = 100;
const HEIGHT = 30;
const BIN_COUNT = 20;
const BIN_WIDTH = WIDTH / BIN_COUNT;

/** Each bin's share of the variant's measured latencies; all 0 when none was measured. */
function binShares(values: readonly number[], max: number): number[] {
  const total = Math.max(values.length, 1);
  return binCounts(values, max, BIN_COUNT).map((count) => count / total);
}

function largest(values: readonly number[]): number {
  return values.reduce((top, value) => Math.max(top, value), 0);
}

interface VariantLatencyProps {
  readonly variant: string;
  readonly latency: Latency;
  readonly shares: readonly number[];
  /** The largest bin share of both variants, the top of the shared height scale. */
  readonly tallest: number;
  readonly messages: Messages;
}

function VariantLatency({ variant, latency, shares, tallest, messages }: VariantLatencyProps) {
  if (latency.values.length === 0) {
    return <p>{messages.text('metrics.latency.notMeasured', { variant })}</p>;
  }
  const title = messages.text('metrics.latency.title', {
    variant,
    p50: seconds(latency.p50),
    p95: seconds(latency.p95),
  });
  return (
    <div className={styles.row}>
      <span className={styles.variant}>{variant}</span>
      <svg
        className={styles.chart}
        role="img"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
      >
        <title>{title}</title>
        {shares.map((share, bin) => {
          if (share === 0) {
            return null;
          }
          const height = (share / tallest) * HEIGHT;
          return (
            <rect
              key={bin}
              className={styles.bin}
              x={bin * BIN_WIDTH}
              width={BIN_WIDTH}
              y={HEIGHT - height}
              height={height}
            />
          );
        })}
        <line className={styles.axis} x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} />
      </svg>
    </div>
  );
}

interface LatencyChartProps {
  readonly lang: Lang;
  readonly latency: Readonly<Record<Role, Latency>>;
  readonly variantIds: VariantIds;
}

/**
 * The latency distribution of each variant as bars of equal-width bins from 0 to the slowest
 * latency of both, so the two variants read on one scale (plan D6). Bar heights are each bin's
 * share of its variant's latencies, so variants with different trial counts compare.
 */
export function LatencyChart({ lang, latency, variantIds }: LatencyChartProps) {
  const messages = pageMessages(lang);
  const max = Math.max(...ROLES.map((role) => largest(latency[role].values)));
  const shares = {
    baseline: binShares(latency.baseline.values, max),
    candidate: binShares(latency.candidate.values, max),
  };
  const tallest = Math.max(...shares.baseline, ...shares.candidate);
  const measured = ROLES.some((role) => latency[role].values.length > 0);
  return (
    <div className={styles.block}>
      <h3>{messages.text('metrics.latency.heading')}</h3>
      {measured && <p>{messages.text('metrics.latency.scale', { max: seconds(max) })}</p>}
      {ROLES.map((role) => (
        <VariantLatency
          key={role}
          variant={variantIds[role]}
          latency={latency[role]}
          shares={shares[role]}
          tallest={tallest}
          messages={messages}
        />
      ))}
    </div>
  );
}
