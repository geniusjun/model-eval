import styles from './MarkedText.module.css';

interface Piece {
  readonly text: string;
  readonly marked: boolean;
}

/**
 * `text` cut into plain and marked pieces, marking each occurrence of any of `marks`; evidence
 * that touches, such as the letters of one word, joins into one mark.
 */
export function markPieces(text: string, marks: readonly string[]): Piece[] {
  const wanted = [...new Set(marks.filter((mark) => mark !== ''))].sort(
    (a, b) => b.length - a.length,
  );
  const pieces: Piece[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    const found = wanted.find((mark) => text.startsWith(mark, index));
    if (found === undefined) {
      plain += text.charAt(index);
      index += 1;
    } else {
      if (plain !== '') {
        pieces.push({ text: plain, marked: false });
        plain = '';
      }
      const last = pieces.at(-1);
      if (last?.marked === true) {
        pieces[pieces.length - 1] = { text: last.text + found, marked: true };
      } else {
        pieces.push({ text: found, marked: true });
      }
      index += found.length;
    }
  }
  if (plain !== '') {
    pieces.push({ text: plain, marked: false });
  }
  return pieces;
}

interface MarkedTextProps {
  /** Untrusted text from the model, rendered as text nodes only (plan D5). */
  readonly text: string;
  /** The evidence a grader found in it; each occurrence is marked. */
  readonly marks: readonly string[];
  /** What the marks mean, such as "breaks the rule", for assistive technology. */
  readonly markLabel: string;
}

/**
 * Text with the evidence of a failure marked where it occurs, newlines kept. The text element
 * holds exactly the text; a note before it, read by assistive technology only, says what the
 * marks are.
 */
export function MarkedText({ text, marks, markLabel }: MarkedTextProps) {
  const pieces = markPieces(text, marks);
  const marked = pieces.filter((piece) => piece.marked).map((piece) => piece.text);
  return (
    <>
      {marked.length > 0 && (
        <span
          className={styles.hidden}
        >{`${markLabel}: ${[...new Set(marked)].join(', ')}. `}</span>
      )}
      <span className={styles.text}>
        {pieces.map((piece, index) =>
          piece.marked ? (
            <mark key={index} className={styles.mark}>
              {piece.text}
            </mark>
          ) : (
            piece.text
          ),
        )}
      </span>
    </>
  );
}
