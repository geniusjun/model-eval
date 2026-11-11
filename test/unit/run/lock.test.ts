import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireRunLock, LOCK_FILE, type LockOwner } from '../../../src/run/lock.js';

let runDir: string;
let lockPath: string;

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'model-eval-lock-'));
  lockPath = path.join(runDir, LOCK_FILE);
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

/** The PID of a process that has already exited. */
function exitedPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

async function writeLock(owner: LockOwner): Promise<void> {
  await writeFile(lockPath, JSON.stringify(owner));
}

async function readLock(): Promise<unknown> {
  return JSON.parse(await readFile(lockPath, 'utf8'));
}

describe('run.lock', () => {
  it('001 FR-013 writes PID, host and start time at acquire and removes the lock at release', async () => {
    const now = new Date('2026-11-05T10:15:00.000Z');
    const result = await acquireRunLock(runDir, { now });
    if (!result.ok) {
      throw new Error(result.refusal.reason);
    }
    const owner = { pid: process.pid, host: hostname(), startedAt: now.toISOString() };
    expect(result.lock.owner).toEqual(owner);
    expect(result.lock.path).toBe(lockPath);
    expect(await readLock()).toEqual(owner);
    await result.lock.release();
    expect(await readdir(runDir)).toEqual([]);
  });

  it('001 FR-013 refuses a lock whose owner is alive, with the lock path', async () => {
    const owner = { pid: process.pid, host: hostname(), startedAt: '2026-11-05T10:15:00.000Z' };
    await writeLock(owner);
    expect(await acquireRunLock(runDir)).toEqual({
      ok: false,
      refusal: { reason: 'live-owner', path: lockPath, owner },
    });
    expect(await readLock()).toEqual(owner);
  });

  it('001 FR-013 refuses the lock of another host, whose owner cannot be checked', async () => {
    const owner = {
      pid: exitedPid(),
      host: `${hostname()}-other`,
      startedAt: '2026-11-05T10:15:00.000Z',
    };
    await writeLock(owner);
    expect(await acquireRunLock(runDir)).toEqual({
      ok: false,
      refusal: { reason: 'other-host', path: lockPath, owner },
    });
  });

  it('001 FR-013 takes the lock over when its owner on this host is gone', async () => {
    await writeLock({ pid: exitedPid(), host: hostname(), startedAt: '2026-11-04T09:00:00.000Z' });
    const result = await acquireRunLock(runDir);
    if (!result.ok) {
      throw new Error(result.refusal.reason);
    }
    expect(await readLock()).toEqual(result.lock.owner);
    expect(result.lock.owner.pid).toBe(process.pid);
    expect(await readdir(runDir)).toEqual([LOCK_FILE]);
    await result.lock.release();
  });

  it('001 FR-013 refuses a second writer in the same process until the first releases', async () => {
    const first = await acquireRunLock(runDir);
    expect(first.ok).toBe(true);
    const second = await acquireRunLock(runDir);
    expect(second.ok).toBe(false);
    if (first.ok) {
      await first.lock.release();
    }
    const third = await acquireRunLock(runDir);
    expect(third.ok).toBe(true);
    if (third.ok) {
      await third.lock.release();
    }
  });

  it('001 FR-013 leaves a lock another process took over in place at release', async () => {
    const result = await acquireRunLock(runDir);
    if (!result.ok) {
      throw new Error(result.refusal.reason);
    }
    const other = { pid: process.pid, host: hostname(), startedAt: '2026-11-06T00:00:00.000Z' };
    await writeLock(other);
    await result.lock.release();
    expect(await readLock()).toEqual(other);
  });

  it('001 FR-013 refuses a lock file it cannot read, with the lock path', async () => {
    await writeFile(lockPath, 'not json');
    expect(await acquireRunLock(runDir)).toEqual({
      ok: false,
      refusal: { reason: 'unreadable', path: lockPath },
    });
  });
});
