import { execFile } from 'node:child_process';
import path from 'node:path';

import type { LintFinding } from '../config/diagnostics.js';
import type { LintCase, LintSubject } from './subject.js';

// FR-003, constitution V: cases made from real data stay out of version control. A derived
// case file must be neither tracked nor left unignored in a git work tree.

type GitStatus = 'tracked' | 'not-ignored' | 'ignored' | 'unknown';

/** Exit code and stdout of `git -C <dir> <args>`; the code is `null` when git did not run. */
function git(dir: string, args: readonly string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const command = ['-C', dir, ...args];
    execFile('git', command, { encoding: 'utf8' }, (error, stdout) => {
      if (error === null) {
        resolve({ code: 0, out: stdout });
        return;
      }
      resolve({ code: typeof error.code === 'number' ? error.code : null, out: stdout });
    });
  });
}

/** `ls-files` before `check-ignore`: an ignored file that is tracked anyway is still tracked. */
async function gitStatusOf(file: string): Promise<GitStatus> {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.out.trim() !== 'true') {
    return 'unknown';
  }
  // `ls-files` reads pathspecs, so `[` or `*` in a file name would match other files; literal
  // pathspecs name this file only. `check-ignore` takes plain paths and refuses that option.
  const tracked = await git(dir, [
    '--literal-pathspecs',
    'ls-files',
    '--error-unmatch',
    '--',
    name,
  ]);
  if (tracked.code === 0) {
    return 'tracked';
  }
  const ignored = await git(dir, ['check-ignore', '--quiet', '--', name]);
  switch (ignored.code) {
    case 0:
      return 'ignored';
    case 1:
      return 'not-ignored';
    default:
      return 'unknown';
  }
}

/** Derived cases grouped by case file, files in load order. */
function derivedByFile(cases: readonly LintCase[]): Map<string, LintCase[]> {
  const byFile = new Map<string, LintCase[]>();
  for (const lintCase of cases) {
    if (lintCase.definition.provenance === 'derived') {
      byFile.set(lintCase.sourcePath, [...(byFile.get(lintCase.sourcePath) ?? []), lintCase]);
    }
  }
  return byFile;
}

/**
 * One `derived-tracked` per case file with derived cases, at its first derived case, with its
 * cause. Files outside a git work tree (or without git) give one `vcs-unknown` for the whole
 * lint, naming their derived cases, at the first of them.
 */
export async function derivedTracked(subject: LintSubject): Promise<LintFinding[]> {
  const files = [...derivedByFile(subject.cases)];
  const statuses = await Promise.all(files.map(([file]) => gitStatusOf(file)));
  const unknown = files.filter((_file, index) => statuses[index] === 'unknown');
  const tracked = files.flatMap(([, cases], index): LintFinding[] => {
    const [first] = cases;
    const status = statuses[index];
    if (first === undefined || (status !== 'tracked' && status !== 'not-ignored')) {
      return [];
    }
    const caseIds = cases.map(({ definition }) => definition.id);
    return [{ code: 'derived-tracked', params: { cause: status }, caseIds, ...first.at() }];
  });
  const unknownCases = unknown.flatMap(([, cases]) => cases);
  const [firstUnknown] = unknownCases;
  return firstUnknown === undefined
    ? tracked
    : [
        ...tracked,
        {
          code: 'vcs-unknown',
          caseIds: unknownCases.map(({ definition }) => definition.id),
          ...firstUnknown.at(),
        },
      ];
}
