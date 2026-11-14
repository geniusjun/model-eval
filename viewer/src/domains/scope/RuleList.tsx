import { Fragment, useId, type ReactNode } from 'react';

import type { Anchor, Lang, Origin } from '../../../../src/config/schema.js';
import type { RuleSummary } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import styles from './RuleList.module.css';

const SEPARATOR = ' · ';

interface Part {
  readonly key: string;
  readonly content: ReactNode;
}

function joinParts(parts: readonly Part[]): ReactNode {
  return parts.map((part, index) => (
    <Fragment key={part.key}>
      {index === 0 ? null : SEPARATOR}
      {part.content}
    </Fragment>
  ));
}

function AnchorItem({
  anchor,
  messages,
}: {
  readonly anchor: Anchor;
  readonly messages: Messages;
}) {
  const extras: Part[] = [];
  if (anchor.target !== undefined) {
    extras.push({
      key: 'target',
      content: labelledCode(messages.text('scope.rules.target'), anchor.target),
    });
  }
  if (anchor.cases !== undefined) {
    extras.push({
      key: 'cases',
      content: messages.text('scope.rules.cases', { cases: anchor.cases.join(', ') }),
    });
  }
  return (
    <li>
      {messages.text('scope.rules.anchor', { lang: anchor.lang })}: <CodeText text={anchor.quote} />
      {extras.length === 0 ? null : SEPARATOR}
      {joinParts(extras)}
    </li>
  );
}

function labelledCode(label: string, text: string): ReactNode {
  return (
    <>
      {label} <CodeText text={text} />
    </>
  );
}

function OriginItem({
  origin,
  messages,
}: {
  readonly origin: Origin;
  readonly messages: Messages;
}) {
  const parts: Part[] = [];
  if (origin.commit !== undefined) {
    parts.push({
      key: 'commit',
      content: labelledCode(messages.text('scope.rules.commit'), origin.commit),
    });
  }
  if (origin.date !== undefined) {
    parts.push({
      key: 'date',
      content: labelledCode(messages.text('scope.rules.date'), origin.date),
    });
  }
  if (origin.layer !== undefined) {
    parts.push({ key: 'layer', content: `${messages.text('scope.rules.layer')} ${origin.layer}` });
  }
  const label = messages.text('scope.rules.origin');
  return (
    <li>
      {parts.length === 0 ? label : `${label}: `}
      {joinParts(parts)}
    </li>
  );
}

function RuleEntry({
  rule,
  messages,
}: {
  readonly rule: RuleSummary;
  readonly messages: Messages;
}) {
  return (
    <li className={styles.rule}>
      <h4 className={styles.id}>{rule.id}</h4>
      <p className={styles.summary}>
        <span className={styles.severity}>{rule.severity}</span>
        {SEPARATOR}
        <CodeText text={rule.title} />
      </p>
      <ul className={styles.details}>
        {rule.anchors.length === 0 ? (
          <li className={styles.missing}>{messages.text('scope.rules.noAnchor')}</li>
        ) : (
          rule.anchors.map((anchor, index) => (
            <AnchorItem key={index} anchor={anchor} messages={messages} />
          ))
        )}
        {rule.origin.length === 0 ? (
          <li className={styles.missing}>{messages.text('scope.rules.noOrigin')}</li>
        ) : (
          rule.origin.map((origin, index) => (
            <OriginItem key={index} origin={origin} messages={messages} />
          ))
        )}
      </ul>
    </li>
  );
}

interface RuleListProps {
  readonly lang: Lang;
  readonly rules: readonly RuleSummary[];
}

/** Every rule of the comparison with its anchors and origins (FR-016), closed until opened. */
export function RuleList({ lang, rules }: RuleListProps) {
  const headingId = useId();
  const messages = pageMessages(lang);
  return (
    <section className={styles.list} aria-labelledby={headingId}>
      <h3 id={headingId}>{messages.text('scope.rules.heading')}</h3>
      {rules.length === 0 ? (
        <p>{messages.text('scope.rules.none')}</p>
      ) : (
        <Disclosure label={messages.text('scope.rules.show', { count: rules.length })}>
          <ul className={styles.rules}>
            {rules.map((rule) => (
              <RuleEntry key={rule.id} rule={rule} messages={messages} />
            ))}
          </ul>
        </Disclosure>
      )}
    </section>
  );
}
