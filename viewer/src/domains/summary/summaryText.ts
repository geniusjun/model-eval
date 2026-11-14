import type { Lang } from '../../../../src/config/schema.js';
import { message } from '../../../../src/messages/index.js';
import { dollars, marginPoints, percent, ratio, seconds } from '../../../../src/report/format.js';
import type { Cell, Comparison, Gate, OpsChange } from '../../../../src/report/schema.js';
import type { Messages } from '../../i18n/useMessages.js';
import { cellLabel, isSameCell } from '../../utils/cell.js';

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

type ConclusionSource = Pick<Comparison, 'gate' | 'cells' | 'summary'>;

/** The cell that lost the most compliance among `cells`, or undefined when none has a difference. */
export function largestDrop(cells: readonly Cell[]): Cell | undefined {
  return cells
    .filter((cell) => cell.verdict === 'regressed' && cell.diff !== null)
    .reduce<Cell | undefined>(
      (worst, cell) =>
        worst === undefined || (cell.diff?.estimate ?? 0) < (worst.diff?.estimate ?? 0)
          ? cell
          : worst,
      undefined,
    );
}

/**
 * The gate outcome as one sentence built from the comparison alone: which cell blocks and how
 * far it fell, that nothing gated got worse, or why there is no result yet.
 */
export function conclusionText(comparison: ConclusionSource, messages: Messages): string {
  const { gate, cells, summary } = comparison;
  switch (gate.outcome) {
    case 'block': {
      const blocking = cells.filter((cell) => gate.blocking.some((key) => isSameCell(key, cell)));
      const worst = largestDrop(blocking);
      if (worst === undefined) {
        return messages.text('summary.conclusion.blockOther');
      }
      const params = {
        cell: cellLabel(worst),
        from: percent(worst.baseline.rate),
        to: percent(worst.candidate.rate),
        margin: marginPoints(worst.margin),
        count: gate.blocking.length,
      };
      return gate.blocking.length === 1
        ? messages.text('summary.conclusion.blockOne', params)
        : messages.text('summary.conclusion.blockMany', params);
    }
    case 'pass':
      return messages.text('summary.conclusion.pass');
    case 'no-gate':
      return messages.text('summary.conclusion.noGate');
    case 'undecided': {
      if (gate.reasons.some((reason) => reason.code === 'partial-run')) {
        return messages.text('summary.conclusion.withheld');
      }
      const undecided = cells.filter(
        (cell) =>
          cell.gated && (cell.verdict === 'inconclusive' || cell.verdict === 'insufficient'),
      ).length;
      return messages.text('summary.conclusion.undecided', {
        count: undecided === 0 ? summary.unknown.length : undecided,
      });
    }
  }
}

/** A change's ratio as report.md gives it, or the candidate over the baseline when it gives none. */
export function changeRatio(
  change: OpsChange | undefined,
  baseline: number | null,
  candidate: number | null,
): number | null {
  if (change?.ratio !== undefined && change.ratio !== null) {
    return change.ratio;
  }
  return baseline !== null && candidate !== null && baseline > 0 ? candidate / baseline : null;
}
