import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent } from '../../../../src/report/format.js';
import type {
  Comparison,
  Coverage,
  Gate,
  RuleSummary,
  Scope,
} from '../../../../src/report/schema.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import type { VariantIds } from '../../report/variants.js';
import { Detail, DetailList } from './Detail.js';
import { RuleList } from './RuleList.js';
import styles from './ScopePanel.module.css';

type Completion = Comparison['completion'];

interface ScopePanelProps {
  readonly lang: Lang;
  readonly scope: Scope;
  readonly rules: readonly RuleSummary[];
  /** `gate.excluded`: the rules removed from the gate, with their cause. */
  readonly excluded: Gate['excluded'];
  readonly coverage: Coverage;
  readonly completion: Completion;
  /** The variant IDs, which name the run holding the cases the other run lacks. */
  readonly variantIds: VariantIds;
}

function idList(messages: Messages, ids: readonly string[]): string {
  return ids.length === 0 ? messages.text('scope.none') : ids.join(', ');
}

function completionText(messages: Messages, entry: Completion[number]): string {
  const counts = messages.text('scope.countOf', { count: entry.passes, total: entry.trials });
  return `${entry.lang} ${percent(entry.rate)} (${counts})`;
}

/** The judged scope with the rule list: what the comparison judged and on which cases (FR-007). */
export function ScopePanel({
  lang,
  scope,
  rules,
  excluded,
  coverage,
  completion,
  variantIds,
}: ScopePanelProps) {
  const headingId = useId();
  const messages = pageMessages(lang);
  const excludedRules = excluded.map((rule) => `${rule.ruleId} (${rule.cause})`);
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>{messages.text('scope.heading')}</h2>
      <DetailList>
        <Detail term={messages.text('scope.targets')}>{idList(messages, scope.targets)}</Detail>
        <Detail
          term={messages.text('scope.judged', {
            judged: scope.judgedRules.length,
            total: rules.length,
          })}
        >
          {idList(messages, scope.judgedRules)}
        </Detail>
        <Detail term={messages.text('scope.notJudged')}>
          {idList(messages, scope.notJudgedRules)}
        </Detail>
        <Detail term={messages.text('scope.review')}>{idList(messages, scope.reviewRules)}</Detail>
        <Detail term={messages.text('scope.excluded')}>{idList(messages, excludedRules)}</Detail>
        <Detail term={messages.text('scope.commonCases')}>{String(coverage.commonCases)}</Detail>
        <Detail term={messages.text('scope.onlyIn', { variant: variantIds.baseline })}>
          {idList(messages, coverage.baselineOnly)}
        </Detail>
        <Detail term={messages.text('scope.onlyIn', { variant: variantIds.candidate })}>
          {idList(messages, coverage.candidateOnly)}
        </Detail>
        <Detail term={messages.text('scope.changedHash')}>
          {idList(messages, coverage.changedHash)}
        </Detail>
        <Detail term={messages.text('scope.completion')}>
          {completion.length === 0 ? (
            messages.text('scope.none')
          ) : (
            <ul className={styles.completion}>
              {completion.map((entry) => (
                <li key={entry.lang}>{completionText(messages, entry)}</li>
              ))}
            </ul>
          )}
        </Detail>
      </DetailList>
      <RuleList lang={lang} rules={rules} />
    </section>
  );
}
