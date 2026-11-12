import { useEffect, useId, useRef, type ReactNode } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import {
  marginPoints,
  NONE,
  percent,
  points,
  pointsInterval,
} from '../../../../src/report/format.js';
import type { Cell, RuleSummary, Samples } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { IntervalBar } from '../../components/IntervalBar.js';
import { VerdictBadge } from '../../components/VerdictBadge.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { findSampleText } from '../../report/sampleKeys.js';
import { ROLES, type Role, type VariantIds } from '../../report/variants.js';
import { cellLabel, failRatioText, isSameCell, rateText } from '../../utils/cell.js';
import type { SideView } from '../../utils/hash.js';
import styles from './CellDetail.module.css';
import { FailingExample } from './FailingExample.js';
import tableStyles from './table.module.css';

interface CellDetailProps {
  readonly cell: Cell;
  readonly rules: readonly RuleSummary[];
  readonly samples: Samples;
  readonly variants: VariantIds;
  readonly lang: Lang;
  readonly onClose: () => void;
  /** The location of a side-by-side position, for the links from failing examples. */
  readonly sideHref: (view: SideView) => string;
}

function differenceText(cell: Cell): string {
  return cell.diff === null
    ? NONE
    : `${points(cell.diff.estimate)} ${pointsInterval(cell.diff.low, cell.diff.high)}`;
}

function casesText(cell: Cell, messages: Messages): string {
  return cell.droppedCases === 0
    ? String(cell.cases)
    : messages.text('grid.detail.casesDropped', { cases: cell.cases, dropped: cell.droppedCases });
}

interface FactProps {
  readonly label: string;
  readonly children: ReactNode;
}

function Fact({ label, children }: FactProps) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface CellFactsProps {
  readonly cell: Cell;
  readonly lang: Lang;
  readonly messages: Messages;
}

function CellFacts({ cell, lang, messages }: CellFactsProps) {
  return (
    <dl className={styles.facts}>
      <Fact label={messages.text('grid.detail.verdict')}>
        <VerdictBadge verdict={cell.verdict} lang={lang} />
      </Fact>
      <Fact label={messages.text('grid.detail.gated')}>
        {messages.text(cell.gated ? 'grid.detail.yes' : 'grid.detail.no')}
      </Fact>
      <Fact label={messages.text('grid.detail.cases')}>{casesText(cell, messages)}</Fact>
      <Fact label={messages.text('grid.detail.margin')}>{marginPoints(cell.margin)}</Fact>
      <Fact label={messages.text('grid.detail.difference')}>
        {differenceText(cell)}
        {cell.diff !== null && (
          <IntervalBar
            kind="difference"
            label={messages.text('grid.detail.difference')}
            value={cell.diff.estimate}
            low={cell.diff.low}
            high={cell.diff.high}
          />
        )}
      </Fact>
      <Fact label={messages.text('grid.detail.failRatio')}>{failRatioText(cell, lang)}</Fact>
      {cell.note !== undefined && (
        <Fact label={messages.text('grid.detail.note')}>{messages.note(cell.note)}</Fact>
      )}
      {cell.needed !== undefined && (
        <Fact label={messages.text('grid.detail.needed')}>
          {messages.needed(cell.needed, cell.candidate.trials)}
        </Fact>
      )}
    </dl>
  );
}

interface VariantRowProps {
  readonly label: string;
  readonly value: (role: Role) => ReactNode;
}

function VariantRow({ label, value }: VariantRowProps) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {ROLES.map((role) => (
        <td key={role} className={tableStyles.number}>
          {value(role)}
        </td>
      ))}
    </tr>
  );
}

interface VariantFiguresProps {
  readonly cell: Cell;
  readonly variants: VariantIds;
  readonly messages: Messages;
}

/** Compliance, and where the cell has them the masked rate (`raw`) and systematic failures. */
function VariantFigures({ cell, variants, messages }: VariantFiguresProps) {
  const { masked, systematic } = cell;
  return (
    <table className={tableStyles.table}>
      <caption>{messages.text('grid.detail.perVariant')}</caption>
      <thead>
        <tr>
          <th scope="col">{messages.text('grid.detail.measure')}</th>
          {ROLES.map((role) => (
            <th key={role} scope="col">
              {messages.text(`role.${role}`, { variant: variants[role] })}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <VariantRow
          label={messages.text('grid.detail.rates')}
          value={(role) => (
            <>
              {rateText(cell[role])}
              <IntervalBar
                label={variants[role]}
                value={cell[role].rate}
                low={cell[role].low}
                high={cell[role].high}
              />
            </>
          )}
        />
        {masked !== undefined && (
          <VariantRow
            label={messages.text('grid.detail.masked')}
            value={(role) => percent(masked[role])}
          />
        )}
        {systematic !== undefined && (
          <VariantRow
            label={messages.text('grid.detail.systematic')}
            value={(role) =>
              messages.text('grid.detail.systematicCount', {
                trials: systematic[role].trials,
                cases: systematic[role].cases,
              })
            }
          />
        )}
      </tbody>
    </table>
  );
}

interface RuleContextProps {
  readonly cell: Cell;
  readonly rule: RuleSummary | undefined;
  readonly messages: Messages;
}

/** The prompt sentences anchored for the cell's language and the rule's origin (FR-004). */
function RuleContext({ cell, rule, messages }: RuleContextProps) {
  const anchors = (rule?.anchors ?? []).filter((anchor) => anchor.lang === cell.lang);
  const origins = rule?.origin ?? [];
  return (
    <>
      <h4 className={styles.subheading}>{messages.text('grid.detail.anchor')}</h4>
      {anchors.length === 0 ? (
        <p>{messages.text('grid.detail.noAnchor', { lang: cell.lang })}</p>
      ) : (
        <ul className={styles.plainList}>
          {anchors.map((anchor, index) => (
            <li key={index}>
              <CodeText text={anchor.quote} />
              {anchor.target !== undefined && (
                <span className={styles.part}>
                  <span className={styles.partLabel}>
                    {messages.text('grid.detail.anchorTarget')}
                  </span>{' '}
                  <CodeText text={anchor.target} />
                </span>
              )}
              {anchor.cases !== undefined && (
                <span className={styles.part}>
                  <span className={styles.partLabel}>
                    {messages.text('grid.detail.anchorCases')}
                  </span>{' '}
                  <span>{anchor.cases.join(', ')}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4 className={styles.subheading}>{messages.text('grid.detail.origin')}</h4>
      {origins.length === 0 ? (
        <p>{messages.text('grid.detail.noOrigin')}</p>
      ) : (
        <ul className={styles.plainList}>
          {origins.map((origin, index) => (
            <li key={index}>
              {origin.commit !== undefined && (
                <span className={styles.part}>
                  <span className={styles.partLabel}>{messages.text('grid.detail.commit')}</span>{' '}
                  <CodeText text={origin.commit} />
                </span>
              )}
              {origin.date !== undefined && (
                <span className={styles.part}>
                  <span className={styles.partLabel}>{messages.text('grid.detail.date')}</span>{' '}
                  <CodeText text={origin.date} />
                </span>
              )}
              {origin.layer !== undefined && (
                <span className={styles.part}>
                  <span className={styles.partLabel}>{messages.text('grid.detail.layer')}</span>{' '}
                  <span>{origin.layer}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface FailingExamplesProps {
  readonly cell: Cell;
  readonly samples: Samples;
  readonly variants: VariantIds;
  readonly sideHref: (view: SideView) => string;
  readonly messages: Messages;
}

function FailingExamples({ cell, samples, variants, sideHref, messages }: FailingExamplesProps) {
  const headingId = useId();
  const keys = samples.failing.find((entry) => isSameCell(entry, cell))?.keys ?? [];
  return (
    <>
      <h4 id={headingId} className={styles.subheading}>
        {messages.text('grid.detail.failing')}
      </h4>
      {keys.length === 0 ? (
        <p>{messages.text('grid.detail.noFailing')}</p>
      ) : (
        <ul aria-labelledby={headingId} className={styles.examples}>
          {keys.map((key) => (
            <li key={`${key.variant}/${key.caseId}/${String(key.repeat)}`}>
              <FailingExample
                sampleKey={key}
                text={findSampleText(samples.texts, key)}
                sideHref={sideHref({
                  kind: 'side',
                  ruleId: cell.ruleId,
                  caseId: key.caseId,
                  repeat: key.repeat,
                })}
                variants={variants}
                messages={messages}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The detail of one cell (FR-004, FR-016). Its heading takes focus when it opens, so keyboard and
 * screen reader users land on it; the close button and Escape close it.
 */
export function CellDetail({
  cell,
  rules,
  samples,
  variants,
  lang,
  onClose,
  sideHref,
}: CellDetailProps) {
  const messages = pageMessages(lang);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rule = rules.find((candidate) => candidate.id === cell.ruleId);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Only one detail is open at a time, so Escape closes it wherever focus is on the page, except
  // in a drop-down such as the language switch, where Escape belongs to the drop-down.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const inDropDown = event.target instanceof HTMLSelectElement;
      if (event.key === 'Escape' && !event.defaultPrevented && !inDropDown) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <section className={styles.detail} aria-labelledby={headingId}>
      <div className={styles.header}>
        <h3 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
          {cellLabel(cell)}
        </h3>
        <button type="button" className={styles.close} onClick={onClose}>
          {messages.text('grid.detail.close')}
        </button>
      </div>
      <CellFacts cell={cell} lang={lang} messages={messages} />
      <VariantFigures cell={cell} variants={variants} messages={messages} />
      <RuleContext cell={cell} rule={rule} messages={messages} />
      <FailingExamples
        cell={cell}
        samples={samples}
        variants={variants}
        sideHref={sideHref}
        messages={messages}
      />
    </section>
  );
}
