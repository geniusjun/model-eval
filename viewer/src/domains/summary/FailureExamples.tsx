import { Fragment } from 'react';

import type { Cell, Comparison, Samples, SampleText } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { useHashParam } from '../../hooks/useHashParam.js';
import type { Messages } from '../../i18n/useMessages.js';
import { findSampleText } from '../../report/sampleKeys.js';
import { cellLabel, isSameCell } from '../../utils/cell.js';
import { formatHash } from '../../utils/hash.js';
import styles from './FailureExamples.module.css';
import { MarkedText } from '../../components/MarkedText.js';

type FailingKey = Samples['failing'][number]['keys'][number];

/** Two answers make the failure concrete; the cell detail and the side-by-side view hold all. */
const SHOWN = 2;

/** The text a failing example was graded on: the error, the shipped text or the raw answer. */
function gradedText(text: SampleText, cell: Cell): string {
  if ('error' in text) {
    return text.error.message;
  }
  return cell.surface === 'final' ? (text.final ?? text.raw) : text.raw;
}

export interface ExampleSource {
  readonly cell: Cell;
  readonly keys: readonly FailingKey[];
}

/**
 * The answers to quote: the failing examples of the largest drop that has some, gated cells
 * first; the candidate's examples when there are any, at most two.
 */
export function exampleSource(
  comparison: Pick<Comparison, 'cells' | 'samples'>,
): ExampleSource | undefined {
  const regressed = comparison.cells
    .filter((cell) => cell.verdict === 'regressed' && cell.diff !== null)
    .sort(
      (a, b) =>
        Number(b.gated) - Number(a.gated) || (a.diff?.estimate ?? 0) - (b.diff?.estimate ?? 0),
    );
  for (const cell of regressed) {
    const keys = comparison.samples.failing.find((entry) => isSameCell(entry, cell))?.keys ?? [];
    const candidate = keys.filter((key) => key.variant === 'candidate');
    const shown = (candidate.length > 0 ? candidate : keys).slice(0, SHOWN);
    if (shown.length > 0) {
      return { cell, keys: shown };
    }
  }
  return undefined;
}

interface FailureExamplesProps {
  readonly comparison: Pick<Comparison, 'samples' | 'baseline' | 'candidate'>;
  readonly source: ExampleSource;
  readonly messages: Messages;
}

/**
 * The candidate's own words where the largest drop happened: up to two of the cell's failing
 * examples, quoted as text with their evidence marked where it occurs (evidence that does not
 * occur is listed), each with a link to the same case and repeat side by side.
 */
export function FailureExamples({ comparison, source, messages }: FailureExamplesProps) {
  const [hash] = useHashParam();
  const { samples } = comparison;
  const { cell, keys: shown } = source;
  return (
    <>
      <p className={styles.intro}>
        {messages.text('summary.examples.intro', { cell: cellLabel(cell) })}
      </p>
      <ul className={styles.examples}>
        {shown.map((key) => {
          const text = findSampleText(samples.texts, key);
          const quoted = text === undefined ? undefined : gradedText(text, cell);
          // Evidence found in the answer is marked there; only the rest is listed.
          const unmarked = (key.evidence ?? []).filter(
            (item) => quoted === undefined || !quoted.includes(item),
          );
          const sideHref = formatHash({
            view: { kind: 'side', ruleId: cell.ruleId, caseId: key.caseId, repeat: key.repeat },
            lang: hash.lang,
          });
          return (
            <li
              key={`${key.variant}/${key.caseId}/${String(key.repeat)}`}
              className={styles.example}
            >
              {quoted !== undefined && (
                <blockquote className={styles.quote}>
                  <MarkedText
                    text={quoted}
                    marks={key.evidence ?? []}
                    markLabel={messages.text('summary.examples.marked')}
                  />
                </blockquote>
              )}
              <p className={styles.source}>
                <span>
                  {messages.text('grid.sample.key', {
                    variant: messages.text(`role.${key.variant}`),
                    caseId: key.caseId,
                    repeat: key.repeat,
                  })}
                </span>
                {unmarked.length > 0 && (
                  <span className={styles.evidence}>
                    {`${messages.text('grid.sample.evidence')} `}
                    {unmarked.map((item, index) => (
                      <Fragment key={index}>
                        {index > 0 && ', '}
                        <CodeText text={item} />
                      </Fragment>
                    ))}
                  </span>
                )}
                <a href={sideHref}>{messages.text('side.link')}</a>
              </p>
            </li>
          );
        })}
      </ul>
    </>
  );
}
