import { Fragment, useEffect, useId, useRef } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { RuleSummary, Samples, SampleText } from '../../../../src/report/schema.js';
import { SampleAnswer } from '../../components/SampleAnswer.js';
import { Shape } from '../../components/Shape.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { ROLES, type Role } from '../../report/variants.js';
import type { SideView } from '../../utils/hash.js';
import styles from './SideBySide.module.css';
import {
  sampleCursor,
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
  readonly lang: Lang;
  /** Rules with a regressed cell, marked in the rule chooser. */
  readonly regressedRuleIds?: ReadonlySet<string>;
}

interface RuleChooserProps {
  readonly ruleIds: readonly string[];
  readonly regressedRuleIds: ReadonlySet<string>;
  readonly chosen: string | undefined;
  readonly onChoose: (ruleId: string) => void;
  readonly messages: Messages;
}

function RuleChooser({ ruleIds, regressedRuleIds, chosen, onChoose, messages }: RuleChooserProps) {
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
              {regressedRuleIds.has(ruleId) && <Shape kind="triangle" />}
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

/**
 * The evidence of the failing examples of the rule's cells at a position for one variant, or
 * undefined when none of them failed there.
 */
function failingEvidence(
  samples: Samples,
  ruleId: string,
  role: Role,
  position: SamplePosition,
): string[] | undefined {
  const keys = samples.failing
    .filter((entry) => entry.ruleId === ruleId)
    .flatMap((entry) => entry.keys)
    .filter(
      (key) =>
        key.variant === role && key.caseId === position.caseId && key.repeat === position.repeat,
    );
  return keys.length === 0 ? undefined : [...new Set(keys.flatMap((key) => key.evidence ?? []))];
}

interface AnswerColumnProps {
  readonly role: Role;
  readonly text: SampleText | undefined;
  /** The evidence when the rule failed this answer; undefined when it is not a failing example. */
  readonly evidence: readonly string[] | undefined;
  readonly messages: Messages;
}

/** One variant's answer; a failing example says so and shows its evidence before the answer. */
function AnswerColumn({ role, text, evidence, messages }: AnswerColumnProps) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} className={styles.column}>
      <h4 id={headingId} className={styles.columnHeading}>
        {messages.text(`role.${role}`)}
      </h4>
      {evidence !== undefined && (
        <p className={styles.failed}>
          <Shape kind="triangle" />
          <span className={styles.failedWord}>{messages.text('sample.failed')}</span>
          {evidence.length > 0 && (
            <span>
              {` · ${messages.text('grid.sample.evidence')} `}
              {evidence.map((item, index) => (
                <Fragment key={index}>
                  {index > 0 && ', '}
                  <span className={styles.evidence}>{item}</span>
                </Fragment>
              ))}
            </span>
          )}
        </p>
      )}
      {text === undefined ? (
        <p className={styles.none}>{messages.text('side.noText')}</p>
      ) : (
        <SampleAnswer text={text} lang={messages.lang} marks={evidence ?? []} />
      )}
    </div>
  );
}

interface PositionPanelProps {
  readonly cursor: SampleCursor;
  readonly samples: Samples;
  readonly onMove: (position: SamplePosition) => void;
  /** Whether the heading takes focus on opening: when the reader opened it, not by default. */
  readonly focusOnOpen: boolean;
  readonly messages: Messages;
}

/** The answers at one position. Its heading takes focus when a rule opens, as a cell detail's does. */
function PositionPanel({ cursor, samples, onMove, focusOnOpen, messages }: PositionPanelProps) {
  const headingId = useId();
  const navigationId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { position } = cursor;

  useEffect(() => {
    if (focusOnOpen) {
      headingRef.current?.focus();
    }
  }, [focusOnOpen]);

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
            evidence={failingEvidence(samples, cursor.ruleId, role, position)}
            messages={messages}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The baseline's and the candidate's answers to the same case and repeat, next to each other, for
 * `review` rules and rules with failing examples (FR-005). The position lives in the hash; with
 * none there, the first position of the first regressed rule shows without touching the hash or
 * taking focus.
 */
export function SideBySide({
  rules,
  samples,
  view,
  lang,
  regressedRuleIds = new Set(),
}: SideBySideProps) {
  const messages = pageMessages(lang);
  const { cursor, go, chooseRule, open } = useSampleCursor(samples, view);
  const ruleIds = rules
    .map((rule) => rule.id)
    .filter((ruleId) => samplePositions(samples, ruleId).length > 0);
  const firstRegressed = ruleIds.find((ruleId) => regressedRuleIds.has(ruleId));
  const firstPosition =
    firstRegressed === undefined ? undefined : samplePositions(samples, firstRegressed)[0];
  const shown =
    cursor ??
    (firstRegressed === undefined || firstPosition === undefined
      ? undefined
      : sampleCursor(samples, { kind: 'side', ruleId: firstRegressed, ...firstPosition }));
  const fromHash = cursor !== undefined;
  if (ruleIds.length === 0) {
    return <p className={styles.none}>{messages.text('side.noRules')}</p>;
  }
  return (
    <>
      <RuleChooser
        ruleIds={ruleIds}
        regressedRuleIds={regressedRuleIds}
        chosen={shown?.ruleId}
        onChoose={chooseRule}
        messages={messages}
      />
      {shown === undefined ? (
        <p className={styles.none}>{messages.text('side.choose')}</p>
      ) : (
        <PositionPanel
          key={`${shown.ruleId}/${String(fromHash)}`}
          cursor={shown}
          samples={samples}
          onMove={
            fromHash
              ? go
              : (position) => {
                  open(shown.ruleId, position);
                }
          }
          focusOnOpen={fromHash}
          messages={messages}
        />
      )}
    </>
  );
}
