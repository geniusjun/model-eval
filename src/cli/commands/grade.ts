import type { ExitName } from '../exit-codes.js';
import { gradeLines } from '../human/compare.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import { printAll } from './run-setup.js';
import {
  currentCasesOf,
  gradeWithCurrentRules,
  positionalIds,
  readSavedRun,
  setUpSaved,
} from './saved.js';

// `model-eval grade <runId>`: re-grades stored trials with the current rules (FR-019).

async function grade(invocation: CommandInvocation): Promise<ExitName> {
  const ids = positionalIds(invocation, 'grade', ['runId']);
  if (!ids.ok) {
    return ids.exit;
  }
  const setup = await setUpSaved(invocation, 'grade');
  if (!setup.ok) {
    return setup.exit;
  }
  const [runId = ''] = ids.value;
  const run = await readSavedRun(invocation, 'grade', setup.value, runId);
  if (!run.ok) {
    return run.exit;
  }
  const current = currentCasesOf(setup.value, run.value);
  const { gradeSet, reused } = await gradeWithCurrentRules(setup.value, run.value, current);
  invocation.output.envelope(
    'grade',
    'ok',
    { runId: run.value.manifest.runId, gradeSetId: gradeSet.header.gradeSetId, reused },
    [],
  );
  printAll(
    invocation,
    gradeLines(setup.value.lang, { manifest: run.value.manifest, gradeSet, reused }),
  );
  return 'ok';
}

export const gradeCommand: CommandHandler = {
  options: {},
  run: grade,
};
