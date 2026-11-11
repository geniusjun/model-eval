// Column layout of human output and the lines the Output layer writes.

export type Align = 'left' | 'right';

export const INDENT = '  ';
const GAP = 2;

/** Hangul, kana, Han and full-width forms take two terminal columns. */
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += WIDE.test(character) ? 2 : 1;
  }
  return width;
}

export interface Layout {
  readonly align?: readonly Align[];
  /** Spaces before each column; two where it gives none. */
  readonly gaps?: readonly number[];
  readonly indent?: string;
}

/** Pads every column but the last to its widest cell, in terminal columns. */
export function aligned(
  rows: readonly (readonly string[])[],
  { align = [], gaps = [], indent = INDENT }: Layout = {},
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) => {
    const cells = row.map((cell, column) => {
      const padding = ' '.repeat((widths[column] ?? 0) - displayWidth(cell));
      const gap = column === 0 ? '' : ' '.repeat(gaps[column] ?? GAP);
      if (align[column] === 'right') {
        return `${gap}${padding}${cell}`;
      }
      return column === row.length - 1 ? `${gap}${cell}` : `${gap}${cell}${padding}`;
    });
    return `${indent}${cells.join('')}`.trimEnd();
  });
}

/** A label column whose later lines are blank: `Worse  a` / `       b`. */
export function labelled(entries: readonly (readonly [string, readonly string[]])[]): string[] {
  return aligned(
    entries.flatMap(([label, values]) =>
      values.map((value, index): readonly string[] => [index === 0 ? label : '', value]),
    ),
    { gaps: [0, 3] },
  );
}

/**
 * A line of human output. `redacted` marks a line made from a Comparison, whose free text went
 * through the config's `redact` rules when it was built, so the output writes it as it is.
 */
export interface HumanLine {
  readonly text: string;
  readonly redacted: boolean;
}

export const plainLines = (texts: readonly string[]): HumanLine[] =>
  texts.map((text) => ({ text, redacted: false }));

export const redactedLines = (texts: readonly string[]): HumanLine[] =>
  texts.map((text) => ({ text, redacted: true }));
