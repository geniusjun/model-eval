// The library API; the CLI is a layer on top of it (plan §Project Structure).

export { loadProject, type LoadResult, type Project } from './config/load.js';
export { executeRun, type RunRequest, type RunResult } from './run/runner.js';
export { executeSwap, type SwapRequest, type SwapResult } from './run/swap.js';
export { buildComparison, type ComparisonInput } from './compare/comparison.js';
export { writeComparison } from './report/write.js';
export { samplePlan, type SamplePlan } from './lint/sample-plan.js';
export type { Cell, Comparison, Gate } from './report/schema.js';
export type { Warning } from './run/warning.js';
