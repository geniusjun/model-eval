import type { Lang } from '../../../src/config/schema.js';
import { message } from '../../../src/messages/index.js';
import { factor, NONE, percent, percentInterval } from '../../../src/report/format.js';
import type { Cell, Rate } from '../../../src/report/schema.js';

// How the page names and reads cells, written as report.md writes them (001 FR-029), so the page
// and the report say the same.

/** What names a cell: in the comparison, in `gate.blocking`, in `samples.failing` and in the hash. */
export interface CellPlace {
  readonly ruleId: string;
  readonly lang: string;
  readonly surface: string;
}

/** As much of a cell's place as a gate reason or a warning names. */
export interface Place {
  readonly ruleId?: string | undefined;
  readonly lang?: string | undefined;
  readonly surface?: string | undefined;
}

export function isSameCell(a: CellPlace, b: CellPlace): boolean {
  return a.ruleId === b.ruleId && a.lang === b.lang && a.surface === b.surface;
}

/** `script-ja (ja, raw)`. */
export function cellLabel(cell: CellPlace): string {
  return `${cell.ruleId} (${cell.lang}, ${cell.surface})`;
}

/** `script-ja (ja, raw)`, or as much of it as the place names: `script-ja (ja)`, `script-ja`. */
export function placeLabel(place: Place): string | undefined {
  const where = [place.lang, place.surface].filter((part) => part !== undefined).join(', ');
  const parts = [place.ruleId, where === '' ? undefined : `(${where})`].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** A string that tells cells apart even when an ID or language holds spaces or brackets. */
export function cellId(cell: CellPlace): string {
  return JSON.stringify([cell.ruleId, cell.lang, cell.surface]);
}

/** `99.3% [95.3, 100.0]`, or the rate alone when it has no interval. */
export function rateText(rate: Pick<Rate, 'rate' | 'low' | 'high'>): string {
  const interval = percentInterval(rate.low, rate.high);
  return interval === '' ? percent(rate.rate) : `${percent(rate.rate)} ${interval}`;
}

/** `×45`; without a ratio, "baseline 0" when the baseline never failed, else —. */
export function failRatioText(cell: Pick<Cell, 'failRatio' | 'baseline'>, lang: Lang): string {
  if (cell.failRatio !== null) {
    return `×${factor(cell.failRatio)}`;
  }
  return cell.baseline.rate === 1 ? message(lang, 'report.baselineZero') : NONE;
}
