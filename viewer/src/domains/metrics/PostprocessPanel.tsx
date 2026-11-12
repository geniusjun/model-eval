import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent } from '../../../../src/report/format.js';
import type { Cell, Comparison } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { cellLabel } from '../../utils/cell.js';
import { MetricRateValue } from './MetricRateValue.js';
import { ROLES, type PerRole, type Role, type VariantIds } from '../../report/variants.js';
import styles from './metrics.module.css';

type VariantOps = Comparison['ops'][Role];

const FIGURES = ['discard', 'fallback', 'regeneration'] as const;

interface MaskedCell {
  readonly label: string;
  readonly masked: NonNullable<Cell['masked']>;
}

function maskedCells(cells: readonly Cell[]): MaskedCell[] {
  return cells.flatMap((cell) =>
    cell.masked === undefined ? [] : [{ label: cellLabel(cell), masked: cell.masked }],
  );
}

interface MaskedTableProps {
  readonly cells: readonly MaskedCell[];
  readonly variantIds: VariantIds;
  readonly messages: Messages;
}

function MaskedTable({ cells, variantIds, messages }: MaskedTableProps) {
  return (
    <table className={styles.table}>
      <caption>{messages.text('metrics.postprocess.masked')}</caption>
      <thead>
        <tr>
          <th scope="col">{messages.text('metrics.postprocess.column.cell')}</th>
          {ROLES.map((role) => (
            <th key={role} scope="col">
              {messages.text(`role.${role}`, { variant: variantIds[role] })}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {cells.map(({ label, masked }) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            {ROLES.map((role) => (
              <td key={role} className={styles.number}>
                {percent(masked[role])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface DiscardReasonsProps {
  readonly reasons: VariantOps['discardReasons'];
  readonly messages: Messages;
}

function DiscardReasons({ reasons, messages }: DiscardReasonsProps) {
  if (reasons.length === 0) {
    return <p>{messages.text('metrics.postprocess.noDiscards')}</p>;
  }
  return (
    <table className={styles.table}>
      <caption>{messages.text('metrics.postprocess.discardReasons')}</caption>
      <thead>
        <tr>
          <th scope="col">{messages.text('metrics.postprocess.column.reason')}</th>
          <th scope="col">{messages.text('metrics.column.count')}</th>
        </tr>
      </thead>
      <tbody>
        {reasons.map((reason) => (
          <tr key={reason.discardReason}>
            <td>
              <CodeText text={reason.discardReason} />
            </td>
            <td className={styles.number}>{String(reason.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface VariantPostprocessProps {
  readonly variant: string;
  readonly postprocess: boolean;
  readonly ops: VariantOps;
  readonly messages: Messages;
}

/** One variant's figures, or the notice that its adapter declares no post-processing. */
function VariantPostprocess({ variant, postprocess, ops, messages }: VariantPostprocessProps) {
  const headingId = useId();
  return (
    <div className={styles.block} role="group" aria-labelledby={headingId}>
      <h4 id={headingId}>{variant}</h4>
      {postprocess ? (
        <>
          <ul>
            {FIGURES.map((name) => {
              const label = messages.text(`metrics.rate.${name}`);
              return (
                <li key={name}>
                  <span>{label}</span>
                  <MetricRateValue
                    label={`${label} (${variant})`}
                    rate={ops.rates[name]}
                    messages={messages}
                  />
                </li>
              );
            })}
          </ul>
          <DiscardReasons reasons={ops.discardReasons} messages={messages} />
        </>
      ) : (
        <p>{messages.text('metrics.postprocess.none', { variant })}</p>
      )}
    </div>
  );
}

interface PostprocessPanelProps {
  readonly lang: Lang;
  readonly cells: readonly Cell[];
  readonly ops: Comparison['ops'];
  /** `postprocess` of each compared run: whether its adapter declares post-processing. */
  readonly postprocess: PerRole<boolean>;
  readonly variantIds: VariantIds;
}

/**
 * The post-processing figures of FR-016: the masked rate of each `raw` cell, then per variant
 * the discard, fallback and regeneration rates and the discard reasons (constitution I).
 */
export function PostprocessPanel({
  lang,
  cells,
  ops,
  postprocess,
  variantIds,
}: PostprocessPanelProps) {
  const messages = pageMessages(lang);
  const masked = maskedCells(cells);
  return (
    <div className={styles.block}>
      <h3>{messages.text('metrics.postprocess.heading')}</h3>
      {masked.length > 0 && (
        <MaskedTable cells={masked} variantIds={variantIds} messages={messages} />
      )}
      {ROLES.map((role) => (
        <VariantPostprocess
          key={role}
          variant={variantIds[role]}
          postprocess={postprocess[role]}
          ops={ops[role]}
          messages={messages}
        />
      ))}
    </div>
  );
}
