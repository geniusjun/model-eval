import type { Ref } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent, points } from '../../../../src/report/format.js';
import type { Cell } from '../../../../src/report/schema.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import { cellLabel } from '../../utils/cell.js';
import styles from './GridCell.module.css';

interface GridCellProps {
  readonly cell: Cell;
  readonly lang: Lang;
  /** Whether this cell's detail is open. */
  readonly expanded: boolean;
  readonly onPressCell: (cell: Cell) => void;
  readonly buttonRef: Ref<HTMLButtonElement>;
}

/** The difference of a cell that moved, `-43.3pp`; held and undecided cells leave it out. */
function movedBy(cell: Cell): string | undefined {
  const moved = cell.verdict === 'regressed' || cell.verdict === 'improved';
  return moved && cell.diff !== null ? points(cell.diff.estimate) : undefined;
}

/**
 * One cell of the grid as a button that opens its detail. The rule and language are in the
 * table headers for sighted readers and in the button's own text for assistive technology. A
 * regressed cell leads with its verdict, every other cell with its rate. The candidate's rate is
 * the figure, and the baseline's leads into it only when the two differ, so a cell that did not
 * move shows one number. A held cell, the common case, shows only the equals sign; the key names
 * it and assistive technology reads the word.
 */
export function GridCell({ cell, lang, expanded, onPressCell, buttonRef }: GridCellProps) {
  const handleClick = () => {
    onPressCell(cell);
  };
  const moved = movedBy(cell);
  const from = percent(cell.baseline.rate);
  const to = percent(cell.candidate.rate);
  const regressed = cell.verdict === 'regressed';
  const badge = (
    <VerdictBadge
      verdict={cell.verdict}
      lang={lang}
      quiet
      shapeOnly={cell.verdict === 'non-inferior'}
    />
  );
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.cell}
      data-verdict={cell.verdict}
      aria-expanded={expanded}
      onClick={handleClick}
    >
      <span className={styles.label}>{cellLabel(cell)}</span> {regressed && <>{badge} </>}
      <span className={styles.rates}>
        {from !== to && <span className={styles.from}>{`${from} → `}</span>}
        <span className={styles.to}>{to}</span>
        <span className={styles.counts}>
          {` ${String(cell.candidate.passes)}/${String(cell.candidate.trials)}`}
        </span>
        {moved !== undefined && <span className={styles.moved}>{` ${moved}`}</span>}
      </span>
      {!regressed && <> {badge}</>}
    </button>
  );
}
