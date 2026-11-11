import type { Lang } from '../../config/schema.js';
import type { RecordedOption, ResumeRefusal } from '../../run/resume-check.js';
import type { ResumeFailure } from '../../run/resume-run.js';
import type { RunReadProblem } from '../../run/run-records.js';
import type { SwapResumeFailure } from '../../run/swap.js';
import { startFailureLines } from './swap.js';
import { quote, textOf, type Text } from './text.js';

// Why `run --resume` and `swap --resume` did not start (data-model §Resume and Locking), on
// stderr before any model call.

const OPTION_FLAGS: Readonly<Record<RecordedOption, string>> = {
  variant: '--variant',
  from: '--from',
  to: '--to',
  repeats: '--repeats',
  cases: '--cases',
};

function recordsLines(
  t: Text,
  missing: { readonly key: 'run' | 'swap'; readonly id: string; readonly path: string },
  problem: RunReadProblem,
): string[] {
  switch (problem.kind) {
    case 'missing':
      return [
        missing.key === 'run'
          ? t('human.resume.missingRun', { runId: missing.id, path: missing.path })
          : t('human.resume.missingSwap', { swapId: missing.id, path: missing.path }),
      ];
    case 'manifest':
      return [t('human.resume.unreadable', { file: problem.file, detail: problem.detail })];
    case 'trials':
      return [
        t('human.resume.brokenLine', {
          file: problem.file,
          line: problem.line,
          detail: quote(problem.detail),
        }),
      ];
  }
}

function refusalLines(t: Text, runId: string, refusal: ResumeRefusal): string[] {
  switch (refusal.kind) {
    case 'complete':
      return [t('human.resume.complete', { id: runId })];
    case 'in-swap':
      return [t('human.resume.inSwap', { runId, swapId: refusal.swapId })];
    case 'options':
      return [
        t('human.resume.options', {
          runId,
          options: refusal.options.map((option) => OPTION_FLAGS[option]).join(', '),
        }),
      ];
    case 'cases-missing':
      return [t('human.resume.casesMissing', { runId, cases: refusal.caseIds.join(', ') })];
    case 'conditions':
      return [
        t('human.resume.conditions', { runId, conditions: refusal.conditions.join(', ') }),
        ...(refusal.caseIds.length === 0
          ? []
          : [t('human.resume.changedCases', { cases: refusal.caseIds.join(', ') })]),
        ...(refusal.conditions.includes('service') ? [t('human.adapter.serviceChanged')] : []),
      ];
  }
}

/** `runsDir` is where the run was looked for. */
export function resumeFailureLines(
  lang: Lang,
  runsDir: string,
  runId: string,
  failure: ResumeFailure,
): string[] {
  const t = textOf(lang);
  switch (failure.kind) {
    case 'records':
      return recordsLines(t, { key: 'run', id: runId, path: runsDir }, failure.problem);
    case 'refused':
      return refusalLines(t, runId, failure.refusal);
    default:
      return startFailureLines(lang, runId, failure);
  }
}

/** `swapsDir` and `runsDir` are where the swap record and its runs were looked for. */
export function swapResumeFailureLines(
  lang: Lang,
  dirs: { readonly swapsDir: string; readonly runsDir: string },
  failure: SwapResumeFailure,
): string[] {
  const t = textOf(lang);
  switch (failure.kind) {
    case 'swap-record':
      return recordsLines(
        t,
        { key: 'swap', id: failure.swapId, path: dirs.swapsDir },
        failure.problem,
      );
    case 'swap-complete':
      return [t('human.resume.complete', { id: failure.swapId })];
    case 'run':
      return resumeFailureLines(lang, dirs.runsDir, failure.runId, failure.failure);
  }
}
