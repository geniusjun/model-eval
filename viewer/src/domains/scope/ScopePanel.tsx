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
  /** The ID of the region's heading, for the page's section buttons; one is made if absent. */
  readonly headingId?: string;
}

function idList(messages: Messages, ids: readonly string[]): string {
  return ids.length === 0 ? messages.text('scope.none') : ids.join(', ');
}

function completionText(messages: Messages, entry: Completion[number]): string {
  const counts = messages.text('scope.countOf', { count: entry.passes, total: entry.trials });
  return `${entry.lang} ${percent(entry.rate)} (${counts})`;
}

interface CompletionValueProps {
  readonly completion: Completion;
  readonly messages: Messages;
}

/** Each language's completion rate, or one line when every language completed fully. */
function CompletionValue({ completion, messages }: CompletionValueProps) {
  if (completion.length === 0) {
    return <>{messages.text('scope.none')}</>;
  }
  if (completion.every((entry) => entry.rate === 1)) {
    return (
      <>
        {messages.text('scope.completionAll', {
          rate: percent(1),
          langs: completion.map((entry) => entry.lang).join(', '),
        })}
      </>
    );
  }
  return (
    <ul className={styles.completion}>
      {completion.map((entry) => (
        <li key={entry.lang}>{completionText(messages, entry)}</li>
      ))}
    </ul>
  );
}

/**
 * The judged scope with the rule list: what the comparison judged and on which cases (FR-007).
 * Lists with something in them get a row each; the empty ones share one sentence under them.
 */
export function ScopePanel({
  lang,
  scope,
  rules,
  excluded,
  coverage,
  completion,
  headingId,
}: ScopePanelProps) {
  const ownHeadingId = useId();
  const titleId = headingId ?? ownHeadingId;
  const messages = pageMessages(lang);
  const excludedRules = excluded.map((rule) => `${rule.ruleId} (${rule.cause})`);
  const lists = [
    { key: 'review', ids: scope.reviewRules },
    { key: 'notJudged', ids: scope.notJudgedRules },
    { key: 'excluded', ids: excludedRules },
    { key: 'onlyInBaseline', ids: coverage.baselineOnly },
    { key: 'onlyInCandidate', ids: coverage.candidateOnly },
    { key: 'changedHash', ids: coverage.changedHash },
  ] as const;
  // The lists with nothing in them share one sentence, so the scope reads as what is there.
  const emptyKeys = lists.filter((list) => list.ids.length === 0).map((list) => list.key);
  const oneSide = emptyKeys.includes('onlyInBaseline') && emptyKeys.includes('onlyInCandidate');
  const empty = emptyKeys.flatMap((key) => {
    if (oneSide && key === 'onlyInBaseline') {
      return [messages.text('scope.empty.oneSide')];
    }
    return oneSide && key === 'onlyInCandidate' ? [] : [messages.text(`scope.empty.${key}`)];
  });
  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      <h2 id={titleId} tabIndex={-1}>
        {messages.text('scope.heading')}
      </h2>
      <DetailList>
        <Detail term={messages.text('scope.targets')}>{idList(messages, scope.targets)}</Detail>
        <Detail term={messages.text('scope.judged', { judged: scope.judgedRules.length })}>
          {idList(messages, scope.judgedRules)}
        </Detail>
        <Detail term={messages.text('scope.commonCases')}>{String(coverage.commonCases)}</Detail>
        {lists
          .filter((list) => list.ids.length > 0)
          .map((list) => (
            <Detail key={list.key} term={messages.text(`scope.${list.key}`)}>
              {list.ids.join(', ')}
            </Detail>
          ))}
        <Detail term={messages.text('scope.completion')}>
          <CompletionValue completion={completion} messages={messages} />
        </Detail>
      </DetailList>
      {empty.length > 0 && (
        <p className={styles.empty}>{messages.text('scope.empty', { lists: empty.join(', ') })}</p>
      )}
      <RuleList lang={lang} rules={rules} />
    </section>
  );
}
