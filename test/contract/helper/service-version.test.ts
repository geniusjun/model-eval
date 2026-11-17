import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, describe, expect, it } from 'vitest';

import {
  commit,
  type Files,
  fileEntries,
  git,
  gitMayFail,
  type Reported,
  reportVersion,
  repository,
  treeHash,
  treeHashOf,
  write,
} from './support/repositories.js';
import { TIMEOUT_MS } from './support/service-runs.js';

// `initialize`'s `service` from the TypeScript helper: `version`, `dirty` and `treeHash` of
// `serviceDir`, each test in a temporary git repository (data-model §Service Version;
// helper-scenarios S-RV-04 to S-RV-07 and S-RV-09 to S-RV-19). The helper reads inode numbers as
// `bigint` and orders paths by their bytes (`Buffer.compare`), so names whose UTF-8 and UTF-16
// orders differ hash as in Python.

const L1_GIT = /^Service version not reported: git [a-z-]+: fatal: .+\.$/;
const SERVICE_FILES: Files = {
  'app.py': "print('service')\n",
  'data/store.bin': Buffer.from([0x00, 0x01, 0xff, ...Buffer.from(' binary\n')]),
};

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function temporary(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'service-version-'));
  folders.push(folder);
  return folder;
}

function report(
  serviceDir: string | undefined,
  options: { toolPaths?: readonly string[]; cwd?: string; env?: Record<string, string> } = {},
): Promise<Reported> {
  return reportVersion({
    language: 'typescript',
    ...(serviceDir === undefined ? {} : { serviceDir }),
    ...options,
  });
}

/** The version, asserting that all three values were reported without a warning. */
async function full(serviceDir: string, toolPaths: readonly string[] = []): Promise<Reported> {
  const reported = await report(serviceDir, { toolPaths });
  expect(Object.keys(reported.service).sort()).toEqual(['dirty', 'treeHash', 'version']);
  expect(reported.warnings).toEqual([]);
  return reported;
}

async function fullHash(serviceDir: string, toolPaths: readonly string[] = []): Promise<unknown> {
  return (await full(serviceDir, toolPaths)).service.treeHash;
}

/** A PATH that holds only `folder`, with a `git` there running `script` when given. */
function gitOnPath(folder: string, script: string | undefined): Record<string, string> {
  mkdirSync(folder);
  if (script !== undefined) {
    const command = path.join(folder, 'git');
    writeFileSync(command, script);
    // An empty script gets mode 0o644, so starting it fails with EACCES.
    chmodSync(command, script === '' ? 0o644 : 0o755);
  }
  return { PATH: folder };
}

function which(name: string): string {
  return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
}

describe('003 service version of the TypeScript helper (data-model §Service Version)', () => {
  it(
    '003 FR-003 reports the full SHA, dirty and a tree hash of the files',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      symlinkSync('app.py', path.join(service, 'link'));
      commit(service);
      const reported = await full(service);
      expect(reported.service.version).toBe(git(service, 'rev-parse', 'HEAD'));
      expect(reported.service.version).toMatch(/^[0-9a-f]{40}$/);
      expect(reported.service.dirty).toBe(false);
      expect(reported.service.treeHash).toBe(
        treeHash([
          ...fileEntries(SERVICE_FILES),
          [Buffer.from('link'), 'l', Buffer.from('app.py')],
        ]),
      );
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 reports the 64-character SHA of a SHA-256 repository',
    async () => {
      const service = repository(
        path.join(temporary(), 'service'),
        SERVICE_FILES,
        '--object-format=sha256',
      );
      const reported = await full(service);
      expect(reported.service.version).toMatch(/^[0-9a-f]{64}$/);
      expect(reported.service.version).toBe(git(service, 'rev-parse', 'HEAD'));
      expect(reported.service.treeHash).toBe(treeHashOf(SERVICE_FILES));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 dirty after an edit or an untracked file',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      write(service, { 'app.py': "print('edited')\n" });
      expect((await full(service)).service.dirty).toBe(true);
      git(service, 'checkout', '--', 'app.py');
      write(service, { 'notes.txt': 'untracked\n' });
      const reported = await full(service);
      expect(reported.service.dirty).toBe(true);
      expect(reported.service.treeHash).toBe(
        treeHashOf({ ...SERVICE_FILES, 'notes.txt': 'untracked\n' }),
      );
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 a relative serviceDir resolves from the adapter folder',
    async () => {
      const root = temporary();
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      const adapterFolder = path.join(root, 'eval');
      mkdirSync(adapterFolder);
      const relative = await report('../service', { cwd: adapterFolder });
      expect(relative.service).toEqual((await full(service)).service);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 reports none without serviceDir',
    async () => {
      const reported = await report(undefined);
      expect(reported.service).toEqual({});
      expect(reported.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-04 tool files and commits leave the tree hash unchanged',
    async () => {
      const service = repository(path.join(temporary(), 'service'), {
        ...SERVICE_FILES,
        'eval/rules/base.yaml': 'a\n',
      });
      const rule = path.join(service, 'eval/rules/base.yaml');
      const config = path.join(service, 'eval/model-eval.config.yaml');
      const output = path.join(service, 'eval/.model-eval');
      const toolPaths = [config, rule, output];
      const before = (await full(service, toolPaths)).service;
      expect(before.treeHash).toBe(treeHashOf(SERVICE_FILES));

      write(service, { 'eval/rules/base.yaml': 'b\n', 'eval/model-eval.config.yaml': 'c\n' });
      mkdirSync(output);
      write(service, { 'eval/.model-eval/run.jsonl': '{}\n' });
      const edited = (await full(service, toolPaths)).service;
      expect(edited.treeHash).toBe(before.treeHash);
      expect(edited.dirty).toBe(false);

      commit(service, 'rule edit');
      expect(await fullHash(service, toolPaths)).toBe(before.treeHash);

      write(service, { 'app.py': "print('edited')\n" });
      const changed = await fullHash(service, toolPaths);
      git(service, 'add', 'app.py');
      expect(await fullHash(service, toolPaths)).toBe(changed);
      commit(service, 'service edit');
      expect(await fullHash(service, toolPaths)).toBe(changed);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-05 content changes change the tree hash',
    async () => {
      const service = repository(path.join(temporary(), 'service'), {
        ...SERVICE_FILES,
        '.gitignore': '*.log\n',
      });
      const hashes = [await fullHash(service)];
      write(service, { 'data/store.bin': Buffer.from([0x00, 0x02, 0xff, 0x0a]) });
      hashes.push(await fullHash(service));
      write(service, { 'extra.py': 'x = 1\n' });
      hashes.push(await fullHash(service));
      expect(new Set(hashes).size).toBe(3);

      write(service, { 'debug.log': 'ignored\n' });
      expect(await fullHash(service)).toBe(hashes.at(-1));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-05 nested repositories count by content',
    async () => {
      const root = temporary();
      const origin = repository(path.join(root, 'origin'), { 'lib.py': 'VALUE = 1\n' });
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      git(service, 'submodule', 'add', '-q', origin, 'sub');
      commit(service, 'add submodule');
      const nested = repository(path.join(service, 'nested'), { 'notes.md': 'nested\n' });
      const first = await fullHash(service);

      write(path.join(service, 'sub'), { 'lib.py': 'VALUE = 2\n' });
      const inSubmodule = await fullHash(service);
      expect(inSubmodule).not.toBe(first);

      write(nested, { 'notes.md': 'edited\n' });
      expect([first, inSubmodule]).not.toContain(await fullHash(service));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 nested repository content is its tree hash',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      const nestedFiles = { 'notes.md': 'nested\n' };
      repository(path.join(service, 'nested'), nestedFiles);
      const expected = treeHash([
        ...fileEntries(SERVICE_FILES),
        [Buffer.from('nested'), 's', Buffer.from(treeHashOf(nestedFiles))],
      ]);
      expect(await fullHash(service)).toBe(expected);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-06 S-RV-10 uninitialised submodules',
    async () => {
      const root = temporary();
      const origin = repository(path.join(root, 'origin'), { 'lib.py': 'VALUE = 1\n' });
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      git(service, 'submodule', 'add', '-q', origin, 'sub');
      commit(service, 'add submodule');
      git(service, 'submodule', 'deinit', '-q', '-f', 'sub');

      // The computation ends. The empty folder is not a repository top, so it is excluded.
      const gitmodules = readFileSync(path.join(service, '.gitmodules'));
      expect(await fullHash(service)).toBe(
        treeHashOf({ ...SERVICE_FILES, '.gitmodules': gitmodules }),
      );

      // serviceDir at the place of an uninitialised submodule: none of the three.
      const atSubmodule = await report(path.join(service, 'sub'));
      expect(atSubmodule.service).toEqual({});
      expect(atSubmodule.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-07 replaced files do not fail',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      symlinkSync('app.py', path.join(service, 'link'));
      commit(service);
      unlinkSync(path.join(service, 'app.py'));
      write(service, { 'app.py/inner.py': 'inner\n' });
      unlinkSync(path.join(service, 'link'));
      write(service, { link: 'now a file\n' });

      const reported = await full(service);
      expect(reported.service.dirty).toBe(true);
      // app.py is a folder that is not a repository top: excluded, with the files placed in it.
      const store = SERVICE_FILES['data/store.bin'] ?? '';
      expect(reported.service.treeHash).toBe(
        treeHashOf({ 'data/store.bin': store, link: 'now a file\n' }),
      );
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-07 a merge conflict does not fail',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      git(service, 'checkout', '-q', '-b', 'other');
      write(service, { 'app.py': 'other\n' });
      commit(service, 'other');
      git(service, 'checkout', '-q', 'main');
      write(service, { 'app.py': 'main\n' });
      commit(service, 'main');
      gitMayFail(service, 'merge', '-q', 'other');
      expect(git(service, 'diff', '--name-only', '--diff-filter=U')).toBe('app.py');

      const reported = await full(service);
      expect(reported.service.dirty).toBe(true);
      // The conflict's stage entries list app.py three times; it is kept once.
      const conflicted = { ...SERVICE_FILES, 'app.py': readFileSync(path.join(service, 'app.py')) };
      expect(reported.service.treeHash).toBe(treeHashOf(conflicted));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-09 tool files reached through a symbolic link',
    async () => {
      const root = temporary();
      const real = path.join(root, 'real');
      const service = repository(path.join(real, 'service'), {
        ...SERVICE_FILES,
        'eval/rules/base.yaml': 'a\n',
      });
      const alias = path.join(root, 'alias');
      symlinkSync(real, alias);
      const ruleThroughAlias = path.join(alias, 'service/eval/rules/base.yaml');
      const expected = treeHashOf(SERVICE_FILES);

      expect(
        await fullHash(path.join(alias, 'service'), [path.join(service, 'eval/rules/base.yaml')]),
      ).toBe(expected);
      expect(await fullHash(service, [ruleThroughAlias])).toBe(expected);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-09 a tool path written with different case',
    async () => {
      const files = { ...SERVICE_FILES, 'eval/config.yaml': 'a\n' };
      const service = repository(path.join(temporary(), 'service'), files);
      const written = path.join(service, 'EVAL/CONFIG.YAML');
      // On a case-sensitive file system the path names no file, so nothing is left out.
      const expected = existsSync(written) ? treeHashOf(SERVICE_FILES) : treeHashOf(files);
      expect(await fullHash(service, [written])).toBe(expected);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-10 reports none outside a work tree or when ignored',
    async () => {
      const root = temporary();
      const plain = path.join(root, 'plain');
      write(plain, SERVICE_FILES);
      const repo = repository(path.join(root, 'repo'), {
        '.gitignore': 'ignored/\n',
        ...SERVICE_FILES,
      });
      write(repo, { 'ignored/app.py': 'ignored\n' });
      for (const serviceDir of [plain, path.join(repo, 'ignored')]) {
        const reported = await report(serviceDir);
        expect(reported.service, serviceDir).toEqual({});
        expect(reported.warnings).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-11 GIT_DIR in the environment changes nothing',
    async () => {
      const root = temporary();
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      const other = repository(path.join(root, 'other'), { 'other.py': 'other\n' });
      const expected = (await full(service)).service;
      const hookEnv = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other };
      const reported = await report(service, { env: hookEnv });
      expect(reported.service).toEqual(expected);
      expect(reported.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-12 untracked files count with status.showUntrackedFiles=no',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      git(service, 'config', 'status.showUntrackedFiles', 'no');
      write(service, { 'new.py': 'new\n' });
      expect((await full(service)).service.dirty).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-13 file names are bytes sorted by bytes',
    async () => {
      // U+1F600 sorts before U+FF01 by UTF-16 code units and after it by UTF-8 bytes.
      const named = { '\u{1F600}.txt': 'grin\n', '！.txt': 'bang\n', 'a.txt': 'a\n' };
      const service = repository(path.join(temporary(), 'service'), named);
      const entries = fileEntries(named);
      if (process.platform === 'linux') {
        // macOS file systems refuse names that are not UTF-8.
        const rawName = Buffer.from([0xff, 0xfe, ...Buffer.from('.bin')]);
        writeFileSync(Buffer.concat([Buffer.from(`${service}/`), rawName]), 'raw\n');
        commit(service);
        entries.push([rawName, 'f', Buffer.from('raw\n')]);
      }
      expect(await fullHash(service)).toBe(treeHash(entries));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-14 a tool path not created yet',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      expect(await fullHash(service, [path.join(service, 'eval/.model-eval')])).toBe(
        treeHashOf(SERVICE_FILES),
      );
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-15 a deleted file is left out',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      unlinkSync(path.join(service, 'app.py'));
      const reported = await full(service);
      expect(reported.service.dirty).toBe(true);
      const store = SERVICE_FILES['data/store.bin'] ?? '';
      expect(reported.service.treeHash).toBe(treeHashOf({ 'data/store.bin': store }));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-16 changes outside a monorepo service folder',
    async () => {
      const repo = repository(path.join(temporary(), 'repo'), {
        'svc/app.py': 'service\n',
        'web/page.ts': 'page\n',
      });
      const before = (await full(path.join(repo, 'svc'))).service;
      expect(before.treeHash).toBe(treeHashOf({ 'app.py': 'service\n' }));
      write(repo, { 'web/page.ts': 'edited\n', 'web/new.ts': 'new\n' });
      const after = (await full(path.join(repo, 'svc'))).service;
      expect(after).toEqual(before);
      expect(after.dirty).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-17 the target of a linked case file is left out',
    async () => {
      const root = temporary();
      const service = repository(path.join(root, 'service'), {
        ...SERVICE_FILES,
        'fixtures/case.yaml': 'a\n',
      });
      const caseLink = path.join(root, 'eval/cases/case.yaml');
      mkdirSync(path.dirname(caseLink), { recursive: true });
      symlinkSync(path.join(service, 'fixtures/case.yaml'), caseLink);
      const before = (await full(service, [caseLink])).service;
      expect(before.treeHash).toBe(treeHashOf(SERVICE_FILES));
      write(service, { 'fixtures/case.yaml': 'b\n' });
      const after = (await full(service, [caseLink])).service;
      expect(after.treeHash).toBe(before.treeHash);
      expect(after.dirty).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 an unreadable file reports none with L1',
    async () => {
      const service = repository(path.join(temporary(), 'service'), {
        ...SERVICE_FILES,
        'secret.txt': 'secret\n',
      });
      const secret = path.join(service, 'secret.txt');
      chmodSync(secret, 0);
      let reported: Reported;
      try {
        reported = await report(service);
      } finally {
        chmodSync(secret, 0o644);
      }
      expect(reported.service).toEqual({});
      expect(reported.warnings).toEqual(['Service version not reported: read secret.txt: EACCES.']);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 a failing git command reports none with L1',
    async () => {
      const service = repository(path.join(temporary(), 'service'), SERVICE_FILES);
      writeFileSync(path.join(service, '.git/index'), 'not an index');
      const reported = await report(service);
      expect(reported.service).toEqual({});
      expect(reported.warnings).toHaveLength(1);
      expect(reported.warnings[0]).toMatch(L1_GIT);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 L1 names the git subcommand that failed',
    async () => {
      // A submodule whose .git file points nowhere fails `git status` only, which runs with a
      // global option before its subcommand; L1 names the subcommand (helper-api §Messages).
      const root = temporary();
      const origin = repository(path.join(root, 'origin'), { 'lib.py': 'VALUE = 1\n' });
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      git(service, 'submodule', 'add', '-q', origin, 'sub');
      commit(service, 'add submodule');
      writeFileSync(path.join(service, 'sub/.git'), 'gitdir: ../nowhere\n');
      const reported = await report(service);
      expect(reported.service).toEqual({});
      expect(reported.warnings).toHaveLength(1);
      expect(reported.warnings[0]).toMatch(/^Service version not reported: git status: /);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-18 a missing serviceDir, or git that cannot start',
    async () => {
      const root = temporary();
      const missing = await report(path.join(root, 'missing'));
      expect(missing.service).toEqual({});
      expect(missing.warnings).toEqual(['Service version not reported: lstat .: ENOENT.']);

      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      const denied = await report(service, { env: gitOnPath(path.join(root, 'denied'), '') });
      expect(denied.service).toEqual({});
      expect(denied.warnings).toEqual(['Service version not reported: git rev-parse: EACCES.']);

      const absent = await report(service, {
        env: gitOnPath(path.join(root, 'absent'), undefined),
      });
      expect(absent.service).toEqual({});
      expect(absent.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 S-RV-19 a nested repository removed while computing is left out',
    async () => {
      const root = temporary();
      const service = repository(path.join(root, 'service'), SERVICE_FILES);
      const nested = repository(path.join(service, 'nested'), { 'notes.md': 'nested\n' });
      const realNested = execFileSync('/bin/sh', ['-c', 'pwd -P'], {
        cwd: nested,
        encoding: 'utf8',
      }).trim();
      // Listing the nested repository's files removes that folder, and that git call fails.
      const script = [
        '#!/bin/sh',
        `if [ "$(pwd -P)" = "${realNested}" ] && [ "$1" = ls-files ]; then`,
        `  ${which('rm')} -rf "${nested}"`,
        '  echo "fatal: the folder is gone" >&2',
        '  exit 128',
        'fi',
        `exec "${which('git')}" "$@"`,
        '',
      ].join('\n');
      const reported = await report(service, {
        env: gitOnPath(path.join(root, 'vanishing'), script),
      });
      expect(reported.warnings).toEqual([]);
      expect(reported.service.treeHash).toBe(treeHashOf(SERVICE_FILES));
    },
    TIMEOUT_MS,
  );
});
