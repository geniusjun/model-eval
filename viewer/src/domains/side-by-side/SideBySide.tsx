import { useEffect, useId, useRef } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { RuleSummary, Samples, SampleText } from '../../../../src/report/schema.js';
import { SampleAnswer } from '../../components/SampleAnswer.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { ROLES, type Role, type VariantIds } from '../../report/variants.js';
import type { SideView } from '../../utils/hash.js';
import styles from './SideBySide.module.css';
import {
  samplePositions,
  useSampleCursor,
  type SampleCursor,
  type SamplePosition,
} from './useSampleCursor.js';

interface SideBySideProps {
  readonly rules: readonly RuleSummary[];
  readonly samples: Samples;
  /** The position the location hash names, if it names one. */
  readonly view: SideView | undefined;
  readonly variants: VariantIds;
  readonly lang: Lang;
}

interface RuleChooserProps {
  readonly ruleIds: readonly string[];
  readonly chosen: string | undefined;
  readonly onChoose: (ruleId: string) => void;
  readonly messages: Messages;
}

function RuleChooser({ ruleIds, chosen, onChoose, messages }: RuleChooserProps) {
  const headingId = useId();
  return (
    <>
      <h3 id={headingId} className={styles.subheading}>
        {messages.text('side.rules')}
      </h3>
      <ul aria-labelledby={headingId} className={styles.rules}>
        {ruleIds.map((ruleId) => (
          <li key={ruleId}>
            <button
              type="button"
              className={styles.rule}
              aria-pressed={ruleId === chosen}
              onClick={() => {
                onChoose(ruleId);
              }}
            >
              {ruleId}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

interface MoveButtonProps {
  readonly label: string;
  /** Where the move goes, or undefined at an end, where the button does nothing. */
  readonly target: SamplePosition | undefined;
  readonly onMove: (position: SamplePosition) => void;
}

/**
 * A move through cases or repeats. At an end it stays focusable and says it is unavailable with
 * `aria-disabled`, so focus is not lost when a keyboard user reaches the last case.
 */
function MoveButton({ label, target, onMove }: MoveButtonProps) {
  return (
    <button
      type="button"
      className={styles.move}
      aria-disabled={target === undefined}
      onClick={() => {
        if (target !== undefined) {
          onMove(target);
        }
      }}
    >
      {label}
    </button>
  );
}

interface AnswerColumnProps {
  readonly role: Role;
  readonly text: SampleText | undefined;
  readonly variants: VariantIds;
  readonly messages: Messages;
}

function AnswerColumn({ role, text, variants, messages }: AnswerColumnProps) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className={styles.column}>
      <h4 id={headingId} className={styles.columnHeading}>
        {messages.text(`role.${role}`, { variant: variants[role] })}
      </h4>
      {text === undefined ? (
        <p className={styles.none}>{messages.text('side.noText')}</p>
      ) : (
        <SampleAnswer text={text} lang={messages.lang} />
      )}
    </div>
  );
}

interface PositionPanelProps {
  readonly cursor: SampleCursor;
  readonly onMove: (position: SamplePosition) => void;
  readonly variants: VariantIds;
  readonly messages: Messages;
}

/** The answers at one position. Its heading takes focus when a rule opens, as a cell detail's does. */
function PositionPanel({ cursor, onMove, variants, messages }: PositionPanelProps) {
  const headingId = useId();
  const navigationId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { position } = cursor;

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section aria-labelledby={headingId} className={styles.panel}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
        {messages.text('side.position', {
          ruleId: cursor.ruleId,
          caseId: position.caseId,
          repeat: position.repeat,
        })}
      </h3>
      <p className={styles.progress} aria-live="polite">
        {messages.text('side.progress', {
          caseNumber: cursor.caseNumber,
          caseCount: cursor.caseCount,
          repeatNumber: cursor.repeatNumber,
          repeatCount: cursor.repeatCount,
        })}
      </p>
      <div role="group" aria-labelledby={navigationId} className={styles.navigation}>
        <span id={navigationId} className={styles.navigationLabel}>
          {messages.text('side.navigation')}
        </span>
        <MoveButton
          label={messages.text('side.previousCase')}
          target={cursor.previousCase}
          onMove={onMove}
        />
        <MoveButton
          label={messages.text('side.nextCase')}
          target={cursor.nextCase}
          onMove={onMove}
        />
        <MoveButton
          label={messages.text('side.previousRepeat')}
          target={cursor.previousRepeat}
          onMove={onMove}
        />
        <MoveButton
          label={messages.text('side.nextRepeat')}
          target={cursor.nextRepeat}
          onMove={onMove}
        />
      </div>
      <div className={styles.columns}>
        {ROLES.map((role) => (
          <AnswerColumn
            key={role}
            role={role}
            text={cursor[role]}
            variants={variants}
            messages={messages}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The baseline's and the candidate's answers to the same case and repeat, next to each other, for
 * `review` rules and rules with failing examples (FR-005). The position lives in the hash.
 */
export function SideBySide({ rules, samples, view, variants, lang }: SideBySideProps) {
  const messages = pageMessages(lang);
  const { cursor, go, chooseRule } = useSampleCursor(samples, view);
  const ruleIds = rules
    .map((rule) => rule.id)
    .filter((ruleId) => samplePositions(samples, ruleId).length > 0);
  if (ruleIds.length === 0) {
    return <p>{messages.text('side.noRules')}</p>;
  }
  return (
    <>
      <p>{messages.text('side.intro')}</p>
      <RuleChooser
        ruleIds={ruleIds}
        chosen={cursor?.ruleId}
        onChoose={chooseRule}
        messages={messages}
      />
      {cursor === undefined ? (
        <p>{messages.text('side.choose')}</p>
      ) : (
        <PositionPanel
          key={cursor.ruleId}
          cursor={cursor}
          onMove={go}
          variants={variants}
          messages={messages}
        />
      )}
    </>
  );
}
