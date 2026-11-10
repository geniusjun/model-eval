import { z } from 'zod';

import { canonicalJson, compareCodeUnits, hashValue, shortHex } from '../adapter/canonical-json.js';
import { SHA256_PATTERN, type Sha256 } from '../config/identifiers.js';
import type { Case, Config, Rule } from '../config/schema.js';
import type { RunCase } from '../grade/grade.js';
import type { GradeSet } from '../grade/grade-set.js';
import type { Grade } from '../grade/record.js';
import { savedComparisons } from '../report/layout.js';
import { createRedactor, type Redactor } from '../report/redact.js';
import {
  comparedRunSchema,
  comparisonSchema,
  sampleTextSchema,
  type Comparison,
  type ComparedRun,
  type Coverage,
  type RuleSummary,
} from '../report/schema.js';
import { trialKeyId } from '../run/ids.js';
import type { Manifest } from '../run/manifest.js';
import type { AttemptLine, TrialLine } from '../run/records.js';
import type { Warning } from '../run/warning.js';
import { zValues, type PerRole } from '../stats/interval.js';
import { aggregates, cellEvidence, cellId, cellOf, type CellEvidence } from './cells.js';
import { commonCases, type CommonCase } from './common-cases.js';
import { finishedTrials } from './finished.js';
import {
  applicableToTargets,
  completionRates,
  decideGate,
  excludedFromGateWarnings,
  gatedCellTest,
  gateRules,
  type CellTrials,
  type FailingTrial,
} from './gate.js';
import { abandonedCounts, comparisonOps, reviewOps } from './ops.js';
import { comparisonSamples, decisionSummary, judgedScope, type ComparedCase } from './summary.js';
import { systematicFailures } from './systematic.js';
import { comparisonWarnings, groupRedactedWarnings, partialRunWarnings } from './warnings.js';

// data-model §Comparison: one comparison of two runs from their records and grade sets.

/** `stats.method` of every comparison (data-model §Statistics). */
export const STATS_METHOD = 'newcombe-hybrid-score with case-cluster design effect';

type Role = keyof PerRole<unknown>;

const byRole = <T>(value: (role: Role) => T): PerRole<T> => ({
  baseline: value('baseline'),
  candidate: value('candidate'),
});

/** What a comparison reads of one run. */
export interface ComparedRunRecords {
  readonly manifest: Manifest;
  /** Every complete line of the run's `trials.jsonl`, in file order. */
  readonly lines: readonly TrialLine[];
  /** The run's grade set, made with the current rules (FR-019), its evidence redacted (FR-031). */
  readonly gradeSet: GradeSet;
}

/** A case of the current case files with its case hash and resolved language key. */
export interface CurrentCase {
  readonly definition: Case;
  readonly hash: Sha256;
  readonly lang: string;
}

export type ComparisonConfig = Pick<Config, 'gate' | 'stats' | 'report' | 'redact'>;

export interface ComparisonInput {
  readonly runs: PerRole<ComparedRunRecords>;
  /** Every rule of the current rule files. */
  readonly rules: readonly Rule[];
  /** Every case of the current case files. */
  readonly cases: readonly CurrentCase[];
  readonly config: ComparisonConfig;
  /** `output.dir`, whose earlier comparisons give `priorComparisons`. */
  readonly outputDir: string;
  /** The clock of `createdAt`, the only volatile field the comparison sets itself. */
  readonly now: () => Date;
}

/** `cmp-` + 12 hex of the grade sets, run statuses and the settings that shape the result. */
export function comparisonIdOf(
  runs: PerRole<Pick<ComparedRunRecords, 'manifest' | 'gradeSet'>>,
  config: ComparisonConfig,
): string {
  const run = (role: Role) => ({
    gradeSetId: runs[role].gradeSet.header.gradeSetId,
    status: runs[role].manifest.status,
  });
  const hash = hashValue({
    baseline: run('baseline'),
    candidate: run('candidate'),
    gate: config.gate,
    stats: config.stats,
    report: config.report,
    redact: config.redact,
  });
  return `cmp-${shortHex(hash)}`;
}

const isSha256 = (value: string): value is Sha256 => SHA256_PATTERN.test(value);

/** Manifest case hashes are validated as Sha256 on read, so a mismatch is a broken invariant. */
function runCasesOf(manifest: Manifest, current: ReadonlyMap<string, CurrentCase>): RunCase[] {
  return manifest.cases.map(({ hash, ...runCase }) => {
    if (!isSha256(hash)) {
      throw new RangeError(`manifest case ${runCase.id} has no case hash`);
    }
    return { ...runCase, hash, current: current.get(runCase.id) };
  });
}

function coverageOf(cases: PerRole<readonly RunCase[]>, common: readonly CommonCase[]): Coverage {
  const ids = byRole((role) => new Set(cases[role].map((runCase) => runCase.id)));
  const commonIds = new Set(common.map((testCase) => testCase.id));
  const sorted = (values: Iterable<string>) => [...values].sort(compareCodeUnits);
  return {
    commonCases: common.length,
    baselineOnly: sorted([...ids.baseline].filter((id) => !ids.candidate.has(id))),
    candidateOnly: sorted([...ids.candidate].filter((id) => !ids.baseline.has(id))),
    changedHash: sorted(
      [...ids.baseline].filter((id) => ids.candidate.has(id) && !commonIds.has(id)),
    ),
  };
}

function comparedRun({ manifest, gradeSet }: ComparedRunRecords): ComparedRun {
  const { tool, adapter } = manifest;
  return {
    runId: manifest.runId,
    gradeSetId: gradeSet.header.gradeSetId,
    variant: manifest.variant,
    status: manifest.status,
    tool: { name: tool.name, version: tool.version },
    adapter: {
      name: adapter.name,
      version: adapter.version,
      launchHash: adapter.launchHash,
      ...(adapter.helper === undefined ? {} : { helper: adapter.helper }),
    },
    service: manifest.service,
    postprocess: adapter.capabilities.postprocess,
  };
}

function ruleSummary(rule: Rule, gateMargin: number): RuleSummary {
  return {
    id: rule.id,
    title: rule.title,
    severity: rule.severity,
    languages: rule.languages,
    gateOn: rule.gateOn,
    margin: rule.margin ?? gateMargin,
    anchors: rule.anchors,
    origin: rule.origin,
  };
}

/** One run's judged failures and systematic failures per cell, systematic `skip` turned to fail. */
interface CellFailures {
  readonly failing: FailingTrial[];
  readonly systematic: AttemptLine[];
}

function cellFailures(
  grades: readonly Grade[],
  lang: ReadonlyMap<string, string>,
  finished: readonly AttemptLine[],
  systematic: readonly AttemptLine[],
  redactor: Redactor,
): Map<string, CellFailures> {
  const lines = new Map(finished.map((line) => [trialKeyId(line), line]));
  const systematicKeys = new Set(systematic.map(trialKeyId));
  const cells = new Map<string, CellFailures>();
  for (const grade of grades) {
    const caseLang = lang.get(grade.caseId);
    const line = lines.get(trialKeyId(grade));
    const isSystematic =
      grade.surface === 'trial' &&
      grade.outcome === 'skip' &&
      systematicKeys.has(trialKeyId(grade));
    if (caseLang === undefined || (grade.outcome !== 'fail' && !isSystematic)) {
      continue;
    }
    const id = cellId({ ruleId: grade.ruleId, lang: caseLang, surface: grade.surface });
    const cell = cells.get(id) ?? { failing: [], systematic: [] };
    cell.failing.push({
      caseId: grade.caseId,
      repeat: grade.repeat,
      evidence: grade.evidence,
      message: line?.status === 'error' ? redactor.text(line.error.message) : undefined,
    });
    if (isSystematic && line !== undefined) {
      cell.systematic.push(line);
    }
    cells.set(id, cell);
  }
  return cells;
}

/** The candidate's failing trials per cell, and abandoned systematic failures of `completed`. */
function cellTrialsOf(
  evidence: readonly CellEvidence[],
  failures: PerRole<ReadonlyMap<string, CellFailures>>,
): CellTrials[] {
  return evidence.map((cell) => {
    const id = cellId(cell);
    const key = { ruleId: cell.ruleId, lang: cell.lang, surface: cell.surface };
    return {
      ...key,
      candidateFailures: failures.candidate.get(id)?.failing ?? [],
      ...(cell.systematic === undefined
        ? {}
        : {
            abandonedInSystematic: byRole((role) =>
              abandonedCounts(failures[role].get(id)?.systematic ?? []),
            ),
          }),
    };
  });
}

const priorRunSchema = comparedRunSchema.pick({ runId: true, variant: true });
const priorComparisonSchema = z.object({ baseline: priorRunSchema, candidate: priorRunSchema });

/**
 * Distinct run pairs among saved comparisons with the same two variant fingerprints in the same
 * roles, the current pair excluded.
 */
async function priorComparisons(outputDir: string, runs: PerRole<Manifest>): Promise<number> {
  const pairId = (baseline: string, candidate: string) => canonicalJson([baseline, candidate]);
  const pairs = new Set<string>();
  for (const { comparison: prior } of await savedComparisons(outputDir, priorComparisonSchema)) {
    if (
      prior.baseline.variant.fingerprint === runs.baseline.variant.fingerprint &&
      prior.candidate.variant.fingerprint === runs.candidate.variant.fingerprint
    ) {
      pairs.add(pairId(prior.baseline.runId, prior.candidate.runId));
    }
  }
  pairs.delete(pairId(runs.baseline.runId, runs.candidate.runId));
  return pairs.size;
}

/**
 * The Comparison of two runs over their common, unchanged cases (FR-027): cells and their
 * verdicts, the gate, metrics, warnings, the decision summary and samples, redacted (FR-031).
 * `ops`, `gate` and `warnings` group free text, so they are built from redacted text; the
 * evidence of failing samples comes redacted from the grade sets; the rest, sample texts
 * included, is redacted here, so no text is redacted twice.
 */
export async function buildComparison(input: ComparisonInput): Promise<Comparison> {
  const { runs, config } = input;
  const manifests = byRole((role) => runs[role].manifest);
  const current = new Map(input.cases.map((testCase) => [testCase.definition.id, testCase]));
  const runCases = byRole((role) => runCasesOf(manifests[role], current));
  const common = commonCases(runCases);
  const commonIds = new Set(common.map((testCase) => testCase.id));
  const finished = byRole((role) =>
    finishedTrials(runs[role].lines, manifests[role].limits.retries, commonIds),
  );
  const systematic = systematicFailures(finished);
  const grades = byRole((role) => runs[role].gradeSet.grades);

  const targetOf = new Map(runCases.baseline.map((runCase) => [runCase.id, runCase.target]));
  const targets = [...new Set(common.flatMap(({ id }) => targetOf.get(id) ?? []))].sort(
    compareCodeUnits,
  );
  const rules = applicableToTargets(input.rules, targets);

  const evidence = cellEvidence({
    cases: common,
    rules,
    gateMargin: config.gate.margin,
    grades,
    systematic,
    finished,
  });
  const isGated = gatedCellTest(gateRules(rules, config.gate).gated, config.report.lowBaseline);
  const gatedCells = evidence.filter(isGated).length;
  const z = zValues(config.stats.confidence, gatedCells);
  const cells = evidence.map((cell) =>
    cellOf(cell, {
      gated: isGated(cell),
      z,
      minCases: config.stats.minCases,
      runCases: manifests.candidate.cases.length,
    }),
  );

  const redactor = createRedactor(config.redact);
  const lang = new Map(common.map((testCase) => [testCase.id, testCase.lang]));
  const failures = byRole((role) =>
    cellFailures(grades[role], lang, finished[role], systematic[role], redactor),
  );
  const cellTrials = cellTrialsOf(evidence, failures);
  const completion = completionRates(common, finished, systematic);
  const ops = comparisonOps(
    byRole((role) => ({
      lines: runs[role].lines,
      finished: finished[role],
      systematic: systematic[role],
    })),
    z.zLower,
    redactor,
  );
  const opsReview = reviewOps(
    ops,
    config.report.warn,
    byRole((role) => manifests[role].variant.id),
  );
  const gate = decideGate({
    runs: byRole((role) => ({
      variant: manifests[role].variant.id,
      status: manifests[role].status,
      stopReason: manifests[role].stopReason,
      timeoutMs: manifests[role].limits.timeoutMs,
    })),
    completion,
    rules,
    gate: config.gate,
    cells,
    cellTrials,
  });
  // Each source raises its own codes; groupWarnings merges them across sources.
  const warningSources: readonly (readonly Warning[])[] = [
    comparisonWarnings(
      byRole((role) => ({ manifest: manifests[role], finished: finished[role] })),
      config.report,
    ),
    opsReview.warnings,
    excludedFromGateWarnings(gate.excluded),
    partialRunWarnings(gate),
  ];
  const warnings = groupRedactedWarnings(warningSources.flat(), redactor);
  const scope = judgedScope(rules, targets, cells);
  const comparedCases: ComparedCase[] = common.flatMap(({ id, lang: caseLang }) => {
    const definition = current.get(id)?.definition;
    return definition === undefined ? [] : [{ definition, lang: caseLang }];
  });

  const comparison: Comparison = {
    comparisonId: comparisonIdOf(runs, config),
    createdAt: input.now().toISOString(),
    baseline: comparedRun(runs.baseline),
    candidate: comparedRun(runs.candidate),
    cells,
    aggregates: aggregates(cells),
    rules: rules.map((rule) => ruleSummary(rule, config.gate.margin)),
    summary: decisionSummary({ cells, ops: opsReview.changes, scope }),
    ops,
    samples: comparisonSamples({
      rules,
      cases: comparedCases,
      trials: finished,
      cells,
      cellTrials,
      perCell: config.report.samples,
    }),
    warnings,
    coverage: coverageOf(runCases, common),
    scope,
    gate,
    completion: completion.baseline,
    priorComparisons: await priorComparisons(input.outputDir, manifests),
    stats: {
      confidence: config.stats.confidence,
      method: STATS_METHOD,
      gatedCells,
      zLower: z.zLower,
      zUpper: z.zUpper,
      minCases: config.stats.minCases,
    },
    config: { gate: config.gate, stats: config.stats, report: config.report },
  };
  const {
    ops: redactedOps,
    gate: redactedGate,
    warnings: redactedWarnings,
    samples,
    ...rest
  } = comparison;
  const redacted = comparisonSchema
    .omit({ ops: true, gate: true, warnings: true, samples: true })
    .parse(redactor.json(rest));
  const texts = samples.texts.map((text) => sampleTextSchema.parse(redactor.json(text)));
  return comparisonSchema.parse({
    ...redacted,
    ops: redactedOps,
    gate: redactedGate,
    warnings: redactedWarnings,
    samples: { ...samples, texts },
  });
}
