// The library API; the CLI is a layer on top of it (plan §Project Structure).

// Config, rule and case files.
export { loadProject, type LoadResult, type Project } from './config/load.js';
export type { Diagnostic, LintFinding } from './config/diagnostics.js';
export {
  casesFileSchema,
  configSchema,
  rulesFileSchema,
  type Case,
  type CasesFile,
  type Config,
  type GateConfig,
  type Lang,
  type Rule,
  type RulesFile,
  type StatsConfig,
  type Variant,
} from './config/schema.js';
export type { Sha256 } from './config/identifiers.js';
export { lintProject, type AdapterUse, type LintOptions } from './lint/index.js';
export {
  samplePlan,
  type PlannedCase,
  type PlannedCell,
  type SamplePlan,
  type SamplePlanInput,
} from './lint/sample-plan.js';

// Runs and the swap check.
export {
  executeRun,
  type OverBudget,
  type RunRequest,
  type RunResult,
  type RunStartFailure,
  type ToolVersion,
} from './run/runner.js';
export type { AdapterFailure, RunEnd } from './run/active-run.js';
export {
  executeSwap,
  type SwapEnd,
  type SwapRequest,
  type SwapResult,
  type SwapStartFailure,
} from './run/swap.js';
export {
  processInterrupts,
  type InterruptListener,
  type Interrupts,
  type SignalTarget,
} from './run/signals.js';
export type { AdapterFault, StartFailure as AdapterStartFailure } from './adapter/client.js';
export type { LogParams } from './adapter/protocol.js';
export type { CaseProblem } from './run/run-cases.js';
export type { RenderFailure } from './run/render-cases.js';
export type { LockOwner, LockRefusal } from './run/lock.js';
export type { RandomSource } from './run/retry.js';
export type { SuffixSource } from './run/ids.js';
export type { PerRole } from './stats/interval.js';

// Saved runs, re-grading and comparing.
export {
  readRunRecords,
  type RunReadProblem,
  type RunRecords,
  type RunRecordsResult,
} from './run/run-records.js';
export { runDirectoryPath } from './run/writer.js';
export { currentCases, regradeRun, type RegradeInput } from './grade/regrade.js';
export type { CurrentCase } from './grade/grade.js';
export type { GradeSet } from './grade/grade-set.js';
export type { Grade, GradeSetHeader } from './grade/record.js';
export {
  buildComparison,
  type ComparedRunRecords,
  type ComparisonConfig,
  type ComparisonInput,
} from './compare/comparison.js';

// Report writers.
export {
  rewriteReport,
  writeComparison,
  type ComparisonWriteOptions,
  type WrittenComparison,
} from './report/write.js';
export { renderReport, type ReviewSamplesAt } from './report/markdown.js';

// Records the tool writes and their zod schemas, the source of schemas/*.schema.json.
export { comparisonSchema, type Cell, type Comparison, type Gate } from './report/schema.js';
export {
  manifestSchema,
  swapRecordSchema,
  type Manifest,
  type RunStatus,
  type StopReason,
  type SwapRecord,
} from './run/manifest.js';
export { trialLineSchema, type TrialLine } from './run/records.js';
export { warningSchema, type Warning } from './run/warning.js';
