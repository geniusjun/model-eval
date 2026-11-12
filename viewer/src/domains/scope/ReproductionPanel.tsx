import { useId } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { percent } from '../../../../src/report/format.js';
import type { ComparedRun, Comparison } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import type { Role } from '../../report/variants.js';
import { Detail, DetailList } from './Detail.js';
import styles from './ReproductionPanel.module.css';

interface RunDetailsProps {
  readonly side: Role;
  readonly run: ComparedRun;
  readonly messages: Messages;
}

/** One compared run; versions it did not record are left out, as in `report.md`. */
function RunDetails({ side, run, messages }: RunDetailsProps) {
  const { adapter, service, variant } = run;
  const yesNo = (value: boolean): string => messages.text(value ? 'scope.yes' : 'scope.no');
  return (
    <section>
      <h3>{messages.text(`scope.reproduction.${side}`, { variant: variant.id })}</h3>
      <DetailList>
        <Detail term={messages.text('scope.run.run')}>{run.runId}</Detail>
        <Detail term={messages.text('scope.run.gradeSet')}>{run.gradeSetId}</Detail>
        <Detail term={messages.text('scope.run.model')}>
          <CodeText text={variant.model} />
        </Detail>
        {variant.params === undefined ? null : (
          <Detail term={messages.text('scope.run.params')}>
            <CodeText text={JSON.stringify(variant.params)} />
          </Detail>
        )}
        <Detail term={messages.text('scope.run.fingerprint')}>
          <CodeText text={variant.fingerprint} />
        </Detail>
        <Detail term={messages.text('scope.run.status')}>{run.status}</Detail>
        <Detail term={messages.text('scope.run.tool')}>
          <CodeText text={`${run.tool.name} ${run.tool.version}`} />
        </Detail>
        <Detail term={messages.text('scope.run.adapter')}>
          <CodeText text={adapter.name} /> <CodeText text={adapter.version} />
        </Detail>
        <Detail term={messages.text('scope.run.launchHash')}>
          <CodeText text={adapter.launchHash} />
        </Detail>
        {adapter.helper === undefined ? null : (
          <Detail term={messages.text('scope.run.helper')}>
            <CodeText text={adapter.helper.language} /> <CodeText text={adapter.helper.version} />
          </Detail>
        )}
        {service.version === undefined ? null : (
          <Detail term={messages.text('scope.run.serviceVersion')}>
            <CodeText text={service.version} />
          </Detail>
        )}
        {service.dirty === undefined ? null : (
          <Detail term={messages.text('scope.run.serviceDirty')}>{yesNo(service.dirty)}</Detail>
        )}
        {service.treeHash === undefined ? null : (
          <Detail term={messages.text('scope.run.treeHash')}>
            <CodeText text={service.treeHash} />
          </Detail>
        )}
        <Detail term={messages.text('scope.run.postprocess')}>{yesNo(run.postprocess)}</Detail>
      </DetailList>
    </section>
  );
}

interface ReproductionPanelProps {
  readonly lang: Lang;
  readonly comparisonId: string;
  readonly createdAt: string;
  readonly baseline: ComparedRun;
  readonly candidate: ComparedRun;
  readonly stats: Comparison['stats'];
  readonly config: Comparison['config'];
}

/** What reproduces the comparison: runs, versions, statistics, settings and commands (FR-007). */
export function ReproductionPanel({
  lang,
  comparisonId,
  createdAt,
  baseline,
  candidate,
  stats,
  config,
}: ReproductionPanelProps) {
  const headingId = useId();
  const messages = pageMessages(lang);
  const commands = [
    `model-eval compare ${baseline.runId} ${candidate.runId}`,
    `model-eval report ${comparisonId}`,
  ];
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId}>{messages.text('scope.reproduction.heading')}</h2>
      <DetailList>
        <Detail term={messages.text('scope.reproduction.comparison')}>{comparisonId}</Detail>
        <Detail term={messages.text('scope.reproduction.createdAt')}>{createdAt}</Detail>
      </DetailList>
      <RunDetails side="baseline" run={baseline} messages={messages} />
      <RunDetails side="candidate" run={candidate} messages={messages} />
      <section>
        <h3>{messages.text('scope.stats.heading')}</h3>
        <DetailList>
          <Detail term={messages.text('scope.stats.confidence')}>
            {percent(stats.confidence)}
          </Detail>
          <Detail term={messages.text('scope.stats.method')}>{stats.method}</Detail>
          <Detail term={messages.text('scope.stats.gatedCells')}>{String(stats.gatedCells)}</Detail>
          <Detail term={messages.text('scope.stats.zLower')}>{String(stats.zLower)}</Detail>
          <Detail term={messages.text('scope.stats.zUpper')}>{String(stats.zUpper)}</Detail>
          <Detail term={messages.text('scope.stats.minCases')}>{String(stats.minCases)}</Detail>
        </DetailList>
      </section>
      <section>
        <h3>{messages.text('scope.settings')}</h3>
        <pre className={styles.code}>{JSON.stringify(config, null, 2)}</pre>
      </section>
      <section>
        <h3>{messages.text('scope.commands')}</h3>
        <pre className={styles.code}>{commands.join('\n')}</pre>
      </section>
    </section>
  );
}
