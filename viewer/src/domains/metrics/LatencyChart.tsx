import type { Lang } from '../../../../src/config/schema.js';
import { seconds } from '../../../../src/report/format.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { binCounts } from '../../utils/format.js';
import { ROLES, type Role } from '../../report/variants.js';
import styles from './LatencyChart.module.css';

type Latency = Comparison['ops'][Role]['latencyMs'];

const WIDTH = 100;
const HEIGHT = 30;
const BIN_COUNT = 20;
const BIN_WIDTH = WIDTH / BIN_COUNT;

/** Each bin's share of the variant's measured latencies; all 0 when none was measured. */
function binShares(values: readonly number[], min: number, max: number): number[] {
  const total = Math.max(values.length, 1);
  return binCounts(values, min, max, BIN_COUNT).map((count) => count / total);
}

const BIN_CLASS: Readonly<Record<Role, string | undefined>> = {
  baseline: styles.baseline,
  candidate: styles.candidate,
};

/** Both variants measured, with p50 and p95 each within 5% of the baseline's. */
function sameLatency(baseline: Latency, candidate: Latency): boolean {
  const close = (a: number | null, b: number | null) =>
    a !== null && b !== null && a > 0 && Math.abs(b / a - 1) < 0.05;
  return close(baseline.p50, candidate.p50) && close(baseline.p95, candidate.p95);
}

interface VariantLatencyProps {
  readonly role: Role;
  readonly variant: string;
  readonly latency: Latency;
  readonly shares: readonly number[];
  /** The largest bin share of both variants, the top of the shared height scale. */
  readonly tallest: number;
  readonly messages: Messages;
}

function VariantLatency({
  role,
  variant,
  latency,
  shares,
  tallest,
  messages,
}: VariantLatencyProps) {
  if (latency.values.length === 0) {
    return (
      <p className={styles.note}>{messages.text('metrics.latency.notMeasured', { variant })}</p>
    );
  }
  const title = messages.text('metrics.latency.title', {
    variant,
    p50: seconds(latency.p50),
    p95: seconds(latency.p95),
  });
  return (
    <div className={styles.row}>
      <span className={styles.variant}>
        {variant}
        <span className={styles.marks}>
          {messages.text('metrics.latency.marks', {
            p50: seconds(latency.p50),
            p95: seconds(latency.p95),
          })}
        </span>
      </span>
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
              className={[styles.bin, BIN_CLASS[role]].filter(Boolean).join(' ')}
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
}

/**
 * The latency distribution of each variant as bars of 20 equal-width bins from the fastest to
 * the slowest latency of both, so the two variants read on one scale and no part of the axis is
 * empty by construction (plan D6). Bar heights are each bin's share of its variant's latencies,
 * so variants with different trial counts compare. The baseline is grey and the candidate teal,
 * and each row is named, so colour is never the only cue; the axis ends are written below.
 */
export function LatencyChart({ lang, latency }: LatencyChartProps) {
  const messages = pageMessages(lang);
  const all = ROLES.flatMap((role) => latency[role].values);
  const min = all.length === 0 ? 0 : Math.min(...all);
  const max = all.length === 0 ? 0 : Math.max(...all);
  const shares = {
    baseline: binShares(latency.baseline.values, min, max),
    candidate: binShares(latency.candidate.values, min, max),
  };
  const tallest = Math.max(...shares.baseline, ...shares.candidate);
  const measured = ROLES.some((role) => latency[role].values.length > 0);
  const chart = (
    <>
      {measured && (
        <p className={styles.note}>
          {messages.text('metrics.latency.scale', { min: seconds(min), max: seconds(max) })}
        </p>
      )}
      {ROLES.map((role) => (
        <VariantLatency
          key={role}
          role={role}
          variant={messages.text(`role.${role}`)}
          latency={latency[role]}
          shares={shares[role]}
          tallest={tallest}
          messages={messages}
        />
      ))}
      {measured && (
        <div className={styles.row} aria-hidden="true">
          <span />
          <span className={styles.axisLabels}>
            <span>{seconds(min)}</span>
            <span>{seconds(max)}</span>
          </span>
        </div>
      )}
    </>
  );
  const { baseline, candidate } = latency;
  return (
    <div className={styles.block}>
      <h3>{messages.text('metrics.latency.heading')}</h3>
      {sameLatency(baseline, candidate) ? (
        <>
          <p className={styles.note}>
            {messages.text('metrics.latency.same', {
              p50: seconds(candidate.p50),
              p95: seconds(candidate.p95),
            })}
          </p>
          <Disclosure label={messages.text('metrics.latency.show')}>{chart}</Disclosure>
        </>
      ) : (
        chart
      )}
    </div>
  );
}
