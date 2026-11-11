import type { Lang } from '../config/schema.js';
import { message } from '../messages/index.js';
import type { Warning } from '../run/warning.js';
import { NONE, percent, ratio, unsignedPoints, usd } from './format.js';
import type { CellNote, GateReason, Needed, Verdict } from './schema.js';

/**
 * Turns the codes of a Comparison (verdicts, notes, trials needed, warnings, gate reasons) into
 * the text of the message files (data-model §Warnings, Text). `quote` wraps text that came from
 * the adapter, the model or the service, so each output format can keep it inert.
 */
export type Quote = (text: string) => string;

export function verdictText(lang: Lang, verdict: Verdict): string {
  return message(lang, `verdict.${verdict}`);
}

export function noteText(lang: Lang, note: CellNote): string {
  return message(lang, `note.${note}`);
}

/** `currentTrials` is the cell's `candidate.trials` (data-model §Cell, `needed`). */
export function neededText(lang: Lang, needed: Needed, currentTrials: number): string {
  switch (needed.kind) {
    case 'repeats': {
      const text = message(lang, 'needed.repeats', {
        repeats: needed.repeats,
        cellTrials: needed.cellTrials,
        currentTrials,
        trialsPerVariant: needed.trialsPerVariant,
      });
      return needed.nearMargin ? `${text}; ${message(lang, 'needed.nearMargin')}` : text;
    }
    case 'cases':
      return message(lang, 'needed.cases', { cases: needed.cases });
    case 'on-margin':
      return message(lang, 'needed.on-margin');
  }
}

/** Params that hold adapter, model or service text rather than codes and identifiers. */
const QUOTED_PARAMS: ReadonlySet<string> = new Set(['sentence', 'message', 'models']);

/** Warnings whose `threshold` is a difference of two rates rather than a rate or a ratio. */
const DIFFERENCE_THRESHOLDS: ReadonlySet<string> = new Set([
  'discard-rate-increase',
  'regeneration-rate-increase',
]);

type NumberFormat = (value: number) => string;

function numberFormat(code: string, param: string): NumberFormat {
  switch (param) {
    case 'rates':
    case 'rate':
    case 'share':
      return percent;
    case 'ratio':
      return ratio;
    case 'threshold':
      if (DIFFERENCE_THRESHOLDS.has(code)) {
        return unsignedPoints;
      }
      return code === 'transient-rate' ? percent : ratio;
    default:
      return param.endsWith('Usd') ? usd : String;
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ValueStyle {
  readonly format: NumberFormat;
  readonly quote: Quote | undefined;
}

/** Writes params objects and lists out: `current 0.3%, next 3.0%`, `next (timeout 1, restart 0)`. */
function valueText(value: unknown, style: ValueStyle): string {
  if (typeof value === 'string') {
    return style.quote === undefined ? value : style.quote(value);
  }
  if (typeof value === 'number') {
    return style.format(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  const nested = (member: unknown): string =>
    typeof member === 'object' && member !== null
      ? `(${valueText(member, style)})`
      : valueText(member, style);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.length === 0 ? NONE : items.map(nested).join(', ');
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? NONE
      : entries.map(([key, member]) => `${key} ${nested(member)}`).join(', ');
  }
  return NONE;
}

function paramsText(
  code: string,
  params: Readonly<Record<string, unknown>>,
  quote: Quote,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([param, value]) => [
      param,
      valueText(value, {
        format: numberFormat(code, param),
        quote: QUOTED_PARAMS.has(param) ? quote : undefined,
      }),
    ]),
  );
}

type AbandonedTrials = Extract<Warning, { code: 'abandoned-trials' }>;

/**
 * Without a trial abandoned at the time limit, only the restarts are stated: the time limit and
 * late failures would say nothing. Variants without late failures are left out of them.
 */
function abandonedText(lang: Lang, warning: AbandonedTrials, quote: Quote): string {
  const { trials, lateFailures } = warning.params;
  if (Object.values(trials).every((counts) => counts.timeout === 0)) {
    return message(lang, 'warning.abandoned-trials.restarts', {
      trials: valueText(trials, { format: String, quote: undefined }),
    });
  }
  const failed = Object.fromEntries(
    Object.entries(lateFailures).filter(([, kinds]) => Object.keys(kinds).length > 0),
  );
  const params = paramsText(warning.code, { ...warning.params, lateFailures: failed }, quote);
  return message(lang, 'warning.abandoned-trials', params);
}

export function warningText(lang: Lang, warning: Warning, quote: Quote): string {
  if (warning.code === 'abandoned-trials') {
    return abandonedText(lang, warning, quote);
  }
  const params = 'params' in warning ? paramsText(warning.code, warning.params, quote) : {};
  return message(lang, `warning.${warning.code}`, params);
}

export function reasonText(lang: Lang, reason: GateReason, quote: Quote): string {
  const params = 'params' in reason ? paramsText(reason.code, reason.params, quote) : {};
  return message(lang, `reason.${reason.code}`, params);
}
