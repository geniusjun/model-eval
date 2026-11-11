import { link, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { temporaryPath } from './writer.js';

// run.lock (data-model §Resume and Locking, Lock).

export const LOCK_FILE = 'run.lock';
/** Takeovers raced by other processes before giving up. */
const LOCK_TRIES = 3;

const lockOwnerSchema = z.object({
  pid: z.int().min(1),
  host: z.string().min(1),
  startedAt: z.iso.datetime({ offset: true }),
});

export type LockOwner = z.infer<typeof lockOwnerSchema>;

/** Every refusal is a configuration error (exit code 4) that names the lock path. */
export type LockRefusal =
  | {
      readonly reason: 'live-owner' | 'other-host';
      readonly path: string;
      readonly owner: LockOwner;
    }
  | { readonly reason: 'unreadable'; readonly path: string };

export interface HeldLock {
  readonly path: string;
  readonly owner: LockOwner;
  /** Removes the lock unless another process has taken it over since. */
  release(): Promise<void>;
}

export type LockResult =
  | { readonly ok: true; readonly lock: HeldLock }
  | { readonly ok: false; readonly refusal: LockRefusal };

export interface LockOptions {
  readonly now?: Date;
  /** Whether a process of this host is running; `process.kill(pid, 0)` unless set. */
  readonly isAlive?: (pid: number) => boolean;
}

type LockFile =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'owned'; readonly owner: LockOwner };

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errorCode(error) === 'EPERM';
  }
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt;
}

async function readLockFile(file: string): Promise<LockFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }
  try {
    const parsed = lockOwnerSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'owned', owner: parsed.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** A hard link fails when the lock exists, so the lock appears whole or not at all. */
async function createExclusive(lockPath: string, owner: LockOwner): Promise<boolean> {
  const temporary = temporaryPath(lockPath);
  await writeFile(temporary, JSON.stringify(owner), { flag: 'wx' });
  try {
    await link(temporary, lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Moves the stale lock aside before deleting it. If another process replaced it after it was
 * read, the moved file is that process's lock and goes back.
 */
async function removeStale(lockPath: string, stale: LockOwner): Promise<void> {
  const aside = temporaryPath(lockPath);
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
  const moved = await readLockFile(aside);
  if (!(moved.kind === 'owned' && sameOwner(moved.owner, stale))) {
    await link(aside, lockPath).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') {
        throw error;
      }
    });
  }
  await rm(aside, { force: true });
}

function heldLock(lockPath: string, owner: LockOwner): HeldLock {
  return {
    path: lockPath,
    owner,
    async release() {
      const current = await readLockFile(lockPath);
      if (current.kind === 'owned' && sameOwner(current.owner, owner)) {
        await unlink(lockPath).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') {
            throw error;
          }
        });
      }
    },
  };
}

/**
 * Takes `run.lock` in `runDir` for `run` and `swap`. A lock of this host whose process is gone is
 * taken over; a live owner, another host's lock (its owner cannot be checked) and an unreadable
 * lock are refused.
 */
export async function acquireRunLock(
  runDir: string,
  options: LockOptions = {},
): Promise<LockResult> {
  const lockPath = path.join(runDir, LOCK_FILE);
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: (options.now ?? new Date()).toISOString(),
  };
  const isAlive = options.isAlive ?? processExists;
  let seen: LockOwner | undefined;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    if (await createExclusive(lockPath, owner)) {
      return { ok: true, lock: heldLock(lockPath, owner) };
    }
    const current = await readLockFile(lockPath);
    if (current.kind === 'unreadable') {
      return { ok: false, refusal: { reason: 'unreadable', path: lockPath } };
    }
    if (current.kind === 'owned') {
      seen = current.owner;
      if (current.owner.host !== owner.host) {
        return {
          ok: false,
          refusal: { reason: 'other-host', path: lockPath, owner: current.owner },
        };
      }
      if (isAlive(current.owner.pid)) {
        return {
          ok: false,
          refusal: { reason: 'live-owner', path: lockPath, owner: current.owner },
        };
      }
      await removeStale(lockPath, current.owner);
    }
  }
  return {
    ok: false,
    refusal:
      seen === undefined
        ? { reason: 'unreadable', path: lockPath }
        : { reason: 'live-owner', path: lockPath, owner: seen },
  };
}
