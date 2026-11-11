/** Number formats shared by the report's tables and the params of its message texts. */

/** Shown for a value that does not exist, such as the rate of a cell without judged trials. */
export const NONE = '—';

const significant = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 3,
  useGrouping: false,
});

function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

/** A share as a percentage: 0.993 → `99.3%`. */
export function percent(share: number | null): string {
  return share === null ? NONE : `${(share * 100).toFixed(1)}%`;
}

/** A rate interval in percent: `[95.3, 100.0]`. */
export function percentInterval(low: number | null, high: number | null): string {
  return low === null || high === null
    ? ''
    : `[${(low * 100).toFixed(1)}, ${(high * 100).toFixed(1)}]`;
}

/** A difference of shares in percentage points: −0.293 → `-29.3pp`. */
export function points(difference: number): string {
  return `${signed(difference * 100, 1)}pp`;
}

/** A threshold on a difference of shares, without a sign: 0.01 → `1.0pp`. */
export function unsignedPoints(difference: number): string {
  return `${(difference * 100).toFixed(1)}pp`;
}

/** A margin in percentage points, without decimals when whole: 0.1 → `10pp`, 0.025 → `2.5pp`. */
export function marginPoints(margin: number): string {
  const tenths = Math.round(margin * 1000);
  return tenths % 10 === 0 ? `${String(tenths / 10)}pp` : `${(tenths / 10).toFixed(1)}pp`;
}

/** A difference interval in percentage points: `[-37.1, -19.2]`. */
export function pointsInterval(low: number, high: number): string {
  return `[${signed(low * 100, 1)}, ${signed(high * 100, 1)}]`;
}

/** A factor with three significant digits: 45.03 → `45`, 2.857 → `2.86`. */
export function factor(value: number): string {
  return significant.format(value);
}

export function ratio(value: number): string {
  return value.toFixed(2);
}

/** Amounts in USD keep three significant digits, since a trial often costs a fraction of a cent. */
export function usd(value: number | null): string {
  return value === null ? NONE : significant.format(value);
}

/** An amount with a dollar sign: 0.00017 → `$0.00017`. */
export function dollars(value: number | null): string {
  return value === null ? NONE : `$${usd(value)}`;
}

/** A duration in seconds with one decimal: 1900 ms → `1.9s`. */
export function seconds(milliseconds: number | null): string {
  return milliseconds === null ? NONE : `${(milliseconds / 1000).toFixed(1)}s`;
}

/** A mean token count with at most one decimal: 10.33 → `10.3`, 50 → `50`. */
export function tokenMean(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function milliseconds(value: number | null): string {
  return value === null ? NONE : `${String(Math.round(value))} ms`;
}
