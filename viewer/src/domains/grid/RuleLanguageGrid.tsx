import { Fragment, useMemo } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { Cell, RuleSummary, Samples } from '../../../../src/report/schema.js';
import { pageMessages } from '../../i18n/useMessages.js';
import { buildGrid, type SurfaceGrid } from './buildGrid.js';
import { CellDetail } from './CellDetail.js';
import type { VariantIds } from '../../report/variants.js';
import { cellId, isSameCell, type CellPlace } from '../../utils/cell.js';
import { GridCell } from './GridCell.js';
import tableStyles from './table.module.css';
import { useSelectedCell } from './useSelectedCell.js';

interface RuleLanguageGridProps {
  readonly cells: readonly Cell[];
  /** The cell whose detail is open: the one the location hash names, if any. */
  readonly selected: Cell | undefined;
  readonly rules: readonly RuleSummary[];
  readonly samples: Samples;
  readonly variants: VariantIds;
  readonly lang: Lang;
}

interface SurfaceTableProps {
  readonly grid: SurfaceGrid;
  readonly selected: Cell | undefined;
  readonly lang: Lang;
  readonly onPressCell: (cell: Cell) => void;
  readonly cellRef: (cell: CellPlace) => (button: HTMLButtonElement | null) => void;
}

function SurfaceTable({ grid, selected, lang, onPressCell, cellRef }: SurfaceTableProps) {
  const messages = pageMessages(lang);
  return (
    <table className={tableStyles.table}>
      <caption>{messages.text('grid.caption', { surface: grid.surface })}</caption>
      <thead>
        <tr>
          <th scope="col">{messages.text('grid.column.rule')}</th>
          {grid.languages.map((language) => (
            <th key={language} scope="col">
              {language}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map((row) => (
          <tr key={row.ruleId}>
            <th scope="row">{row.ruleId}</th>
            {grid.languages.map((language, index) => {
              const cell = row.positions[index] ?? null;
              return (
                <td key={language}>
                  {cell !== null && (
                    <GridCell
                      cell={cell}
                      lang={lang}
                      expanded={selected !== undefined && isSameCell(cell, selected)}
                      onPressCell={onPressCell}
                      buttonRef={cellRef(cell)}
                    />
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The rule × language grid of each output surface (FR-003). A cell's detail opens directly after
 * the table of its surface, so it sits next to the cell that opened it.
 */
export function RuleLanguageGrid({
  cells,
  selected,
  rules,
  samples,
  variants,
  lang,
}: RuleLanguageGridProps) {
  const grids = useMemo(() => buildGrid(cells, rules), [cells, rules]);
  const { open, close, cellRef } = useSelectedCell(selected);
  // Pressing the cell whose detail is open closes it, so `aria-expanded` stays true to the page.
  const toggle = (cell: Cell) => {
    if (selected !== undefined && isSameCell(cell, selected)) {
      close();
    } else {
      open(cell);
    }
  };
  return (
    <div>
      {grids.map((grid) => (
        <Fragment key={grid.surface}>
          <SurfaceTable
            grid={grid}
            selected={selected}
            lang={lang}
            onPressCell={toggle}
            cellRef={cellRef}
          />
          {selected?.surface === grid.surface && (
            <CellDetail
              key={cellId(selected)}
              cell={selected}
              rules={rules}
              samples={samples}
              variants={variants}
              lang={lang}
              onClose={close}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
