import { useId, useRef, type ReactNode } from 'react';

import { message } from '../../../src/messages/index.js';
import type { ComparedRun, ComparisonPage } from '../../../src/report/schema.js';
import { LanguageSwitch } from '../components/LanguageSwitch.js';
import { SectionNav } from '../components/SectionNav.js';
import { LowBaselineCells } from '../domains/grid/LowBaselineCells.js';
import { PooledRates } from '../domains/grid/PooledRates.js';
import { RuleLanguageGrid } from '../domains/grid/RuleLanguageGrid.js';
import { LatencyChart } from '../domains/metrics/LatencyChart.js';
import { MetricsTable } from '../domains/metrics/MetricsTable.js';
import { PostprocessPanel } from '../domains/metrics/PostprocessPanel.js';
import { WarningList } from '../domains/metrics/WarningList.js';
import { ScopePanel } from '../domains/scope/ScopePanel.js';
import { SideBySide } from '../domains/side-by-side/SideBySide.js';
import { DecisionSummary } from '../domains/summary/DecisionSummary.js';
import { GateOutcome } from '../domains/summary/GateOutcome.js';
import { WithheldBanner } from '../domains/summary/WithheldBanner.js';
import { useHashParam } from '../hooks/useHashParam.js';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight.js';
import { useMessages } from '../i18n/useMessages.js';
import { formatHash, resolveView, type SideView } from '../utils/hash.js';
import styles from './ReportPage.module.css';

interface ReportPageProps {
  readonly page: ComparisonPage;
}

interface RegionProps {
  readonly title: string;
  readonly headingId: string;
  /** One line under the heading that holds for the whole region. */
  readonly intro?: string;
  readonly children: ReactNode;
}

/** A region of the page whose parts carry their own lower headings. */
function Region({ title, headingId, intro, children }: RegionProps) {
  return (
    <section className={styles.region} aria-labelledby={headingId}>
      <h2 id={headingId} tabIndex={-1}>
        {title}
      </h2>
      {intro !== undefined && <p className={styles.intro}>{intro}</p>}
      {children}
    </section>
  );
}

/** The heading IDs of the regions, in page order, for the section buttons of the top bar. */
function useRegionIds() {
  return {
    summary: useId(),
    grid: useId(),
    side: useId(),
    metrics: useId(),
    scope: useId(),
  };
}

/** When the comparison was written, in UTC to the minute: `2026-11-14 16:47 UTC`. */
function writtenAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `current (model-a)`: the variant and its model, as the title of report.md names them, without its code span. */
function variantLabel(run: ComparedRun): string {
  return `${run.variant.id} (${run.variant.model})`;
}

/**
 * The result page of one comparison: the withheld banner, the top bar, then the regions in
 * decision order (research R1): summary, grid with its cell detail, side by side, operational
 * metrics and scope, and a footer naming the comparison; its reproduction details stay in
 * report.md. The open cell detail is the one the location hash names. The
 * top bar keeps the title, the gate outcome, the language switch and a button per region in view
 * while the page scrolls.
 */
export function ReportPage({ page }: ReportPageProps) {
  const messages = useMessages(page.lang);
  const { lang } = messages;
  const { comparison } = page;
  const { baseline, candidate, ops } = comparison;
  const [hash] = useHashParam();
  const view = resolveView(hash.view, comparison);
  const sideHref = (side: SideView) => formatHash({ view: side, lang: hash.lang });
  const ids = useRegionIds();
  const topbarRef = useRef<HTMLElement>(null);
  useMeasuredHeight(topbarRef, '--topbar-height');
  const regressed = comparison.cells.filter((cell) => cell.verdict === 'regressed');
  const regressedRuleIds = new Set(regressed.map((cell) => cell.ruleId));
  const warningCount = comparison.warnings.length;
  return (
    <main>
      <WithheldBanner comparison={comparison} lang={lang} />
      <header ref={topbarRef} className={styles.topbar}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>
            {message(lang, 'report.title', {
              baseline: variantLabel(baseline),
              candidate: variantLabel(candidate),
            })}
          </h1>
          {/* The outcome stays in view while the page scrolls; the summary states it for
              assistive technology. */}
          <span aria-hidden="true" className={styles.outcome}>
            <GateOutcome outcome={comparison.gate.outcome} lang={lang} size="small" />
          </span>
          <LanguageSwitch lang={lang} />
        </div>
        <SectionNav
          label={messages.text('nav.label')}
          sections={[
            { headingId: ids.summary, label: messages.text('nav.summary') },
            {
              headingId: ids.grid,
              label: messages.text('nav.grid'),
              flag: {
                shape: 'triangle',
                count: comparison.gate.blocking.length,
                text: messages.text('nav.regressed', { count: comparison.gate.blocking.length }),
              },
            },
            { headingId: ids.side, label: messages.text('nav.side') },
            {
              headingId: ids.metrics,
              label: messages.text('nav.metrics'),
              flag: {
                shape: 'square',
                count: warningCount,
                text:
                  warningCount === 1
                    ? messages.text('nav.warning')
                    : messages.text('nav.warnings', { count: warningCount }),
              },
            },
            { headingId: ids.scope, label: messages.text('nav.scope') },
          ]}
        />
      </header>
      <DecisionSummary comparison={comparison} lang={lang} headingId={ids.summary} />
      <Region title={messages.text('grid.heading')} headingId={ids.grid}>
        <RuleLanguageGrid
          cells={comparison.cells}
          selected={view.kind === 'cell' ? view.cell : undefined}
          rules={comparison.rules}
          samples={comparison.samples}
          lang={lang}
          sideHref={sideHref}
        />
        <PooledRates aggregates={comparison.aggregates} lang={lang} />
        <LowBaselineCells
          cells={comparison.cells}
          lowBaseline={comparison.config.report.lowBaseline}
          lang={lang}
        />
      </Region>
      <Region title={messages.text('side.heading')} headingId={ids.side}>
        <SideBySide
          rules={comparison.rules}
          regressedRuleIds={regressedRuleIds}
          samples={comparison.samples}
          view={view.kind === 'side' ? view : undefined}
          lang={lang}
        />
      </Region>
      <Region
        title={messages.text('metrics.heading')}
        headingId={ids.metrics}
        intro={messages.text('metrics.intro')}
      >
        <WarningList
          lang={lang}
          warnings={comparison.warnings}
          variants={{ baseline: baseline.variant.id, candidate: candidate.variant.id }}
        />
        <LatencyChart
          lang={lang}
          latency={{ baseline: ops.baseline.latencyMs, candidate: ops.candidate.latencyMs }}
        />
        <MetricsTable lang={lang} ops={ops} />
        <PostprocessPanel
          lang={lang}
          cells={comparison.cells}
          ops={ops}
          postprocess={{
            baseline: baseline.postprocess,
            candidate: candidate.postprocess,
          }}
        />
      </Region>
      <ScopePanel
        headingId={ids.scope}
        lang={lang}
        scope={comparison.scope}
        rules={comparison.rules}
        excluded={comparison.gate.excluded}
        coverage={comparison.coverage}
        completion={comparison.completion}
      />
      <footer className={styles.footer}>
        {`${messages.text('footer.comparison')} `}
        <span>{comparison.comparisonId}</span>
        {` · ${messages.text('footer.written')} `}
        <time dateTime={comparison.createdAt}>{writtenAt(comparison.createdAt)}</time>
      </footer>
    </main>
  );
}
