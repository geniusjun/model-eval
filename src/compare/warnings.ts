import { canonicalJson, compareCodeUnits } from '../adapter/canonical-json.js';
import type { ReportConfig } from '../config/schema.js';
import { isRecord } from '../report/code-text.js';
import type { Redactor } from '../report/redact.js';
import type { Gate } from '../report/schema.js';
import type { Manifest } from '../run/manifest.js';
import type { AttemptLine } from '../run/records.js';
import { warningSchema, type Warning, type WarningCode } from '../run/warning.js';
import type { PerRole } from '../stats/interval.js';
import { byCase } from './finished.js';
import { outcomeShare } from './ops.js';

// data-model §Warnings: what a comparison re-raises from both runs and how it groups warnings.

export interface WarningRun {
  readonly manifest: Manifest;
  /** The run's finished effective lines on common cases (`finishedTrials`). */
  readonly finished: readonly AttemptLine[];
}

/** Manifest warnings a comparison copies under their run's variant. */
const COPIED_CODES: ReadonlySet<WarningCode> = new Set([
  'budget-overrun',
  'unpriced-model',
  'cached-input-unpriced',
  'estimate-low-accuracy',
  'resume-unverified',
  'resume-config-ignored',
]);

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareCodeUnits);

/** Response model snapshots of the run's `ok` trials, sorted. */
function snapshots(run: WarningRun): string[] {
  return sortedUnique(
    run.finished.flatMap((line) =>
      line.status === 'ok' && line.modelSnapshot !== undefined ? [line.modelSnapshot] : [],
    ),
  );
}

function transientRate(run: WarningRun, threshold: number): Warning[] {
  const { count, total } = outcomeShare(run.finished, 'transient');
  const rate = total === 0 ? 0 : count / total;
  const id = run.manifest.variant.id;
  return rate > threshold
    ? [{ code: 'transient-rate', params: { rates: { [id]: rate }, threshold }, variants: [id] }]
    : [];
}

/** Cases with at least two finished repeats, all `ok` with the same raw answer (FR-016). */
function identicalRepeats(run: WarningRun): Warning[] {
  const caseIds = [...byCase(run.finished)].flatMap(([caseId, lines]) => {
    const [first] = lines;
    return lines.length >= 2 &&
      first?.status === 'ok' &&
      lines.every((line) => line.status === 'ok' && line.raw === first.raw)
      ? [caseId]
      : [];
  });
  return caseIds.length === 0
    ? []
    : [
        {
          code: 'identical-repeats',
          variants: [run.manifest.variant.id],
          caseIds: sortedUnique(caseIds),
        },
      ];
}

function responseModelChanged(run: WarningRun): Warning[] {
  const models = snapshots(run);
  const id = run.manifest.variant.id;
  return models.length > 1
    ? [{ code: 'response-model-changed', params: { models: { [id]: models } }, variants: [id] }]
    : [];
}

/** Trials whose request fingerprint differs from the render fingerprint of their case (FR-015). */
function renderMismatch(run: WarningRun): Warning[] {
  const prompts = run.manifest.prompts ?? {};
  const mismatched = run.finished.filter((line) => {
    const rendered = Object.hasOwn(prompts, line.caseId) ? prompts[line.caseId] : undefined;
    return (
      line.status === 'ok' &&
      line.fingerprint !== undefined &&
      rendered !== undefined &&
      line.fingerprint !== rendered
    );
  });
  const id = run.manifest.variant.id;
  return mismatched.length === 0
    ? []
    : [
        {
          code: 'render-mismatch',
          params: { trials: { [id]: mismatched.length } },
          variants: [id],
          caseIds: sortedUnique(mismatched.map((line) => line.caseId)),
        },
      ];
}

/** The run's trial-based warnings, counted on the given finished lines as the run raises them. */
export function trialWarnings(run: WarningRun, report: ReportConfig): Warning[] {
  return [
    ...transientRate(run, report.warn.transientRate),
    ...identicalRepeats(run),
    ...responseModelChanged(run),
    ...renderMismatch(run),
  ];
}

function copiedWarnings(manifest: Manifest): Warning[] {
  const variants = [manifest.variant.id];
  return [...manifest.warnings, ...manifest.segments.flatMap((segment) => segment.resumeWarnings)]
    .filter((warning) => COPIED_CODES.has(warning.code))
    .map((warning) => ({ ...warning, variants }));
}

function sameResponseModel(runs: PerRole<WarningRun>): Warning[] {
  const baseline = snapshots(runs.baseline);
  const candidate = snapshots(runs.candidate);
  const differentModels =
    runs.baseline.manifest.variant.model !== runs.candidate.manifest.variant.model;
  return differentModels &&
    baseline.length > 0 &&
    canonicalJson(baseline) === canonicalJson(candidate)
    ? [
        {
          code: 'same-response-model',
          params: { models: baseline },
          variants: [runs.baseline.manifest.variant.id, runs.candidate.manifest.variant.id],
        },
      ]
    : [];
}

/**
 * `partial-run` with the params of the gate reason of that name, which row 1 of §Gate raises
 * whenever a compared run is not `complete`, whatever the gate config.
 */
export function partialRunWarnings(gate: Gate): Warning[] {
  return gate.reasons.flatMap((reason): Warning[] =>
    reason.code === 'partial-run'
      ? [{ code: 'partial-run', params: reason.params, variants: Object.keys(reason.params.runs) }]
      : [],
  );
}

/**
 * Every run warning of both runs a comparison holds: trial-based codes recounted on common cases,
 * manifest warnings copied under their variant, and `same-response-model`, grouped.
 */
export function comparisonWarnings(runs: PerRole<WarningRun>, report: ReportConfig): Warning[] {
  return groupWarnings([
    ...trialWarnings(runs.baseline, report),
    ...trialWarnings(runs.candidate, report),
    ...copiedWarnings(runs.baseline.manifest),
    ...copiedWarnings(runs.candidate.manifest),
    ...sameResponseModel(runs),
  ]);
}

// Grouping

const CONFLICT = Symbol('conflict');

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Lists merge as sorted sets, objects by key, and other values must be equal. */
function mergeValues(a: unknown, b: unknown): unknown {
  if (isList(a) && isList(b)) {
    const unique = new Map([...a, ...b].map((item) => [JSON.stringify(item), item]));
    return [...unique].sort(([x], [y]) => compareCodeUnits(x, y)).map(([, item]) => item);
  }
  if (isRecord(a) && isRecord(b)) {
    const merged: Record<string, unknown> = { ...a };
    for (const [key, value] of Object.entries(b)) {
      const next = Object.hasOwn(merged, key) ? mergeValues(merged[key], value) : value;
      if (next === CONFLICT) {
        return CONFLICT;
      }
      merged[key] = next;
    }
    return merged;
  }
  return sameValue(a, b) ? a : CONFLICT;
}

/** One warning holding both, or undefined when a value differs for the same key. */
function mergeWarnings(a: Warning, b: Warning): Warning | undefined {
  const { variants: aVariants = [], ...aRest } = a;
  const { variants: bVariants = [], ...bRest } = b;
  const merged = mergeValues(aRest, bRest);
  if (!isRecord(merged)) {
    return undefined;
  }
  const variants = [...new Set([...aVariants, ...bVariants])];
  const parsed = warningSchema.safeParse(variants.length === 0 ? merged : { ...merged, variants });
  return parsed.success ? parsed.data : undefined;
}

/** Merges the warning into the first member it agrees with, else adds it. */
function addToGroup(group: readonly Warning[], warning: Warning): Warning[] {
  for (const [index, existing] of group.entries()) {
    const merged = mergeWarnings(existing, warning);
    if (merged !== undefined) {
      return group.map((member, at) => (at === index ? merged : member));
    }
  }
  return [...group, warning];
}

function groupKey(warning: Warning): string {
  return canonicalJson([
    warning.code,
    warning.ruleId ?? null,
    warning.lang ?? null,
    warning.file ?? null,
    warning.line ?? null,
    warning.column ?? null,
    warning.code === 'adapter-warnings' ? warning.params.sentence : null,
  ]);
}

/**
 * One warning per code, rule, language and file location, and per sentence for
 * `adapter-warnings`: variants, cases and per-variant params merged. Warnings whose values
 * disagree for the same variant stay apart. Sorted by code, rule, language and sentence.
 */
export function groupWarnings(warnings: readonly Warning[]): Warning[] {
  const groups = new Map<string, Warning[]>();
  for (const warning of warnings) {
    const key = groupKey(warning);
    const group = groups.get(key) ?? [];
    groups.set(key, addToGroup(group, warning));
  }
  return [...groups].sort(([a], [b]) => compareCodeUnits(a, b)).flatMap(([, group]) => group);
}

/** {@link groupWarnings} over redacted warnings, so texts that differ only in a redacted part merge. */
export function groupRedactedWarnings(warnings: readonly Warning[], redactor: Redactor): Warning[] {
  return groupWarnings(warnings.map((warning) => warningSchema.parse(redactor.json(warning))));
}
