import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { startAdapter } from '../../../../src/adapter/client.js';
import type { Service } from '../../../../src/adapter/protocol.js';
import { type AdapterLanguage, apiEnv, NODE_SERVICES, PYTHON_SERVICES } from './driver.js';
import { PYTHON_DIR, pythonInterpreter } from './mock-api.js';

// Temporary git repositories for the service version (data-model §Service Version), and the
// version an adapter reports for one of them in `initialize`.

const GIT_CONFIG = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'protocol.file.allow=always',
];

/**
 * This process's environment without the variables that point git at another repository, and
 * without the user's global and system configuration.
 */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith('GIT_')) {
      env[name] = value;
    }
  }
  return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
}

export function git(folder: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd: folder,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Runs git and returns its stdout without failing when it exits with another code. */
export function gitMayFail(folder: string, ...args: string[]): void {
  try {
    git(folder, ...args);
  } catch {
    // A merge with a conflict exits with 1.
  }
}

export type Files = Readonly<Record<string, Buffer | string>>;

export function write(folder: string, files: Files): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(folder, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export function commit(folder: string, message = 'change'): void {
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '--allow-empty', '-m', message);
}

export function repository(folder: string, files: Files, ...init: string[]): string {
  mkdirSync(folder, { recursive: true });
  git(folder, 'init', '-q', ...init);
  write(folder, files);
  commit(folder);
  return folder;
}

/** One entry of data-model §`treeHash` step 5: the path's bytes, its kind and its content. */
export type TreeEntry = readonly [Buffer, 'f' | 'l' | 's', Buffer];

/** The treeHash of data-model §`treeHash` step 5, built here from the entries a test wrote. */
export function treeHash(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort(
    ([a, aKind], [b, bKind]) => Buffer.compare(a, b) || aKind.localeCompare(bKind),
  );
  const hash = createHash('sha256');
  for (const [name, kind, content] of sorted) {
    hash.update(
      Buffer.concat([name, Buffer.from(`\0${kind}\0${String(content.length)}\0`), content]),
    );
  }
  return `sha256:${hash.digest('hex')}`;
}

export function fileEntries(files: Files): TreeEntry[] {
  return Object.entries(files).map(([name, content]) => [
    Buffer.from(name),
    'f',
    Buffer.from(content),
  ]);
}

export function treeHashOf(files: Files): string {
  return treeHash(fileEntries(files));
}

export interface Reported {
  readonly service: Service | Record<string, never>;
  readonly warnings: string[];
}

export interface ReportOptions {
  readonly language: AdapterLanguage;
  readonly serviceDir?: string;
  readonly toolPaths?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The mock server's address; the version service makes no model request. */
  readonly baseUrl?: string;
}

/**
 * Starts version_service.mjs or version_service.py and returns `initialize`'s `service` and the
 * `log` warnings sent before `shutdown` was answered.
 */
export async function reportVersion(options: ReportOptions): Promise<Reported> {
  const node = options.language === 'typescript';
  const command = node
    ? [process.execPath, path.join(NODE_SERVICES, 'version_service.mjs')]
    : [pythonInterpreter(), path.join(PYTHON_SERVICES, 'version_service.py')];
  const env: Record<string, string> = {
    ...apiEnv(options.baseUrl ?? 'http://127.0.0.1:9'),
    // The helper's git runs without the user's global and system configuration, as the test's own
    // git does, so the values do not depend on the machine.
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    ...(node ? {} : { PYTHONPATH: [PYTHON_DIR, PYTHON_SERVICES].join(path.delimiter) }),
    ...(options.serviceDir === undefined ? {} : { MODEL_EVAL_SERVICE_DIR: options.serviceDir }),
    ...options.env,
  };
  const warnings: string[] = [];
  const started = await startAdapter({
    launch: { command, cwd: options.cwd ?? (node ? NODE_SERVICES : PYTHON_SERVICES), env },
    initialize: {
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: 30_000,
      toolPaths: [...(options.toolPaths ?? [])],
    },
    concurrency: 1,
    onLog: (log) => {
      if (log.level === 'warn') {
        warnings.push(log.message);
      }
    },
  });
  if (!started.ok) {
    throw new Error(`the version service did not start: ${started.error.message}`);
  }
  const { service } = started.client.info;
  await started.client.shutdown();
  return { service: service ?? {}, warnings };
}
