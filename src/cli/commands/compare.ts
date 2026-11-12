import { buildComparison } from '../../compare/comparison.js';
import { gateExit } from '../../compare/gate.js';
import { writeComparison } from '../../report/write.js';
import type { ExitName } from '../exit-codes.js';
import { compareLines, shownComparison } from '../human/compare.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import {
  currentCasesOf,
  gradeWithCurrentRules,
  positionalIds,
  readSavedRun,
  setUpSaved,
} from './saved.js';
import { pageTemplateOf, warnWithoutPage } from './run-setup.js';

// `model-eval compare <baseRunId> <candRunId>`: grades both runs with the current rules,
// compares, gates and writes the outputs, without calling a model (FR-019, FR-025).

async function compare(invocation: CommandInvocation): Promise<ExitName> {
  const ids = positionalIds(invocation, 'compare', ['baseRunId', 'candRunId']);
  if (!ids.ok) {
    return ids.exit;
  }
  const setup = await setUpSaved(invocation, 'compare');
  if (!setup.ok) {
    return setup.exit;
  }
  const { project, lang } = setup.value;
  const [baselineId = '', candidateId = ''] = ids.value;
  const baseline = await readSavedRun(invocation, 'compare', setup.value, baselineId);
  if (!baseline.ok) {
    return baseline.exit;
  }
  const candidate = await readSavedRun(invocation, 'compare', setup.value, candidateId);
  if (!candidate.ok) {
    return candidate.exit;
  }
  const runs = { baseline: baseline.value, candidate: candidate.value };
  const current = {
    baseline: currentCasesOf(setup.value, runs.baseline),
    candidate: currentCasesOf(setup.value, runs.candidate),
  };
  const [baselineGrades, candidateGrades] = await Promise.all([
    gradeWithCurrentRules(setup.value, runs.baseline, current.baseline),
    gradeWithCurrentRules(setup.value, runs.candidate, current.candidate),
  ]);
  const { outputDir } = project.paths;
  const comparison = await buildComparison({
    runs: {
      baseline: { ...runs.baseline, gradeSet: baselineGrades.gradeSet },
      candidate: { ...runs.candidate, gradeSet: candidateGrades.gradeSet },
    },
    rules: project.ruleFiles.flatMap((file) => file.data.rules),
    // A case whose two runs recorded different language keys is compared under the baseline's
    // key, so the candidate's trials of it leave the comparison as changed.
    cases: [...new Map([...current.candidate, ...current.baseline]).values()],
    config: project.config.data,
    outputDir,
    now: () => new Date(),
  });
  const written = await writeComparison({
    outputDir,
    comparison,
    lang,
    ...pageTemplateOf(invocation),
  });
  const exit = gateExit(comparison.gate.outcome);
  const { warnings } = comparison;
  // The comparison and its warnings are redacted already (FR-031); writing them as they are
  // keeps text a replacement matches again from being redacted twice.
  invocation.output.envelope('compare', exit, { comparison, gate: comparison.gate }, [], {
    result: true,
    warnings,
  });
  const lines = compareLines(lang, {
    comparison,
    warnings,
    written: shownComparison(written, invocation.context.cwd),
  });
  for (const line of lines) {
    if (line.redacted) {
      invocation.output.printRedacted(line.text);
    } else {
      invocation.output.print(line.text);
    }
  }
  warnWithoutPage(invocation, lang, written);
  return exit;
}

export const compareCommand: CommandHandler = {
  options: {},
  run: compare,
};
