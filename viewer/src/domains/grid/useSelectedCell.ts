import { useCallback, useEffect, useRef } from 'react';

import type { Cell } from '../../../../src/report/schema.js';
import { useHashParam } from '../../hooks/useHashParam.js';
import { cellId, type CellPlace } from '../../utils/cell.js';

export interface CellSelection {
  readonly open: (cell: CellPlace) => void;
  /** Closes the detail and puts focus back on the button of the cell it showed. */
  readonly close: () => void;
  /** A ref for the button of `cell`, so focus can return to it when its detail closes. */
  readonly cellRef: (cell: CellPlace) => (button: HTMLButtonElement | null) => void;
}

/**
 * Opens and closes cell details through the location hash (page-data §Location Hash). `selected`
 * is the cell the hash names, resolved by the page.
 */
export function useSelectedCell(selected: Cell | undefined): CellSelection {
  const [hash, setHash] = useHashParam();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const shown = useRef(selected);
  const { lang } = hash;

  const focusCell = useCallback((cell: CellPlace) => {
    buttons.current.get(cellId(cell))?.focus();
  }, []);

  // A detail can also close from outside, as when the browser goes back. Focus was inside it and
  // fell to the body when it left the page, so it goes back to the cell's button.
  useEffect(() => {
    const previous = shown.current;
    shown.current = selected;
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    if (previous !== undefined && previous !== selected && focusLost) {
      focusCell(previous);
    }
  }, [selected, focusCell]);

  const open = useCallback(
    (cell: CellPlace) => {
      setHash({
        view: { kind: 'cell', ruleId: cell.ruleId, lang: cell.lang, surface: cell.surface },
        lang,
      });
    },
    [setHash, lang],
  );

  const close = useCallback(() => {
    setHash({ view: { kind: 'summary' }, lang });
    if (selected !== undefined) {
      focusCell(selected);
    }
  }, [setHash, lang, selected, focusCell]);

  const cellRef = useCallback(
    (cell: CellPlace) => (button: HTMLButtonElement | null) => {
      const id = cellId(cell);
      if (button === null) {
        buttons.current.delete(id);
      } else {
        buttons.current.set(id, button);
      }
    },
    [],
  );

  return { open, close, cellRef };
}
