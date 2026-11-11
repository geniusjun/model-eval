import type { LintFinding } from '../config/diagnostics.js';
import { applicableToTargets, gateRules } from '../compare/gate.js';
import { samplePlan } from './sample-plan.js';
import { knownLanguageCases, rulesById, type LintSubject } from './subject.js';

// FR-006: what the gate config and the planned sample let a comparison decide, before any run.

function activeRules(subject: LintSubject) {
  return subject.rules.filter(({ rule }) => rule.status === 'active');
}

/**
 * With a gate, rejections, time-outs and discards block only through a `completed` rule of a
 * gated severity.
 */
export function completedNotGated(subject: LintSubject): LintFinding[] {
  const { gate } = subject.project.config.data;
  if (gate.severities.length === 0) {
    return [];
  }
  const completed = activeRules(subject).filter(({ rule }) => rule.check.type === 'completed');
  if (completed.length === 0) {
    return [
      {
        code: 'completed-not-gated',
        params: { cause: 'no-rule' },
        ...subject.configAt(['gate', 'severities']),
      },
    ];
  }
  if (completed.some(({ rule }) => gate.severities.includes(rule.severity))) {
    return [];
  }
  return completed.map(({ rule, at }) => ({
    code: 'completed-not-gated',
    params: { cause: 'not-gated' },
    ruleId: rule.id,
    ...at(),
  }));
}

/** Rules of a gated severity that the gate leaves out, as the comparison will (data-model §Gate). */
export function excludedFromGate(subject: LintSubject): LintFinding[] {
  const config = subject.project.config.data;
  const targets = [...new Set(subject.cases.map(({ definition }) => definition.target))];
  const rules = applicableToTargets(
    subject.rules.map(({ rule }) => rule),
    targets,
  );
  const byId = rulesById(subject);
  return gateRules(rules, config.gate).excluded.map(({ ruleId, cause }) => ({
    code: 'excluded-from-gate',
    ruleId,
    params: { cause },
    ...byId.get(ruleId)?.at(),
  }));
}

/**
 * `few-cases` and `margin-unreachable` of the cases whose language is known, at
 * `sampling.repeats`, at their rule.
 */
export function samplePlanFindings(subject: LintSubject): LintFinding[] {
  const config = subject.project.config.data;
  const plan = samplePlan({
    rules: subject.rules.map(({ rule }) => rule),
    cases: knownLanguageCases(subject.cases).map(({ definition, lang }) => ({ definition, lang })),
    repeats: config.sampling.repeats,
    gate: config.gate,
    stats: config.stats,
  });
  const byId = rulesById(subject);
  return plan.warnings.map((finding) => ({
    ...finding,
    ...(finding.ruleId === undefined ? {} : byId.get(finding.ruleId)?.at()),
  }));
}
