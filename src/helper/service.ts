import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// data-model §Service Version: `version`, `dirty` and `treeHash` of `service_dir`. Paths stay
// the bytes git printed and are ordered with `Buffer.compare`; files are identified by device
// and inode read as `bigint`.

export interface ServiceVersion {
  readonly version: string;
  readonly dirty: boolean;
  readonly treeHash: string;
}

/**
 * `initialize`'s `service`, empty when nothing is reported. `reason` is the `<reason>` of log
 * warning L1 when computing it failed.
 */
export interface ServiceReport {
  readonly service: ServiceVersion | Record<string, never>;
  readonly reason?: string;
}

/** A git call, `lstat` or a file read failed: nothing is reported, with log warning L1. */
class VersionError extends Error {}

/** The service folder has no version to report, and no warning is due. */
class NotReported extends Error {}

interface GitRun {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const SLASH = 0x2f;
const NUL = Buffer.from([0]);

export async function serviceVersion(
  serviceDir: string | undefined,
  toolPaths: readonly string[],
): Promise<ServiceReport> {
  if (serviceDir === undefined) {
    return { service: {} };
  }
  try {
    const tree = new GitTree(path.resolve(serviceDir), await toolIdentities(toolPaths));
    return { service: await tree.report() };
  } catch (error) {
    if (error instanceof NotReported) {
      return { service: {} };
    }
    if (error instanceof VersionError) {
      return { service: {}, reason: error.message };
    }
    throw error;
  }
}

function identity(stats: BigIntStats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

/** Each existing `toolPaths` entry by both its `lstat` and its `stat` identity. */
async function toolIdentities(toolPaths: readonly string[]): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for (const entry of toolPaths) {
    for (const read of [lstat, stat]) {
      try {
        found.add(identity(await read(entry, { bigint: true })));
      } catch {
        continue;
      }
    }
  }
  return found;
}

class GitTree {
  private readonly env: NodeJS.ProcessEnv = { ...process.env };
  private readonly base: Buffer;

  constructor(
    private readonly folder: string,
    private readonly tools: ReadonlySet<string>,
  ) {
    this.base = Buffer.from(folder);
  }

  async report(): Promise<ServiceVersion> {
    try {
      await lstat(`${this.folder}/.`);
    } catch (error) {
      throw new VersionError(this.osFailure('lstat', Buffer.from('.'), error));
    }
    const names = await this.git(this.folder, ['rev-parse', '--local-env-vars'], false);
    for (const name of names.stdout.toString().split(/\s+/)) {
      if (name !== '') {
        // Removing the variable is the point: git would otherwise resolve every folder to it.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.env[name];
      }
    }
    const inside = await this.git(this.folder, ['rev-parse', '--is-inside-work-tree'], false);
    if (inside.code !== 0 || inside.stdout.toString().trim() !== 'true') {
      throw new NotReported();
    }
    const ignored = await this.git(this.folder, ['check-ignore', '-q', '.'], false);
    if (ignored.code === 0) {
      throw new NotReported();
    }
    if (ignored.code !== 1) {
      throw new VersionError(`git check-ignore: ${gitFailure(ignored)}`);
    }
    const version = (await this.git(this.folder, ['rev-parse', 'HEAD'])).stdout.toString().trim();
    const top = trimNewlines(
      (await this.git(this.folder, ['rev-parse', '--show-toplevel'])).stdout,
    );
    const dirty = await this.dirty(top);
    const treeHash = await this.treeHash(this.base, false);
    if (treeHash === undefined) {
      throw new NotReported();
    }
    return { version, dirty, treeHash };
  }

  private async git(folder: string, args: readonly string[], check = true): Promise<GitRun> {
    // A string `code` is the error of a git that did not start; a number is its exit code.
    const done = await new Promise<GitRun | { readonly startError: string }>((resolve) => {
      execFile(
        'git',
        args,
        { cwd: folder, env: this.env, encoding: 'buffer', maxBuffer: Infinity },
        (error, stdout, stderr) => {
          if (typeof error?.code === 'string') {
            resolve({ startError: error.code });
          } else {
            resolve({ code: error === null ? 0 : (error.code ?? -1), stdout, stderr });
          }
        },
      );
    });
    if ('startError' in done) {
      // data-model §When Nothing Is Reported: git not installed is silent; git that fails to
      // start for another reason, or a folder gone before git ran, is a failure.
      if (done.startError === 'ENOENT' && (await isDirectory(folder))) {
        throw new NotReported();
      }
      throw new VersionError(`git ${subcommand(args)}: ${done.startError}`);
    }
    if (check && done.code !== 0) {
      throw new VersionError(`git ${subcommand(args)}: ${gitFailure(done)}`);
    }
    return done;
  }

  private async dirty(top: Buffer): Promise<boolean> {
    const args = ['--no-optional-locks', 'status', '--porcelain', '-z'];
    args.push('--untracked-files=all', '--ignore-submodules=none', '--', '.');
    const entries = split(await this.git(this.folder, args).then((done) => done.stdout), 0);
    for (let index = 0; index < entries.length;) {
      const entry = entries[index++] ?? Buffer.alloc(0);
      if (entry.length < 4) {
        continue;
      }
      const paths = [entry.subarray(3)];
      const status = entry.subarray(0, 2).toString('latin1');
      if (status.includes('R') || status.includes('C')) {
        paths.push(entries[index++] ?? Buffer.alloc(0));
      }
      for (const entryPath of paths) {
        if (entryPath.length > 0 && !(await this.excluded(joinPath(top, entryPath), top))) {
          return true;
        }
      }
    }
    return false;
  }

  /** The path, or a parent folder up to `stop`, is the same file as a `toolPaths` entry. */
  private async excluded(full: Buffer, stop: Buffer): Promise<boolean> {
    let current = full;
    for (;;) {
      try {
        if (this.tools.has(identity(await lstat(current, { bigint: true })))) {
          return true;
        }
      } catch {
        // A path absent from the work tree is compared through its parent folders.
      }
      if (current.equals(stop) || current.length <= stop.length) {
        return false;
      }
      const parent = dirname(current);
      if (parent.equals(current)) {
        return false;
      }
      current = parent;
    }
  }

  private async listed(folder: Buffer): Promise<Buffer[]> {
    const cwd = folder.toString();
    const cached = (await this.git(cwd, ['ls-files', '-z', '--cached'])).stdout;
    const others = (await this.git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']))
      .stdout;
    const unique = new Map<string, Buffer>();
    for (const listed of [...split(cached, 0), ...split(others, 0)]) {
      const trimmed = trimTrailing(listed, SLASH);
      unique.set(trimmed.toString('hex'), trimmed);
    }
    return [...unique.values()].sort((a, b) => Buffer.compare(a, b));
  }

  /** data-model §`treeHash`; undefined for an empty list at `service_dir`. */
  private async treeHash(folder: Buffer, nested: boolean): Promise<string | undefined> {
    const hash = createHash('sha256');
    let parts = 0;
    const leftOut: Buffer[] = [];
    for (const listed of await this.listed(folder)) {
      if (leftOut.some((parent) => isBelow(listed, parent))) {
        continue;
      }
      const entry = await this.entry(folder, listed);
      if (entry === undefined) {
        leftOut.push(listed);
        continue;
      }
      const [kind, content] = entry;
      hash.update(listed).update(NUL).update(kind).update(NUL);
      hash.update(String(content.length)).update(NUL).update(content);
      parts += 1;
    }
    if (parts === 0 && !nested) {
      return undefined;
    }
    return `sha256:${hash.digest('hex')}`;
  }

  /**
   * The kind and content of a listed path, or undefined when it is left out. A folder that is
   * not a repository top is left out with the files placed in it.
   */
  private async entry(base: Buffer, listed: Buffer): Promise<[string, Buffer] | undefined> {
    const full = joinPath(base, listed);
    if (await this.excluded(full, base)) {
      return undefined;
    }
    let info: BigIntStats;
    try {
      info = await lstat(full, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw new VersionError(this.osFailure('lstat', full, error));
    }
    if (info.isSymbolicLink()) {
      const target = await this.read(full, (file) => readlink(file, { encoding: 'buffer' }));
      return target === undefined ? undefined : ['l', target];
    }
    if (info.isFile()) {
      const content = await this.read(full, (file) => readFile(file));
      return content === undefined ? undefined : ['f', content];
    }
    if (info.isDirectory()) {
      return this.nestedEntry(full);
    }
    return undefined;
  }

  /**
   * A folder's `s` entry when it is a repository top. When its git fails and the folder is
   * gone, it disappeared while computing and is left out; otherwise the failure counts.
   */
  private async nestedEntry(folder: Buffer): Promise<[string, Buffer] | undefined> {
    try {
      if (!(await this.isRepositoryTop(folder))) {
        return undefined;
      }
      const tree = await this.treeHash(folder, true);
      return tree === undefined ? undefined : ['s', Buffer.from(tree)];
    } catch (error) {
      if (error instanceof VersionError && !(await exists(folder))) {
        return undefined;
      }
      throw error;
    }
  }

  /** The bytes, or undefined for a path that vanished while computing. */
  private async read(
    file: Buffer,
    reader: (file: Buffer) => Promise<Buffer>,
  ): Promise<Buffer | undefined> {
    try {
      return await reader(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return undefined;
      }
      throw new VersionError(this.osFailure('read', file, error));
    }
  }

  private async isRepositoryTop(folder: Buffer): Promise<boolean> {
    const done = await this.git(folder.toString(), ['rev-parse', '--show-toplevel']);
    try {
      const top = await stat(trimNewlines(done.stdout), { bigint: true });
      return identity(top) === identity(await stat(folder, { bigint: true }));
    } catch {
      return false;
    }
  }

  private osFailure(operation: string, file: Buffer, error: unknown): string {
    const prefix = Buffer.concat([this.base, Buffer.from('/')]);
    const relative = isBelow(file, this.base) ? file.subarray(prefix.length) : file;
    return `${operation} ${relative.toString()}: ${errorCode(error) ?? 'unknown'}`;
  }
}

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the path exists; only "not found" counts as gone. */
async function exists(file: Buffer): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

/** The git subcommand of an argument list that may start with global options. */
function subcommand(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith('-')) ?? '';
}

// The line breaks Python's `str.splitlines` splits on, so both helpers quote the same line;
// U+001C to U+001E are among them.
// eslint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
// The 25 White_Space code points of data-model §Comparing Text.
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** git's last non-empty stderr line, trimmed, or `exit code N`. */
function gitFailure(done: GitRun): string {
  const lines = done.stderr
    .toString('utf8')
    .split(LINE_BREAK)
    .map((line) => line.replace(EDGE_WHITE_SPACE, ''))
    .filter((line) => line !== '');
  return lines.at(-1) ?? `exit code ${String(done.code)}`;
}

function split(bytes: Buffer, separator: number): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let end = bytes.indexOf(separator); end !== -1; end = bytes.indexOf(separator, start)) {
    parts.push(bytes.subarray(start, end));
    start = end + 1;
  }
  parts.push(bytes.subarray(start));
  return parts.filter((part) => part.length > 0);
}

function trimTrailing(bytes: Buffer, byte: number): Buffer {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === byte) {
    end -= 1;
  }
  return bytes.subarray(0, end);
}

function trimNewlines(bytes: Buffer): Buffer {
  return trimTrailing(bytes, 0x0a);
}

/** `parent/child`, as `os.path.join` writes it for a relative child. */
function joinPath(parent: Buffer, child: Buffer): Buffer {
  if (parent.length === 0 || parent[parent.length - 1] === SLASH) {
    return Buffer.concat([parent, child]);
  }
  return Buffer.concat([parent, Buffer.from('/'), child]);
}

/** Whether `child` lies below the folder `parent`. */
function isBelow(child: Buffer, parent: Buffer): boolean {
  return (
    child.length > parent.length &&
    child[parent.length] === SLASH &&
    child.subarray(0, parent.length).equals(parent)
  );
}

/** The folder part of a path, as `os.path.dirname` gives it for bytes. */
function dirname(file: Buffer): Buffer {
  const head = file.subarray(0, file.lastIndexOf(SLASH) + 1);
  return head.every((byte) => byte === SLASH) ? head : trimTrailing(head, SLASH);
}
