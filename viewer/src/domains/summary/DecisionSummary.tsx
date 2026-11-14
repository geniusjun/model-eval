import { useId, type ReactNode } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import type { Comparison } from '../../../../src/report/schema.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { ChangePlot } from './ChangePlot.js';
import styles from './DecisionSummary.module.css';
import { exampleSource, FailureExamples } from './FailureExamples.js';
import { GateFacts, GateResult } from './GateResult.js';
import { TradeOffs } from './TradeOffs.js';

type SummaryComparison = Pick<
  Comparison,
  | 'gate'
  | 'stats'
  | 'priorComparisons'
  | 'summary'
  | 'cells'
  | 'ops'
  | 'samples'
  | 'coverage'
  | 'baseline'
  | 'candidate'
  | 'config'
>;

interface DecisionSummaryProps {
  readonly comparison: SummaryComparison;
  readonly lang: Lang;
  /** The ID of the region's heading, for the page's section buttons; one is made if absent. */
  readonly headingId?: string;
}

interface SummarySectionProps {
  readonly title: string;
  /** A short remark beside the title, such as that the section is not part of the verdict. */
  readonly aside?: string;
  readonly children: (titleId: string) => ReactNode;
}

function SummarySection({ title, aside, children }: SummarySectionProps) {
  const titleId = useId();
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 id={titleId} className={styles.title}>
          {title}
        </h3>
        {aside !== undefined && <span className={styles.aside}>{aside}</span>}
      </div>
      {children(titleId)}
    </section>
  );
}

/** How many repeats each case ran, when every cell agrees; undefined otherwise. */
function repeatsOf(cells: SummaryComparison['cells']): number | undefined {
  const repeats = new Set(
    cells
      .filter((cell) => cell.cases > 0 && cell.candidate.trials > 0)
      .map((cell) => cell.candidate.trials / cell.cases),
  );
  const [only] = repeats;
  return repeats.size === 1 && only !== undefined && Number.isInteger(only) ? only : undefined;
}

interface JudgedScopeProps {
  readonly comparison: SummaryComparison;
  readonly messages: Messages;
}

/** The judged scope as one line of small facts: what the verdict rests on. */
function JudgedScope({ comparison, messages }: JudgedScopeProps) {
  const { summary, coverage, cells } = comparison;
  const { scope } = summary;
  const targets =
    scope.targets.length === 0 ? messages.text('summary.none') : scope.targets.join(', ');
  const languages = new Set(cells.map((cell) => cell.lang)).size;
  const repeats = repeatsOf(cells);
  const facts: readonly (readonly [string, string])[] = [
    [
      messages.text('summary.rules'),
      messages.text('summary.rulesCount', {
        judged: scope.judgedRules.length,
        review: scope.reviewRules.length,
      }),
    ],
    [messages.text('summary.cases'), String(coverage.commonCases)],
    [messages.text('summary.languages'), String(languages)],
    ...(repeats === undefined
      ? []
      : [[messages.text('summary.repeats'), String(repeats)] as const]),
    [messages.text('summary.targets'), targets],
  ];
  return (
    <dl className={styles.scope}>
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The decision summary in the order a reader asks (plan D12), which is the order of 001 FR-028:
 * should we switch (the gate outcome and its sentence), what changed and how sure it is (the
 * worse, better and undecided cells as one chart), what the candidate wrote (failing answers of
 * the largest drop), what it costs (operational changes) and what the verdict rests on (the
 * judged scope). The gate's reasons and counts stay one click away.
 */
export function DecisionSummary({ comparison, lang, headingId }: DecisionSummaryProps) {
  const ownHeadingId = useId();
  const titleId = headingId ?? ownHeadingId;
  const messages = pageMessages(lang);
  const example = exampleSource(comparison);
  return (
    <section className={styles.summary} aria-labelledby={titleId}>
      <h2 id={titleId} tabIndex={-1} className={styles.heading}>
        {messages.text('summary.heading')}
      </h2>
      <div className={styles.verdict} data-outcome={comparison.gate.outcome}>
        <GateResult comparison={comparison} messages={messages} />
        <Disclosure label={messages.text('summary.gateDetails')}>
          <GateFacts comparison={comparison} messages={messages} />
        </Disclosure>
      </div>
      <SummarySection title={messages.text('summary.changes')}>
        {(id) => (
          <>
            <ChangePlot comparison={comparison} messages={messages} labelledBy={id} />
            <p className={styles.legend}>
              {messages.text('summary.changes.legend', {
                confidence: `${String(Math.round(comparison.stats.confidence * 100))}%`,
              })}
            </p>
          </>
        )}
      </SummarySection>
      {example !== undefined && (
        <SummarySection title={messages.text('summary.examples')}>
          {() => <FailureExamples comparison={comparison} source={example} messages={messages} />}
        </SummarySection>
      )}
      <SummarySection
        title={messages.text('summary.ops')}
        aside={messages.text('summary.cost.notInVerdict')}
      >
        {(id) => <TradeOffs comparison={comparison} messages={messages} labelledBy={id} />}
      </SummarySection>
      <SummarySection title={messages.text('summary.scope')}>
        {() => <JudgedScope comparison={comparison} messages={messages} />}
      </SummarySection>
    </section>
  );
}
