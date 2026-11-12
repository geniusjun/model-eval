import type { Lang } from '../../../../src/config/schema.js';
import { message } from '../../../../src/messages/index.js';
import { dollars, percent, ratio, seconds } from '../../../../src/report/format.js';
import type { Gate, OpsChange } from '../../../../src/report/schema.js';
import type { Messages } from '../../i18n/useMessages.js';

// The texts of the decision summary, written as report.md writes them (001 FR-029), so the page
// and the report read the same.

export function outcomeText(lang: Lang, outcome: Gate['outcome']): string {
  return message(lang, `report.outcome.${outcome}`);
}

export function metricName(lang: Lang, metric: OpsChange['metric']): string {
  return message(lang, `report.metric.${metric}`);
}

function metricValue(metric: OpsChange['metric'], value: number | null): string {
  switch (metric) {
    case 'latencyP95':
      return seconds(value);
    case 'costPerTrial':
      return dollars(value);
    default:
      return percent(value);
  }
}

/** `$0.00017 → $0.00038 · ×2.20 · warning cost-ratio`. */
export function opsChangeText(change: OpsChange, messages: Messages): string {
  const parts = [
    `${metricValue(change.metric, change.baseline)} → ${metricValue(change.metric, change.candidate)}`,
  ];
  if (change.ratio !== undefined && change.ratio !== null) {
    parts.push(`×${ratio(change.ratio)}`);
  }
  if (change.warning !== undefined) {
    parts.push(messages.text('summary.opsWarning', { code: change.warning }));
  }
  return parts.join(' · ');
}
