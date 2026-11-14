import { useId, type ReactNode } from 'react';

import styles from './metrics.module.css';

export interface EntryRow {
  readonly key: string;
  readonly cells: readonly ReactNode[];
}

interface EntryTableProps {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly EntryRow[];
  /** Shown in place of the table when there is no row. */
  readonly emptyText: string;
}

/** A titled list of per-variant entries, such as top messages; a sentence when it is empty. */
export function EntryTable({ title, columns, rows, emptyText }: EntryTableProps) {
  const headingId = useId();
  return (
    <div className={styles.entry}>
      <h3 id={headingId}>{title}</h3>
      {rows.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <table className={styles.table} aria-labelledby={headingId}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, index) => (
                  <td key={columns[index]}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
