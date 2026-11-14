import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serviceVersion } from '../../../src/helper/service.js';

let root: string;

function git(folder: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: folder, encoding: 'utf8' },
  ).trim();
}

function repository(folder: string): void {
  mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q');
}

function write(folder: string, name: string, content: string): void {
  mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
  writeFileSync(path.join(folder, name), content);
}

/** data-model §`treeHash` step 5 over entries given as [path, kind, content]. */
function expectedTreeHash(entries: [string, string, string][]): string {
  const sorted = entries
    .map(([name, kind, content]) => [Buffer.from(name), kind, Buffer.from(content)] as const)
    .sort(([a], [b]) => Buffer.compare(a, b));
  const hash = createHash('sha256');
  for (const [name, kind, content] of sorted) {
    hash.update(Buffer.concat([name, Buffer.from(`\0${kind}\0${String(content.length)}\0`)]));
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'service-version-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('service version', () => {
  it('003 FR-003 reports nothing without serviceDir', async () => {
    await expect(serviceVersion(undefined, [])).resolves.toEqual({ service: {} });
  });

  it('003 FR-003 reports nothing outside a git work tree, with no warning', async () => {
    await expect(serviceVersion(root, [])).resolves.toEqual({ service: {} });
  });

  it('003 FR-003 a missing serviceDir gives the L1 reason of lstat', async () => {
    await expect(serviceVersion(path.join(root, 'missing'), [])).resolves.toEqual({
      service: {},
      reason: 'lstat .: ENOENT',
    });
  });

  it('003 FR-003 version, dirty and treeHash by bytes, leaving out tool files', async () => {
    const service = path.join(root, 'service');
    repository(service);
    // U+FF01 sorts after U+1F600 by UTF-16 units and before it by bytes.
    write(service, '\u{1F600}.txt', 'smile');
    write(service, '！.txt', 'bang');
    write(service, 'src/app.py', 'print(1)\n');
    write(service, 'rules/rule.yaml', 'rule: 1\n');
    symlinkSync('src/app.py', path.join(service, 'link'));
    git(service, 'add', '-A');
    git(service, 'commit', '-q', '-m', 'init');
    const head = git(service, 'rev-parse', 'HEAD');
    const tools = [path.join(service, 'rules'), path.join(service, 'out')];

    const clean = await serviceVersion(service, tools);
    expect(clean).toEqual({
      service: {
        version: head,
        dirty: false,
        treeHash: expectedTreeHash([
          ['\u{1F600}.txt', 'f', 'smile'],
          ['！.txt', 'f', 'bang'],
          ['link', 'l', 'src/app.py'],
          ['src/app.py', 'f', 'print(1)\n'],
        ]),
      },
    });

    write(service, 'rules/rule.yaml', 'rule: 2\n');
    await expect(serviceVersion(service, tools)).resolves.toEqual(clean);

    write(service, 'notes.txt', 'new');
    const changed = await serviceVersion(service, tools);
    expect(changed.service).toMatchObject({ version: head, dirty: true });
    expect(changed.service).not.toEqual(clean.service);
  });

  it('003 FR-003 an untracked nested repository is hashed as its own tree', async () => {
    const service = path.join(root, 'service');
    repository(service);
    write(service, 'a.txt', 'a');
    git(service, 'add', '-A');
    git(service, 'commit', '-q', '-m', 'init');
    repository(path.join(service, 'nested'));
    write(service, 'nested/b.txt', 'b');

    const nested = expectedTreeHash([['b.txt', 'f', 'b']]);
    await expect(serviceVersion(service, [])).resolves.toMatchObject({
      service: {
        dirty: true,
        treeHash: expectedTreeHash([
          ['a.txt', 'f', 'a'],
          ['nested', 's', nested],
        ]),
      },
    });
  });
});
