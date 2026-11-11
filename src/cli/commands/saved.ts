import path from 'node:path';

import { loadProject, type Project } from '../../config/load.js';
import type { Lang } from '../../config/schema.js';
import { currentCases, regradeRun } from '../../grade/regrade.js';
import type { CurrentCase } from '../../grade/grade.js';
import type { GradeSet } from '../../grade/grade-set.js';
import { message, selectLang, type MessageKey, type MessageParams } from '../../messages/index.js';
import { createRedactor } from '../../report/redact.js';
import { runIdSchema } from '../../run/manifest.js';
import { readRunRecords, type RunRecords } from '../../run/run-records.js';
import { runDirectoryPath } from '../../run/writer.js';
import type { ExitName } from '../exit-codes.js';
import { diagnosticLines } from '../human/swap.js';
import type { CommandInvocation } from '../main.js';
import type { Command } from '../results.js';
import { refuse } from './run-setup.js';

// What `grade`, `compare` and `report` share: their ID arguments and refusals, and for the first
// two the current project, the saved runs they name and grading them with the current rules, all
// without starting the adapter.

export type SavedCommand = Extract<Command, 'grade' | 'compare' | 'report'>;

export interface SavedSetup {
  readonly project: Project;
  /** `--lang`, else the config `lang`. */
  readonly lang: Lang;
  /** The tool version, the `checkerVersion` of grade sets. */
  readonly checkerVersion: string;
}

export type Step<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly exit: ExitName };

/** A refusal in the command's language, or in English before the config is read. */
export function refuseWith(
  invocation: CommandInvocation,
  command: SavedCommand,
  lang: Lang,
  key: MessageKey,
  params: MessageParams,
): { readonly ok: false; readonly exit: ExitName } {
  return { ok: false, exit: refuse(invocation, command, [message(lang, key, params)]) };
}

/**
 * Exactly the positional arguments named, for example `<baseRunId> <candRunId>`; one missing or
 * one too many ends the command.
 */
export function positionalIds(
  invocation: CommandInvocation,
  command: SavedCommand,
  names: readonly string[],
): Step<readonly string[]> {
  const lang = invocation.common.lang ?? 'en';
  const { positionals } = invocation;
  const params = { command, arguments: names.map((name) => `<${name}>`).join(' ') };
  if (positionals.length < names.length) {
    return refuseWith(invocation, command, lang, 'cli.missingArguments', params);
  }
  if (positionals.length > names.length) {
    const extra = positionals.slice(names.length).join(' ');
    return refuseWith(invocation, command, lang, 'cli.extraArguments', { ...params, extra });
  }
  return { ok: true, value: positionals };
}

/**
 * Loads the config with its rule and case files and switches the output to their `redact` rules
 * (FR-031); unreadable files end the command with exit 4.
 */
export async function setUpSaved(
  invocation: CommandInvocation,
  command: Extract<SavedCommand, 'grade' | 'compare'>,
): Promise<Step<SavedSetup>> {
  const { common, context, output } = invocation;
  const loaded = await loadProject(common.config, context.cwd, common.lang ?? 'en');
  if (!loaded.ok) {
    const lines = diagnosticLines(common.lang ?? 'en', loaded.diagnostics);
    return { ok: false, exit: refuse(invocation, command, lines) };
  }
  const { project } = loaded;
  const config = project.config.data;
  output.setRedactor(createRedactor(config.redact));
  return {
    ok: true,
    value: {
      project,
      lang: selectLang(common.lang, config.lang),
      checkerVersion: context.version,
    },
  };
}

/**
 * The records of the run an ID names under `output.dir`, or the refusal (exit 4) of a malformed
 * ID, a missing run, an unreadable manifest or a broken trial line.
 */
export async function readSavedRun(
  invocation: CommandInvocation,
  command: Extract<SavedCommand, 'grade' | 'compare'>,
  setup: SavedSetup,
  runId: string,
): Promise<Step<RunRecords>> {
  const refused = (key: MessageKey, params: MessageParams) =>
    refuseWith(invocation, command, setup.lang, key, params);
  if (!runIdSchema.safeParse(runId).success) {
    return refused('cli.invalidRunId', { value: runId });
  }
  const shown = (file: string) => path.relative(invocation.context.cwd, file) || file;
  const { outputDir } = setup.project.paths;
  const read = await readRunRecords(runDirectoryPath(outputDir, runId));
  if (read.ok) {
    return { ok: true, value: read.run };
  }
  const { problem } = read;
  switch (problem.kind) {
    case 'missing':
      return refused('cli.unknownRun', { runId, dir: shown(path.join(outputDir, 'runs')) });
    case 'manifest':
      return refused('cli.unreadableFile', { file: shown(problem.file), detail: problem.detail });
    case 'trials':
      return refused('cli.brokenTrialLine', {
        file: shown(problem.file),
        line: problem.line,
        detail: problem.detail,
      });
  }
}

/** The current case files' version of the cases this run recorded. */
export function currentCasesOf(setup: SavedSetup, run: RunRecords): Map<string, CurrentCase> {
  return currentCases(
    setup.project.caseFiles.flatMap((file) => file.data.cases),
    run.manifest,
  );
}

/** The run's grade set under the current rules and its own current cases. */
export function gradeWithCurrentRules(
  setup: SavedSetup,
  run: RunRecords,
  current: ReadonlyMap<string, CurrentCase>,
): Promise<{ gradeSet: GradeSet; reused: boolean }> {
  return regradeRun({
    run,
    rules: setup.project.ruleFiles.flatMap((file) => file.data.rules),
    current,
    checkerVersion: setup.checkerVersion,
  });
}
