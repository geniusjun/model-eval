import { useId, type ReactNode } from 'react';

import { message } from '../../../src/messages/index.js';
import type { ComparedRun, ComparisonPage } from '../../../src/report/schema.js';
import { LanguageSwitch } from '../components/LanguageSwitch.js';
import { LowBaselineCells } from '../domains/grid/LowBaselineCells.js';
import { PooledRates } from '../domains/grid/PooledRates.js';
import { RuleLanguageGrid } from '../domains/grid/RuleLanguageGrid.js';
import { LatencyChart } from '../domains/metrics/LatencyChart.js';
import { MetricsTable } from '../domains/metrics/MetricsTable.js';
import { PostprocessPanel } from '../domains/metrics/PostprocessPanel.js';
import { WarningList } from '../domains/metrics/WarningList.js';
import { ReproductionPanel } from '../domains/scope/ReproductionPanel.js';
import { ScopePanel } from '../domains/scope/ScopePanel.js';
import { DecisionSummary } from '../domains/summary/DecisionSummary.js';
import { WithheldBanner } from '../domains/summary/WithheldBanner.js';
import { useHashParam } from '../hooks/useHashParam.js';
import { useMessages } from '../i18n/useMessages.js';
import { resolveView } from '../utils/hash.js';
import styles from './ReportPage.module.css';

interface ReportPageProps {
  readonly page: ComparisonPage;
}

interface RegionProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A region of the page whose parts carry their own lower headings. */
function Region({ title, children }: RegionProps) {
  const headingId = useId();
  return (
    <section className={styles.region} aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {children}
    </section>
  );
}

/** `current (model-a)`: the variant and its model, as the title of report.md names them, without its code span. */
function variantLabel(run: ComparedRun): string {
  return `${run.variant.id} (${run.variant.model})`;
}

/**
 * The result page of one comparison: the withheld banner, the header, then the regions in
 * decision order (research R1): summary, grid with its cell detail, operational metrics, scope
 * and reproduction. The open cell detail is the one the location hash names.
 */
export function ReportPage({ page }: ReportPageProps) {
  const messages = useMessages(page.lang);
  const { lang } = messages;
  const { comparison } = page;
  const { baseline, candidate, ops } = comparison;
  const [hash] = useHashParam();
  const view = resolveView(hash.view, comparison);
  const variants = { baseline: baseline.variant.id, candidate: candidate.variant.id };
  return (
    <main>
      <WithheldBanner comparison={comparison} lang={lang} />
      <header className={styles.header}>
        <h1>
          {message(lang, 'report.title', {
            baseline: variantLabel(baseline),
            candidate: variantLabel(candidate),
          })}
        </h1>
        <LanguageSwitch lang={lang} />
      </header>
      <DecisionSummary comparison={comparison} lang={lang} />
      <Region title={messages.text('grid.heading')}>
        <RuleLanguageGrid
          cells={comparison.cells}
          selected={view.kind === 'cell' ? view.cell : undefined}
          rules={comparison.rules}
          samples={comparison.samples}
          variants={variants}
          lang={lang}
        />
        <PooledRates aggregates={comparison.aggregates} variants={variants} lang={lang} />
        <LowBaselineCells
          cells={comparison.cells}
          lowBaseline={comparison.config.report.lowBaseline}
          variants={variants}
          lang={lang}
        />
      </Region>
      <Region title={messages.text('metrics.heading')}>
        <MetricsTable lang={lang} ops={ops} variantIds={variants} />
        <LatencyChart
          lang={lang}
          latency={{ baseline: ops.baseline.latencyMs, candidate: ops.candidate.latencyMs }}
          variantIds={variants}
        />
        <PostprocessPanel
          lang={lang}
          cells={comparison.cells}
          ops={ops}
          postprocess={{
            baseline: baseline.postprocess,
            candidate: candidate.postprocess,
          }}
          variantIds={variants}
        />
        <WarningList lang={lang} warnings={comparison.warnings} />
      </Region>
      <ScopePanel
        lang={lang}
        scope={comparison.scope}
        rules={comparison.rules}
        excluded={comparison.gate.excluded}
        coverage={comparison.coverage}
        completion={comparison.completion}
        variantIds={variants}
      />
      <ReproductionPanel
        lang={lang}
        comparisonId={comparison.comparisonId}
        createdAt={comparison.createdAt}
        baseline={baseline}
        candidate={candidate}
        stats={comparison.stats}
        config={comparison.config}
      />
    </main>
  );
}
