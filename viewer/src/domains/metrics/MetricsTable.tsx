import type { ReactNode } from 'react';

import type { Lang } from '../../../../src/config/schema.js';
import { dollars, NONE, seconds, tokenMean } from '../../../../src/report/format.js';
import { opsRateNames, type Comparison } from '../../../../src/report/schema.js';
import { CodeText } from '../../components/CodeText.js';
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
}

function rows(ops: Ops, variantIds: VariantIds, messages: Messages): MetricRow[] {
  const count = (pick: (variant: VariantOps) => number) => (role: Role) => String(pick(ops[role]));
  return [
    ...opsRateNames.map((name) => {
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
      };
    }),
    {
      key: 'systematic-trials',
      label: messages.text('metrics.systematic.trials'),
      value: count((variant) => variant.systematic.trials),
    },
    {
      key: 'systematic-cases',
      label: messages.text('metrics.systematic.cases'),
      value: count((variant) => variant.systematic.cases),
    },
    {
      key: 'abandoned-timeout',
      label: messages.text('metrics.abandoned.timeout'),
      value: count((variant) => variant.abandoned.timeout),
    },
    {
      key: 'abandoned-restart',
      label: messages.text('metrics.abandoned.restart'),
      value: count((variant) => variant.abandoned.restart),
    },
    ...FINISH_REASONS.map((reason) => ({
      key: `finish-${reason}`,
      label: messages.text('metrics.finishReason', { reason }),
      value: count((variant) => variant.finishReasons[reason]),
    })),
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
    ...TOKEN_FIELDS.map((field) => ({
      key: `tokens-${field}`,
      label: messages.text(`metrics.tokens.${field}`),
      value: (role: Role) => {
        const mean = ops[role].tokensPerTrial[field];
        return mean === undefined ? NONE : tokenMean(mean);
      },
    })),
    {
      key: 'cost-per-trial',
      label: messages.text('metrics.costPerTrial'),
      value: (role: Role) => dollars(ops[role].costPerTrialUsd),
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

interface MetricsTableProps {
  readonly lang: Lang;
  readonly ops: Ops;
  readonly variantIds: VariantIds;
}

/**
 * Every field of `comparison.ops` per variant: one table of rates and figures, then the top
 * messages, side-call failures and response models (FR-006). Discard reasons belong to
 * `PostprocessPanel`, as in report.md.
 */
export function MetricsTable({ lang, ops, variantIds }: MetricsTableProps) {
  const messages = pageMessages(lang);
  const variantColumn = messages.text('metrics.column.variant');
  const countColumn = messages.text('metrics.column.count');
  const kindColumn = messages.text('metrics.column.errorKind');
  const none = messages.text('metrics.none');
  return (
    <div className={styles.block}>
      <p>{messages.text('metrics.intro')}</p>
      <table className={styles.table}>
        <caption>{messages.text('metrics.table.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{messages.text('metrics.column.metric')}</th>
            {ROLES.map((role) => (
              <th key={role} scope="col">
                {messages.text(`role.${role}`, { variant: variantIds[role] })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows(ops, variantIds, messages).map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {ROLES.map((role) => (
                <td key={role} className={styles.number}>
                  {row.value(role)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <EntryTable
        title={messages.text('metrics.topMessages')}
        columns={[variantColumn, kindColumn, countColumn, messages.text('metrics.column.message')]}
        rows={entryRows(
          ops,
          variantIds,
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
          variantIds,
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
          variantIds,
          (variant) => variant.responseModels,
          (model) => [<CodeText key="model" text={model.model} />, String(model.trials)],
        )}
        emptyText={none}
      />
    </div>
  );
}
