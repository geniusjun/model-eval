import type { Ref } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent } from '../../../../src/report/format.js';
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

/**
 * One cell of the grid as a button that opens its detail. The rule and language are in the
 * table headers for sighted readers and in the button's own text for assistive technology.
 */
export function GridCell({ cell, lang, expanded, onPressCell, buttonRef }: GridCellProps) {
  const handleClick = () => {
    onPressCell(cell);
  };
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.cell}
      aria-expanded={expanded}
      onClick={handleClick}
    >
      <span className={styles.label}>{cellLabel(cell)}</span>{' '}
      <VerdictBadge verdict={cell.verdict} lang={lang} />{' '}
      <span className={styles.rates}>
        {percent(cell.baseline.rate)} → {percent(cell.candidate.rate)}
      </span>
    </button>
  );
}
