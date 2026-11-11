import type { GradingCheck } from '../config/schema.js';

export type CheckOfType<T extends GradingCheck['type']> = Extract<GradingCheck, { type: T }>;

/** Why a check could not run on a text; the grade is then `error` and leaves the denominator. */
export type CheckProblem =
  | { readonly code: 'unresolved-ref'; readonly path: string }
  | { readonly code: 'not-text'; readonly path: string }
  | { readonly code: 'unknown-script'; readonly script: string }
  | { readonly code: 'invalid-schema'; readonly detail: string };

export type CheckResult =
  | { readonly outcome: 'pass' }
  | { readonly outcome: 'fail'; readonly evidence: readonly string[] }
  | { readonly outcome: 'error'; readonly problem: CheckProblem };

export type CheckError = Extract<CheckResult, { outcome: 'error' }>;

export const PASS: CheckResult = { outcome: 'pass' };

/** Evidence lists each violating string once, in order of first appearance. */
export function fail(evidence: Iterable<string>): CheckResult {
  return { outcome: 'fail', evidence: [...new Set(evidence)] };
}

export function checkError(problem: CheckProblem): CheckError {
  return { outcome: 'error', problem };
}
