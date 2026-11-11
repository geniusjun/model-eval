import { afterAll } from 'vitest';

import type { CliResult } from './cli.js';
import {
  parseLintEnvelope,
  parseRunEnvelope,
  parseSwapEnvelope,
  type LintEnvelope,
  type RunEnvelope,
  type SwapEnvelope,
} from './outputs.js';
import { createProject, type Project, type ProjectSpec } from './project.js';

export const SWAP = ['swap', '--from', 'current', '--to', 'next'] as const;

/** Each e2e test may run several swaps; this bounds one test, not one CLI call. */
export const E2E = { timeout: 180_000 } as const;

export interface JsonOutcome<E> {
  readonly cli: CliResult;
  readonly envelope: E;
}

/** Runs a command with `--json` and reads the envelope it printed. */
async function withJson<E>(
  project: Project,
  args: readonly string[],
  parse: (stdout: string) => E,
): Promise<JsonOutcome<E>> {
  const cli = await project.run([...args, '--json']);
  try {
    return { cli, envelope: parse(cli.stdout) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${args.join(' ')} --json exited ${String(cli.code)} without a valid envelope: ${reason}\n` +
        `stderr:\n${cli.stderr}`,
      { cause: error },
    );
  }
}

export function swapJson(
  project: Project,
  extra: readonly string[] = [],
): Promise<JsonOutcome<SwapEnvelope>> {
  return withJson(project, [...SWAP, ...extra], parseSwapEnvelope);
}

export function runJson(
  project: Project,
  variant: string,
  extra: readonly string[] = [],
): Promise<JsonOutcome<RunEnvelope>> {
  return withJson(project, ['run', '--variant', variant, ...extra], parseRunEnvelope);
}

export function lintJson(
  project: Project,
  extra: readonly string[] = [],
): Promise<JsonOutcome<LintEnvelope>> {
  return withJson(project, ['lint', ...extra], parseLintEnvelope);
}

/** Projects made through the returned function are deleted after the file's tests. */
export function useProjects(): (spec: ProjectSpec) => Promise<Project> {
  const created: Project[] = [];
  afterAll(async () => {
    await Promise.all(created.map((project) => project.dispose()));
  });
  return async (spec) => {
    const project = await createProject(spec);
    created.push(project);
    return project;
  };
}
