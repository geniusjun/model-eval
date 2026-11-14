import { Fragment, useId, useState, type CSSProperties } from 'react';

import {
  factor,
  marginPoints,
  percent,
  points,
  pointsInterval,
} from '../../../../src/report/format.js';
import type { Cell, Comparison, Summary } from '../../../../src/report/schema.js';
import {
  DiffChart,
  diffScale,
  scaleX,
  type DiffScale,
  type DiffTone,
} from '../../components/DiffChart.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import { useHashParam } from '../../hooks/useHashParam.js';
import type { Messages } from '../../i18n/useMessages.js';
import { cellLabel, isSameCell } from '../../utils/cell.js';
import { formatHash } from '../../utils/hash.js';
import styles from './ChangePlot.module.css';

type SummaryCell = Summary['worse'][number];

/** The groups of the chart: the three lists of 001 FR-028, then the gated cells that held. */
type GroupKey = 'worse' | 'improved' | 'unknown' | 'held';

interface Row {
  readonly cell: Cell;
  readonly entry: SummaryCell | undefined;
}

interface Group {
  readonly key: GroupKey;
  readonly rows: readonly Row[];
}

/** Held gated cells fold into one row from this many on. */
const FOLD_HELD_FROM = 3;

const GROUP_TITLE: Readonly<Record<GroupKey, Parameters<Messages['text']>[0]>> = {
  worse: 'summary.worse',
  improved: 'summary.improved',
  unknown: 'summary.unknown',
  held: 'summary.changes.held',
};

/**
 * Red for a regression and green for an improvement; grey says the data cannot tell yet. A cell
 * outside the gate cannot block, so it is an outline behind the rest.
 */
function toneOf(cell: Cell): DiffTone {
  if (!cell.gated) {
    return 'outside';
  }
  if (cell.verdict === 'regressed') {
    return 'regressed';
  }
  return cell.verdict === 'improved' ? 'improved' : 'neutral';
}

/** Largest drop first; cells without a difference last. */
function byDifference(a: Row, b: Row): number {
  return (a.cell.diff?.estimate ?? Infinity) - (b.cell.diff?.estimate ?? Infinity);
}

function rowsOf(entries: readonly SummaryCell[], cells: readonly Cell[]): Row[] {
  return entries
    .flatMap((entry) => {
      const cell = cells.find((candidate) => isSameCell(candidate, entry));
      return cell === undefined ? [] : [{ cell, entry }];
    })
    .sort(byDifference);
}

/**
 * The rows of the chart. A cell with a confirmed drop that is still undecided is listed in
 * `summary` under worse and undecided; the chart shows it once, under worse, with what a new run
 * needs.
 */
function groupsOf(summary: Summary, cells: readonly Cell[]): Group[] {
  const worse = rowsOf(summary.worse, cells);
  const listed = (cell: Cell) =>
    [...summary.worse, ...summary.improved, ...summary.unknown].some((entry) =>
      isSameCell(entry, cell),
    );
  const unknown = rowsOf(
    summary.unknown.filter((entry) => !summary.worse.some((worst) => isSameCell(worst, entry))),
    cells,
  );
  const held = cells
    .filter((cell) => cell.gated && cell.verdict === 'non-inferior' && !listed(cell))
    .map((cell) => ({ cell, entry: undefined }))
    .sort(byDifference);
  return [
    { key: 'worse', rows: worse },
    { key: 'improved', rows: rowsOf(summary.improved, cells) },
    { key: 'unknown', rows: unknown },
    { key: 'held', rows: held },
  ];
}

/** One scale for every row of the chart. */
function scaleOf(rows: readonly Row[]): DiffScale | undefined {
  return diffScale(
    rows.flatMap(({ cell }) =>
      cell.diff === null ? [] : [{ low: cell.diff.low, high: cell.diff.high, margin: cell.margin }],
    ),
  );
}

/** `-20`, `0`, `+10`: an axis label in percentage points without the unit. */
function tickText(tick: number): string {
  const value = Math.round(tick * 100);
  return value > 0 ? `+${String(value)}` : String(value);
}

/** `failures ×45`, or `0 baseline failures` when the baseline never failed, else nothing. */
function failuresText(cell: Cell, messages: Messages): string | undefined {
  if (cell.failRatio !== null) {
    return messages.text('summary.changes.failRatio', { ratio: `×${factor(cell.failRatio)}` });
  }
  return cell.baseline.rate === 1 ? messages.text('summary.changes.baselineZero') : undefined;
}

interface ChartCellProps {
  readonly className: string | undefined;
  readonly colSpan?: number;
  readonly cell: Cell;
  readonly label: string;
  readonly tone: DiffTone;
  readonly scale: DiffScale | undefined;
  readonly messages: Messages;
}

/**
 * The chart of one cell. The cell draws the zero and margin lines as its background, so they run
 * the full height of the row and read as one line down the table.
 */
function ChartCell({ className, colSpan, cell, label, tone, scale, messages }: ChartCellProps) {
  const guides =
    scale === undefined
      ? undefined
      : ({
          '--zero': `${String(scaleX(0, scale))}%`,
          '--margin': `${String(scaleX(-cell.margin, scale))}%`,
        } as CSSProperties);
  return (
    <td className={className} colSpan={colSpan} style={guides}>
      {scale !== undefined && cell.diff !== null && (
        <DiffChart
          title={messages.text('summary.changes.chartTitle', {
            cell: label,
            difference: points(cell.diff.estimate),
            interval: pointsInterval(cell.diff.low, cell.diff.high),
            margin: marginPoints(cell.margin),
          })}
          estimate={cell.diff.estimate}
          low={cell.diff.low}
          high={cell.diff.high}
          margin={cell.margin}
          scale={scale}
          tone={tone}
          guides={false}
        />
      )}
    </td>
  );
}

/** The axis labels, each at its value on the shared scale. */
function Ticks({ scale }: { readonly scale: DiffScale }) {
  return (
    <span className={styles.ticks} aria-hidden="true">
      {scale.ticks.map((tick) => (
        <span
          key={tick}
          className={styles.tick}
          style={{ left: `${String(scaleX(tick, scale))}%` }}
        >
          {tickText(tick)}
        </span>
      ))}
    </span>
  );
}

/** `149/150`: passes of trials, the count behind a rate. */
function countText(rate: Cell['baseline']): string {
  return `${String(rate.passes)}/${String(rate.trials)}`;
}

/** The note every row of a group shares, which the group's head then states once. */
function sharedNote(rows: readonly Row[]): SummaryCell['note'] {
  const [first, ...rest] = rows.map((row) => row.entry?.note);
  return first !== undefined && rest.every((note) => note === first) ? first : undefined;
}

interface ChangeRowProps {
  readonly row: Row;
  /** Whether the cell is one of `gate.blocking`. */
  readonly blocking: boolean;
  /** Whether its group's head already states the row's note. */
  readonly noteInHead: boolean;
  readonly tone: DiffTone;
  readonly scale: DiffScale | undefined;
  readonly cellHref: (cell: Cell) => string;
  readonly messages: Messages;
}

function ChangeRow({ row, blocking, noteInHead, tone, scale, cellHref, messages }: ChangeRowProps) {
  const { cell, entry } = row;
  const label = cellLabel(cell);
  const facts = [
    failuresText(cell, messages),
    ...(entry?.note === undefined || noteInHead ? [] : [messages.note(entry.note)]),
    ...(cell.needed === undefined ? [] : [messages.needed(cell.needed, cell.candidate.trials)]),
  ].filter((fact) => fact !== undefined);
  return (
    <tr className={styles.row} data-tone={tone}>
      <th scope="row" className={styles.cellHead}>
        <a className={styles.cellLink} href={cellHref(cell)}>
          {label}
        </a>
        {blocking && (
          <span className={styles.blockingTag}>{messages.text('summary.changes.blocking')}</span>
        )}
        {!cell.gated && (
          <span className={styles.notGated}>{messages.text('summary.changes.notGated')}</span>
        )}
        <span className={styles.facts}>
          <VerdictBadge verdict={cell.verdict} lang={messages.lang} />
          <span className={styles.rates}>
            {percent(cell.baseline.rate)}
            <span className={styles.counts}>{` (${countText(cell.baseline)})`}</span>
            {' → '}
            <span className={styles.to}>{percent(cell.candidate.rate)}</span>
            <span className={styles.counts}>{` (${countText(cell.candidate)})`}</span>
          </span>
          <span className={styles.more}>{facts.join(' · ')}</span>
        </span>
      </th>
      <ChartCell
        className={styles.chartCell}
        cell={cell}
        label={label}
        tone={tone}
        scale={scale}
        messages={messages}
      />
      <td className={styles.difference}>
        {cell.diff === null ? (
          <span className={styles.value}>—</span>
        ) : (
          <>
            <span className={styles.value}>{points(cell.diff.estimate)}</span>
            <span className={styles.interval}>{pointsInterval(cell.diff.low, cell.diff.high)}</span>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * The rows of one cell: its row, then the same chart again across the full width, which only a
 * narrow screen shows, in place of the chart column it hides.
 */
function ChangeRows(props: ChangeRowProps) {
  const { row, tone, scale, messages } = props;
  return (
    <>
      <ChangeRow {...props} />
      <tr className={styles.narrowRow} data-tone={tone}>
        <ChartCell
          className={styles.narrowChart}
          colSpan={3}
          cell={row.cell}
          label={cellLabel(row.cell)}
          tone={tone}
          scale={scale}
          messages={messages}
        />
      </tr>
    </>
  );
}

interface ChangePlotProps {
  readonly comparison: Pick<Comparison, 'cells' | 'summary' | 'gate'>;
  readonly messages: Messages;
  /** The `id` of the heading that names the chart. */
  readonly labelledBy: string;
}

/**
 * The worse, better and undecided cells of the summary, and the gated cells that held, as one
 * chart of differences on a shared scale (plan D6, D12): one row per cell, largest drop first
 * within each group, with the zero line and the margin. Each row names its cell, links to its
 * detail and states the verdict, both rates and the difference with its interval as text.
 * Groups without a cell share one quiet line; many held cells fold into one row.
 */
export function ChangePlot({ comparison, messages, labelledBy }: ChangePlotProps) {
  const [hash] = useHashParam();
  const [showHeld, setShowHeld] = useState(false);
  const heldId = useId();
  const groups = groupsOf(comparison.summary, comparison.cells);
  const scale = scaleOf(groups.flatMap((group) => group.rows));
  const cellHref = (cell: Cell) =>
    formatHash({
      view: { kind: 'cell', ruleId: cell.ruleId, lang: cell.lang, surface: cell.surface },
      lang: hash.lang,
    });
  // Neighbouring groups without a cell share one line: "Better 0 · Undecided 0".
  const runs: (Group | Group[])[] = [];
  for (const group of groups) {
    if (group.rows.length > 0) {
      runs.push(group);
    } else if (group.key !== 'held') {
      const last = runs.at(-1);
      if (Array.isArray(last)) {
        last.push(group);
      } else {
        runs.push([group]);
      }
    }
  }
  return (
    <table className={styles.plot} aria-labelledby={labelledBy}>
      {/* Column widths live here, so a narrow screen can give the hidden chart column none. */}
      <colgroup>
        <col className={styles.cellColumn} />
        <col className={styles.chartColumn} />
        <col className={styles.differenceColumn} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={styles.cellHead}>
            {messages.text('summary.changes.cell')}
          </th>
          <th scope="col" className={styles.axisHead}>
            <span className={styles.hidden}>{messages.text('summary.changes.chart')}</span>
            {scale !== undefined && <Ticks scale={scale} />}
          </th>
          <th scope="col" className={styles.difference}>
            {messages.text('summary.changes.difference')}
          </th>
        </tr>
        {scale !== undefined && (
          <tr className={styles.narrowAxis}>
            <td colSpan={3}>
              <Ticks scale={scale} />
            </td>
          </tr>
        )}
      </thead>
      {runs.map((run) => {
        if (Array.isArray(run)) {
          return (
            <tbody key={run.map((group) => group.key).join('-')}>
              <tr className={styles.emptyGroups}>
                <th scope="rowgroup" colSpan={3}>
                  {run.map((group, index) => (
                    <Fragment key={group.key}>
                      {index > 0 && <span aria-hidden="true">{' · '}</span>}
                      <span className={styles.emptyGroup}>
                        {`${messages.text(GROUP_TITLE[group.key])} `}
                        <span className={styles.count}>0</span>
                      </span>
                    </Fragment>
                  ))}
                </th>
              </tr>
            </tbody>
          );
        }
        const folded = run.key === 'held' && run.rows.length >= FOLD_HELD_FROM && !showHeld;
        const note = sharedNote(run.rows);
        return (
          <tbody key={run.key} id={run.key === 'held' ? heldId : undefined}>
            <tr className={styles.groupRow} data-group={run.key}>
              <th scope="rowgroup" colSpan={3}>
                <span className={styles.groupTitle}>{messages.text(GROUP_TITLE[run.key])}</span>{' '}
                <span className={styles.count}>{run.rows.length}</span>
                {note !== undefined && (
                  <span className={styles.groupNote}>{` · ${messages.note(note)}`}</span>
                )}
                {run.key === 'held' && run.rows.length >= FOLD_HELD_FROM && (
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={showHeld}
                    aria-controls={heldId}
                    onClick={() => {
                      setShowHeld(!showHeld);
                    }}
                  >
                    {showHeld
                      ? messages.text('summary.changes.hideHeld')
                      : messages.text('summary.changes.showHeld', { count: run.rows.length })}
                  </button>
                )}
              </th>
            </tr>
            {!folded &&
              run.rows.map((row) => (
                <ChangeRows
                  key={cellLabel(row.cell)}
                  blocking={comparison.gate.blocking.some((key) => isSameCell(key, row.cell))}
                  noteInHead={note !== undefined}
                  row={row}
                  tone={toneOf(row.cell)}
                  scale={scale}
                  cellHref={cellHref}
                  messages={messages}
                />
              ))}
          </tbody>
        );
      })}
    </table>
  );
}
