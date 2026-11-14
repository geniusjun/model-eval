import { Fragment, useMemo } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { Cell, RuleSummary, Samples, Verdict } from '../../../../src/report/schema.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import { pageMessages } from '../../i18n/useMessages.js';
import { buildGrid, type SurfaceGrid } from './buildGrid.js';
import { CellDetail } from './CellDetail.js';
import { cellId, isSameCell, type CellPlace } from '../../utils/cell.js';
import type { SideView } from '../../utils/hash.js';
import { GridCell } from './GridCell.js';
import styles from './RuleLanguageGrid.module.css';
import tableStyles from './table.module.css';
import { useSelectedCell } from './useSelectedCell.js';

interface RuleLanguageGridProps {
  readonly cells: readonly Cell[];
  /** The cell whose detail is open: the one the location hash names, if any. */
  readonly selected: Cell | undefined;
  readonly rules: readonly RuleSummary[];
  readonly samples: Samples;
  readonly lang: Lang;
  /** The location of a side-by-side position, for the links from failing examples. */
  readonly sideHref: (view: SideView) => string;
}

interface SurfaceTableProps {
  readonly grid: SurfaceGrid;
  readonly selected: Cell | undefined;
  readonly lang: Lang;
  readonly onPressCell: (cell: Cell) => void;
  readonly cellRef: (cell: CellPlace) => (button: HTMLButtonElement | null) => void;
}

/**
 * The narrowest a surface's table may get: the rule column and a usable width per language.
 * Below it the table scrolls sideways inside the grid.
 */
function minTableWidth(languages: number) {
  return { minWidth: `calc(var(--rule-column) + var(--language-column) * ${String(languages)})` };
}

function SurfaceTable({ grid, selected, lang, onPressCell, cellRef }: SurfaceTableProps) {
  const messages = pageMessages(lang);
  return (
    <table
      className={[tableStyles.table, tableStyles.grid].filter(Boolean).join(' ')}
      style={minTableWidth(grid.languages.length)}
    >
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

/** Order of the key: what changed first, then what did not, then what could not be judged. */
const LEGEND_ORDER: readonly Verdict[] = [
  'regressed',
  'improved',
  'non-inferior',
  'inconclusive',
  'insufficient',
  'not-applicable',
];

function Legend({ lang }: { readonly lang: Lang }) {
  const messages = pageMessages(lang);
  return (
    <ul className={styles.legend} aria-label={messages.text('grid.legend')}>
      {LEGEND_ORDER.map((verdict) => (
        <li key={verdict}>
          <VerdictBadge verdict={verdict} lang={lang} quiet />
        </li>
      ))}
    </ul>
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
  lang,
  sideHref,
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
    <div className={styles.grids}>
      <Legend lang={lang} />
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
              lang={lang}
              onClose={close}
              sideHref={sideHref}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
