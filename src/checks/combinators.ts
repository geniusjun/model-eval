import type { GradingCheck } from '../config/schema.js';
import { fail, PASS, type CheckError, type CheckOfType, type CheckResult } from './result.js';

/** Runs a child check on the same text and case values. */
export type EvaluateChild = (check: GradingCheck) => CheckResult;

// A child that cannot run makes the parent unable to run, whatever the other children give:
// such problems come from the definition or the case, and letting a sibling's result hide them
// would make the error appear on some texts and not on others.

/** Fails when a child fails; the evidence is that of every failing child. */
export function checkAll(check: CheckOfType<'all'>, evaluate: EvaluateChild): CheckResult {
  const results = check.checks.map(evaluate);
  const problem = results.find(isError);
  if (problem !== undefined) {
    return problem;
  }
  const failures = results.filter(isFailure);
  return failures.length === 0 ? PASS : fail(failures.flatMap(({ evidence }) => evidence));
}

/** Passes when a child passes; otherwise fails with the evidence of every child. */
export function checkAny(check: CheckOfType<'any'>, evaluate: EvaluateChild): CheckResult {
  const results = check.checks.map(evaluate);
  const problem = results.find(isError);
  if (problem !== undefined) {
    return problem;
  }
  const failures = results.filter(isFailure);
  return failures.length < results.length
    ? PASS
    : fail(failures.flatMap(({ evidence }) => evidence));
}

/** Passes when the child fails and fails, without evidence, when it passes. */
export function checkNot(check: CheckOfType<'not'>, evaluate: EvaluateChild): CheckResult {
  const result = evaluate(check.check);
  switch (result.outcome) {
    case 'error':
      return result;
    case 'fail':
      return PASS;
    case 'pass':
      return fail([]);
  }
}

function isError(result: CheckResult): result is CheckError {
  return result.outcome === 'error';
}

function isFailure(result: CheckResult): result is Extract<CheckResult, { outcome: 'fail' }> {
  return result.outcome === 'fail';
}
