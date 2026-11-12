import { useId, type ReactNode } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { Comparison, Scope } from '../../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import styles from './DecisionSummary.module.css';
import { GateResult } from './GateResult.js';
import { SummaryCellList } from './SummaryCellList.js';
import { metricName, opsChangeText } from './summaryText.js';

interface DecisionSummaryProps {
  readonly comparison: Pick<
    Comparison,
    'gate' | 'stats' | 'priorComparisons' | 'summary' | 'cells' | 'rules'
  >;
  readonly lang: Lang;
}

interface SummarySectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

function SummarySection({ title, children }: SummarySectionProps) {
  return (
    <section className={styles.section}>
      <h3 className={styles.title}>{title}</h3>
      {children}
    </section>
  );
}

interface OpsChangeListProps {
  readonly changes: Comparison['summary']['ops'];
  readonly messages: Messages;
}

function OpsChangeList({ changes, messages }: OpsChangeListProps) {
  if (changes.length === 0) {
    return <p className={styles.none}>{messages.text('summary.none')}</p>;
  }
  return (
    <ul className={styles.list}>
      {changes.map((change) => (
        <li key={change.metric}>
          {`${metricName(messages.lang, change.metric)}: ${opsChangeText(change, messages)}`}
        </li>
      ))}
    </ul>
  );
}

interface JudgedScopeProps {
  readonly scope: Scope;
  readonly ruleCount: number;
  readonly messages: Messages;
}

function JudgedScope({ scope, ruleCount, messages }: JudgedScopeProps) {
  const targets =
    scope.targets.length === 0 ? messages.text('summary.none') : scope.targets.join(', ');
  return (
    <dl className={styles.facts}>
      <dt>{messages.text('summary.targets')}</dt>
      <dd>{targets}</dd>
      <dt>{messages.text('summary.judgedRules')}</dt>
      <dd>
        {messages.text('summary.judgedOf', {
          judged: scope.judgedRules.length,
          total: ruleCount,
        })}
      </dd>
      <dt>{messages.text('summary.reviewRules')}</dt>
      <dd>{String(scope.reviewRules.length)}</dd>
    </dl>
  );
}

/**
 * The gate result, then the sections of 001 FR-028 in order: worse, better and undecided cells,
 * operational changes and the judged scope. A cell with a confirmed drop that is still undecided
 * is listed under worse and undecided, as `comparison.summary` lists it.
 */
export function DecisionSummary({ comparison, lang }: DecisionSummaryProps) {
  const headingId = useId();
  const messages = pageMessages(lang);
  const { summary, cells, rules } = comparison;
  return (
    <section className={styles.summary} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {messages.text('summary.heading')}
      </h2>
      <GateResult comparison={comparison} messages={messages} />
      <SummarySection title={messages.text('summary.worse')}>
        <SummaryCellList
          entries={summary.worse}
          cells={cells}
          withNeeded={false}
          messages={messages}
        />
      </SummarySection>
      <SummarySection title={messages.text('summary.improved')}>
        <SummaryCellList
          entries={summary.improved}
          cells={cells}
          withNeeded={false}
          messages={messages}
        />
      </SummarySection>
      <SummarySection title={messages.text('summary.unknown')}>
        <SummaryCellList entries={summary.unknown} cells={cells} withNeeded messages={messages} />
      </SummarySection>
      <SummarySection title={messages.text('summary.ops')}>
        <OpsChangeList changes={summary.ops} messages={messages} />
      </SummarySection>
      <SummarySection title={messages.text('summary.scope')}>
        <JudgedScope scope={summary.scope} ruleCount={rules.length} messages={messages} />
      </SummarySection>
    </section>
  );
}
