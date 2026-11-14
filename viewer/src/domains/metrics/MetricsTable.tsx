import type { ReactNode } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { dollars, NONE, seconds, tokenMean } from '../../../../src/report/format.js';
import { opsRateNames, type Comparison } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
import { Disclosure } from '../../components/Disclosure.js';
import { pageMessages, type Messages } from '../../i18n/useMessages.js';
import { EntryTable, type EntryRow } from './EntryTable.js';
import { MetricRateValue } from './MetricRateValue.js';
import { ROLES, type Role, type VariantIds } from '../../report/variants.js';
import styles from './metrics.module.css';

type Ops = Comparison['ops'];
type VariantOps = Ops[Role];

const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const;
const FINISH_REASONS = ['stop', 'length', 'content_filter', 'other'] as const;

interface MetricRow {
  readonly key: string;
  readonly label: string;
  readonly value: (role: Role) => ReactNode;
  /** Both variants are 0, so the row is drawn quieter. */
  readonly zero?: boolean;
  /**
   * A short code, such as a finish reason, shown in the code face in place of the label. The
   * label stays the row's name for assistive technology, since the code alone does not say
   * what it counts.
   */
  readonly code?: string;
}

interface MetricGroup {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly MetricRow[];
}

function bothZero(pick: (role: Role) => number | undefined): boolean {
  return ROLES.every((role) => pick(role) === 0);
}

function groups(ops: Ops, variantIds: VariantIds, messages: Messages): MetricGroup[] {
  const countRow = (key: string, label: string, pick: (variant: VariantOps) => number) => ({
    key,
    label,
    value: (role: Role) => String(pick(ops[role])),
    zero: bothZero((role) => pick(ops[role])),
  });
  return [
    {
      key: 'rates',
      title: messages.text('metrics.group.rates'),
      rows: opsRateNames.map((name) => {
        const label = messages.text(`metrics.rate.${name}`);
        return {
          key: name,
          label,
          value: (role: Role) => (
            <MetricRateValue
              label={`${label} (${variantIds[role]})`}
              rate={ops[role].rates[name]}
              messages={messages}
            />
          ),
          zero: bothZero((role) => ops[role].rates[name].count),
        };
      }),
    },
    {
      key: 'failures',
      title: messages.text('metrics.group.failures'),
      rows: [
        countRow(
          'systematic-trials',
          messages.text('metrics.systematic.trials'),
          (variant) => variant.systematic.trials,
        ),
        countRow(
          'systematic-cases',
          messages.text('metrics.systematic.cases'),
          (variant) => variant.systematic.cases,
        ),
        countRow(
          'abandoned-timeout',
          messages.text('metrics.abandoned.timeout'),
          (variant) => variant.abandoned.timeout,
        ),
        countRow(
          'abandoned-restart',
          messages.text('metrics.abandoned.restart'),
          (variant) => variant.abandoned.restart,
        ),
      ],
    },
    {
      key: 'finish',
      title: messages.text('metrics.group.finish'),
      rows: FINISH_REASONS.map((reason) => ({
        ...countRow(
          `finish-${reason}`,
          messages.text('metrics.finishReason', { reason }),
          (variant) => variant.finishReasons[reason],
        ),
        code: reason,
      })),
    },
    {
      key: 'latency',
      title: messages.text('metrics.group.latency'),
      rows: [
        {
          key: 'latency-p50',
          label: messages.text('metrics.latencyP50'),
          value: (role: Role) => seconds(ops[role].latencyMs.p50),
        },
        {
          key: 'latency-p95',
          label: messages.text('metrics.latencyP95'),
          value: (role: Role) => seconds(ops[role].latencyMs.p95),
        },
      ],
    },
    {
      key: 'tokens',
      title: messages.text('metrics.group.tokens'),
      rows: [
        ...TOKEN_FIELDS.map((field) => ({
          key: `tokens-${field}`,
          label: messages.text(`metrics.tokens.${field}`),
          value: (role: Role) => {
            const mean = ops[role].tokensPerTrial[field];
            return mean === undefined ? NONE : tokenMean(mean);
          },
          zero: bothZero((role) => ops[role].tokensPerTrial[field]),
        })),
        {
          key: 'cost-per-trial',
          label: messages.text('metrics.costPerTrial'),
          value: (role: Role) => dollars(ops[role].costPerTrialUsd),
        },
      ],
    },
  ];
}

/** Each variant's entries of one list of `ops`, baseline first, as rows of an `EntryTable`. */
function entryRows<T>(
  ops: Ops,
  variantIds: VariantIds,
  entries: (variant: VariantOps) => readonly T[],
  cells: (entry: T) => readonly ReactNode[],
): EntryRow[] {
  return ROLES.flatMap((role) =>
    entries(ops[role]).map((entry, index) => ({
      key: `${role}-${String(index)}`,
      cells: [variantIds[role], ...cells(entry)],
    })),
  );
}

interface FiguresTableProps {
  readonly caption: string;
  readonly groups: readonly MetricGroup[];
  readonly messages: Messages;
}

/** Metric rows per variant in titled groups; a row that is 0 for both variants is quieter. */
function FiguresTable({ caption, groups: figureGroups, messages }: FiguresTableProps) {
  return (
    <table className={[styles.table, styles.figures].filter(Boolean).join(' ')}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{messages.text('metrics.column.metric')}</th>
          {ROLES.map((role) => (
            <th key={role} scope="col" className={styles.number}>
              {messages.text(`role.${role}`)}
            </th>
          ))}
        </tr>
      </thead>
      {figureGroups.map((group) => (
        <tbody key={group.key}>
          <tr className={styles.groupRow}>
            <th scope="rowgroup" colSpan={ROLES.length + 1}>
              {group.title}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.key} className={row.zero === true ? styles.zero : undefined}>
              <th scope="row">
                {row.code === undefined ? (
                  row.label
                ) : (
                  <>
                    <span className={styles.hidden}>{row.label}</span>
                    <span aria-hidden="true" className={styles.code}>
                      {row.code}
                    </span>
                  </>
                )}
              </th>
              {ROLES.map((role) => (
                <td key={role} className={styles.number}>
                  {row.value(role)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

interface MetricsTableProps {
  readonly lang: Lang;
  readonly ops: Ops;
}

/**
 * Every field of `comparison.ops` per variant (FR-006), closed until opened: the table of rates
 * and figures in groups, then the top messages, side-call failures and response models. The
 * decision summary shows the ones that matter for the decision. A row that is 0 for both
 * variants is drawn quieter. Discard reasons belong to `PostprocessPanel`, as in report.md.
 */
export function MetricsTable({ lang, ops }: MetricsTableProps) {
  const messages = pageMessages(lang);
  const variantColumn = messages.text('metrics.column.variant');
  const countColumn = messages.text('metrics.column.count');
  const kindColumn = messages.text('metrics.column.errorKind');
  const none = messages.text('metrics.none');
  // Roles name the variants on this page; the title names their IDs once.
  const roles = {
    baseline: messages.text('role.baseline'),
    candidate: messages.text('role.candidate'),
  };
  const allGroups = groups(ops, roles, messages);
  return (
    <div className={styles.block}>
      <Disclosure label={messages.text('metrics.all')}>
        <FiguresTable
          caption={messages.text('metrics.table.caption')}
          groups={allGroups}
          messages={messages}
        />
        <div className={styles.entries}>
          <EntryTable
            title={messages.text('metrics.topMessages')}
            columns={[
              variantColumn,
              kindColumn,
              countColumn,
              messages.text('metrics.column.message'),
            ]}
            rows={entryRows(
              ops,
              roles,
              (variant) => variant.topMessages,
              (top) => [top.kind, String(top.count), <CodeText key="message" text={top.message} />],
            )}
            emptyText={none}
          />
          <EntryTable
            title={messages.text('metrics.sideCallFailures')}
            columns={[variantColumn, kindColumn, countColumn]}
            rows={entryRows(
              ops,
              roles,
              (variant) => variant.sideCallFailures,
              (failure) => [failure.kind, String(failure.count)],
            )}
            emptyText={none}
          />
          <EntryTable
            title={messages.text('metrics.responseModels')}
            columns={[
              variantColumn,
              messages.text('metrics.column.model'),
              messages.text('metrics.column.trials'),
            ]}
            rows={entryRows(
              ops,
              roles,
              (variant) => variant.responseModels,
              (model) => [<CodeText key="model" text={model.model} />, String(model.trials)],
            )}
            emptyText={none}
          />
        </div>
      </Disclosure>
    </div>
  );
}
