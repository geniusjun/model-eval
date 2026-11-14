import { message } from '../../../../src/messages/index.js';
import {
  dollars,
  percent,
  points,
  ratio,
  seconds,
  unsignedPoints,
} from '../../../../src/report/format.js';
import { opsRateNames, type Comparison, type OpsChange } from '../../../../src/report/schema.js';
import { Shape } from '../../components/Shape.js';
import type { Messages } from '../../i18n/useMessages.js';
import styles from './TradeOffs.module.css';
import { changeRatio, metricName } from './summaryText.js';

type Direction = 'up' | 'down' | 'same';

interface TradeRow {
  readonly key: string;
  readonly label: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
  readonly format: (value: number | null) => string;
  /** `×2.20` for an amount, `+2.7pp` for a rate. */
  readonly change: string;
  readonly direction: Direction;
  /** The warning code of `summary.ops` when the change passes its level. */
  readonly warning: string | undefined;
}

/** Ratios within 5% and differences under a tenth of a point count as no change. */
function ratioDirection(value: number | null): Direction {
  if (value === null || Math.abs(value - 1) < 0.05) {
    return 'same';
  }
  return value > 1 ? 'up' : 'down';
}

function pointsDirection(difference: number): Direction {
  if (Math.abs(difference) < 0.001) {
    return 'same';
  }
  return difference > 0 ? 'up' : 'down';
}

type Ops = Comparison['ops'];

function amountRow(
  key: string,
  label: string,
  values: { baseline: number | null; candidate: number | null },
  format: (value: number | null) => string,
  change: OpsChange | undefined,
): TradeRow {
  const factor = changeRatio(change, values.baseline, values.candidate);
  return {
    key,
    label,
    ...values,
    format,
    change: factor === null ? '—' : `×${ratio(factor)}`,
    direction: ratioDirection(factor),
    warning: change?.warning,
  };
}

/**
 * Cost, latency and the error rates that moved or count, lowest-is-best all: the cost per trial
 * and latency as ratios, rates as differences in points. A rate is listed when the summary lists
 * it or when either variant has one; the rest are 0 in both and named only as such.
 */
function tradeRows(
  ops: Ops,
  changes: readonly OpsChange[],
  messages: Messages,
): {
  rows: TradeRow[];
  quietRates: number;
} {
  const lang = messages.lang;
  const change = (metric: OpsChange['metric']) => changes.find((entry) => entry.metric === metric);
  // A trial costs a fraction of a cent; a thousand trials read as an amount. The ratio is the same.
  const perThousand = (value: number | null) => (value === null ? null : value * 1000);
  const rows: TradeRow[] = [
    amountRow(
      'cost',
      messages.text('summary.cost.per1000'),
      {
        baseline: perThousand(ops.baseline.costPerTrialUsd),
        candidate: perThousand(ops.candidate.costPerTrialUsd),
      },
      dollars,
      change('costPerTrial'),
    ),
    amountRow(
      'p50',
      message(lang, 'report.metric.latencyP50'),
      { baseline: ops.baseline.latencyMs.p50, candidate: ops.candidate.latencyMs.p50 },
      seconds,
      undefined,
    ),
    amountRow(
      'p95',
      metricName(lang, 'latencyP95'),
      { baseline: ops.baseline.latencyMs.p95, candidate: ops.candidate.latencyMs.p95 },
      seconds,
      change('latencyP95'),
    ),
  ];
  let quietRates = 0;
  for (const name of opsRateNames) {
    const baseline = ops.baseline.rates[name];
    const candidate = ops.candidate.rates[name];
    const listed = change(name);
    if (listed === undefined && baseline.count === 0 && candidate.count === 0) {
      quietRates += 1;
      continue;
    }
    const difference =
      baseline.rate === null || candidate.rate === null ? null : candidate.rate - baseline.rate;
    rows.push({
      key: name,
      label: metricName(lang, name),
      baseline: baseline.rate,
      candidate: candidate.rate,
      format: percent,
      change: difference === null ? '—' : points(difference),
      direction: difference === null ? 'same' : pointsDirection(difference),
      warning: listed?.warning,
    });
  }
  return { rows, quietRates };
}

const DOT = 9;

interface DumbbellProps {
  readonly title: string;
  readonly baseline: number | null;
  readonly candidate: number | null;
}

/** Baseline and candidate as two dots on one line from 0, grey then teal. */
function Dumbbell({ title, baseline, candidate }: DumbbellProps) {
  const top = Math.max(baseline ?? 0, candidate ?? 0);
  const x = (value: number) => (top === 0 ? 4 : 4 + (value / top) * 92);
  return (
    <svg className={styles.dumbbell} role="img" viewBox="0 0 100 10" preserveAspectRatio="none">
      <title>{title}</title>
      <line className={styles.track} x1={0} x2={100} y1={5} y2={5} />
      {baseline !== null && candidate !== null && (
        <line className={styles.span} x1={x(baseline)} x2={x(candidate)} y1={5} y2={5} />
      )}
      {baseline !== null && (
        <line
          className={styles.baseline}
          x1={x(baseline)}
          x2={x(baseline)}
          y1={5}
          y2={5}
          strokeWidth={DOT}
        />
      )}
      {candidate !== null && (
        <line
          className={styles.candidate}
          x1={x(candidate)}
          x2={x(candidate)}
          y1={5}
          y2={5}
          strokeWidth={DOT}
        />
      )}
    </svg>
  );
}

const DIRECTION_SHAPE = { up: 'triangle', down: 'circle' } as const;

type Warn = Comparison['config']['report']['warn'];

/** The level a warning code means, as the change beside it is written: `×2.00` or `+1.0pp`. */
function warningLevel(code: string, warn: Warn): string | undefined {
  switch (code) {
    case 'cost-ratio':
      return `×${ratio(warn.costRatio)}`;
    case 'latency-p95-ratio':
      return `×${ratio(warn.latencyP95Ratio)}`;
    case 'discard-rate-increase':
      return `+${unsignedPoints(warn.discardRateIncrease)}`;
    case 'regeneration-rate-increase':
      return `+${unsignedPoints(warn.regenerationRateIncrease)}`;
    default:
      return undefined;
  }
}

interface TradeOffsProps {
  readonly comparison: Pick<Comparison, 'ops' | 'summary' | 'baseline' | 'candidate' | 'config'>;
  readonly messages: Messages;
  readonly labelledBy: string;
}

/**
 * What the switch costs (plan D12): each measure as the baseline and candidate dots on one line
 * and the change as a large ratio or difference. Every measure here is better lower, so a rise is
 * marked with the red triangle and a fall with the green circle (as LangSmith flips the colour
 * of lower-is-better metrics); a change past its warning level carries the warning square.
 */
export function TradeOffs({ comparison, messages, labelledBy }: TradeOffsProps) {
  const { rows, quietRates } = tradeRows(comparison.ops, comparison.summary.ops, messages);
  const variants = {
    baseline: comparison.baseline.variant.id,
    candidate: comparison.candidate.variant.id,
  };
  return (
    <>
      <table className={styles.table} aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col" className={styles.measure}>
              {messages.text('summary.cost.metric')}
            </th>
            <th scope="col" className={styles.chartHead}>
              <span className={styles.hidden}>{messages.text('summary.cost.chart')}</span>
              <span className={styles.legend} aria-hidden="true">
                <span className={styles.legendBaseline}>
                  {`${messages.text('role.baseline')} (${variants.baseline})`}
                </span>
                <span className={styles.legendCandidate}>
                  {`${messages.text('role.candidate')} (${variants.candidate})`}
                </span>
              </span>
            </th>
            <th scope="col" className={styles.values}>
              {messages.text('summary.cost.values')}
            </th>
            <th scope="col" className={styles.change}>
              {messages.text('summary.cost.change')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              data-direction={row.direction}
              data-warning={row.warning !== undefined}
            >
              <th scope="row" className={styles.measure}>
                {row.label}
              </th>
              <td className={styles.chartCell}>
                {row.baseline !== null && row.format(row.baseline) === row.format(row.candidate) ? (
                  <span className={styles.unchanged}>{messages.text('summary.cost.same')}</span>
                ) : (
                  <Dumbbell
                    title={messages.text('summary.cost.title', {
                      metric: row.label,
                      baseline: row.format(row.baseline),
                      candidate: row.format(row.candidate),
                    })}
                    baseline={row.baseline}
                    candidate={row.candidate}
                  />
                )}
              </td>
              <td className={styles.values}>
                {`${row.format(row.baseline)} → ${row.format(row.candidate)}`}
                {row.warning !== undefined && (
                  <span className={styles.warning}>
                    <Shape kind="square" />
                    {messages.text('summary.opsWarning', {
                      threshold: warningLevel(row.warning, comparison.config.report.warn) ?? '',
                    })}
                  </span>
                )}
              </td>
              <td className={styles.change}>
                {row.direction !== 'same' && <Shape kind={DIRECTION_SHAPE[row.direction]} />}
                <span className={styles.changeValue}>{row.change}</span>
                {row.direction !== 'same' && (
                  <span className={styles.hidden}>
                    {` ${messages.text(row.direction === 'up' ? 'summary.cost.up' : 'summary.cost.down')}`}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {quietRates > 0 && (
        <p className={styles.quiet}>{messages.text('summary.cost.otherRatesZero')}</p>
      )}
    </>
  );
}
