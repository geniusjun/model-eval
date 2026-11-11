import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { derivedTracked } from '../../../src/lint/derived-tracked.js';
import { useWorkspace } from './subject.js';

const run = promisify(execFile);
const workspace = useWorkspace();

const RULES = `rules:
  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    check: { type: emoji }
`;

const SYNTHETIC = `cases:
  - id: greet-ko
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
`;

const DERIVED = `cases:
  - id: real-1
    target: chat
    lang: ko
    provenance: derived
    input: { user: hi }
  - id: made-up
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: hi }
  - id: real-2
    target: chat
    lang: ko
    provenance: derived
    input: { user: hi }
`;

const FILES = {
  'rules/rules.yaml': RULES,
  'cases/greet.yaml': SYNTHETIC,
  'cases/real.yaml': DERIVED,
};

/** Where the first derived case of `cases/real.yaml` starts, with the derived cases of the file. */
const REAL = { caseIds: ['real-1', 'real-2'], file: 'cases/real.yaml', line: 2, column: 5 };

async function git(...args: string[]): Promise<void> {
  await run('git', ['-C', workspace.root(), ...args]);
}

describe('provenance lint codes', () => {
  it('001 FR-003 derived-tracked (tracked) for a derived case file that git tracks, ignored or not', async () => {
    await workspace.write({ ...FILES, '.gitignore': 'cases/real.yaml\n' });
    await git('init', '-q');
    await git('add', '-f', 'cases/real.yaml', 'cases/greet.yaml');
    const subject = await workspace.subject(FILES);
    expect(await derivedTracked(subject)).toEqual([
      { code: 'derived-tracked', params: { cause: 'tracked' }, ...REAL },
    ]);
  });

  it('001 FR-003 derived-tracked (not-ignored) for an untracked derived case file that .gitignore does not cover', async () => {
    await workspace.write(FILES);
    await git('init', '-q');
    const subject = await workspace.subject(FILES);
    expect(await derivedTracked(subject)).toEqual([
      { code: 'derived-tracked', params: { cause: 'not-ignored' }, ...REAL },
    ]);
  });

  it('001 FR-003 no finding for a derived case file that git ignores and does not track', async () => {
    await workspace.write({ ...FILES, '.gitignore': 'cases/real.yaml\n' });
    await git('init', '-q');
    await git('add', 'cases/greet.yaml', '.gitignore');
    expect(await derivedTracked(await workspace.subject(FILES))).toEqual([]);
  });

  it('001 FR-003 vcs-unknown for a derived case file outside a git work tree', async () => {
    const subject = await workspace.subject(FILES);
    expect(await derivedTracked(subject)).toEqual([{ code: 'vcs-unknown', ...REAL }]);
  });

  it('001 FR-003 vcs-unknown is reported once, naming the derived cases of every file', async () => {
    const subject = await workspace.subject({
      ...FILES,
      'cases/more.yaml': `cases:
  - id: real-3
    target: chat
    lang: ko
    provenance: derived
    input: { user: hi }
`,
    });
    expect(await derivedTracked(subject)).toEqual([
      {
        code: 'vcs-unknown',
        caseIds: ['real-3', 'real-1', 'real-2'],
        file: 'cases/more.yaml',
        line: 2,
        column: 5,
      },
    ]);
  });

  it('001 FR-003 a file name with glob characters is matched literally', async () => {
    const files = {
      'rules/rules.yaml': RULES,
      'cases/real1.yaml': SYNTHETIC,
      'cases/real[1].yaml': DERIVED,
    };
    await workspace.write(files);
    await git('init', '-q');
    await git('add', 'cases/real1.yaml');
    expect(await derivedTracked(await workspace.subject(files))).toEqual([
      {
        code: 'derived-tracked',
        params: { cause: 'not-ignored' },
        ...REAL,
        file: 'cases/real[1].yaml',
      },
    ]);
  });

  it('001 FR-003 synthetic cases need no git work tree', async () => {
    const subject = await workspace.subject({
      'rules/rules.yaml': RULES,
      'cases/greet.yaml': SYNTHETIC,
    });
    expect(await derivedTracked(subject)).toEqual([]);
  });
});
