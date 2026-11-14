import type { Gate, Verdict } from '../../../src/report/schema.js';
import styles from './Shape.module.css';

/**
 * The shapes that mark a status next to its text, so a status reads without colour too:
 * a triangle for worse, a circle for better, an equals sign for held, a half circle for
 * undecided, a dotted circle for too few samples, a slashed circle for not applicable, a square
 * for a warning and a dash for no gate.
 */
export type ShapeKind =
  'triangle' | 'circle' | 'equal' | 'half' | 'dotted' | 'slashed' | 'square' | 'dash';

export const VERDICT_SHAPE: Readonly<Record<Verdict, ShapeKind>> = {
  regressed: 'triangle',
  improved: 'circle',
  'non-inferior': 'equal',
  inconclusive: 'half',
  insufficient: 'dotted',
  'not-applicable': 'slashed',
};

export const OUTCOME_SHAPE: Readonly<Record<Gate['outcome'], ShapeKind>> = {
  block: 'triangle',
  pass: 'circle',
  undecided: 'half',
  'no-gate': 'dash',
};

function ShapePath({ kind }: { readonly kind: ShapeKind }) {
  switch (kind) {
    case 'triangle':
      return <path d="M6 1.25 11.25 10.5H.75z" />;
    case 'circle':
      return <circle cx="6" cy="6" r="4.5" />;
    case 'half':
      return (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" />
        </>
      );
    case 'dotted':
      return (
        <circle
          cx="6"
          cy="6"
          r="4.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="1.9 1.45"
        />
      );
    case 'equal':
      return (
        <>
          <rect x="2" y="3.5" width="8" height="1.5" />
          <rect x="2" y="7" width="8" height="1.5" />
        </>
      );
    case 'slashed':
      return (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 9 9 3" stroke="currentColor" strokeWidth="1.3" />
        </>
      );
    case 'square':
      return <rect x="1.75" y="1.75" width="8.5" height="8.5" />;
    case 'dash':
      return <rect x="1.5" y="5.25" width="9" height="1.5" />;
  }
}

/** A status shape in the current text colour; decoration only, as the text beside it says it. */
export function Shape({ kind }: { readonly kind: ShapeKind }) {
  return (
    <svg
      className={styles.shape}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <ShapePath kind={kind} />
    </svg>
  );
}
