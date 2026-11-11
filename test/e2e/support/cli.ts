import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const CLI = path.join(ROOT, 'dist/cli.js');
export const MOCK_ADAPTER = path.join(ROOT, 'dist/adapter/mock.js');

/** Long enough for a swap of a few dozen mock trials on a slow CI machine. */
export const CLI_TIMEOUT_MS = 60_000;

export interface CliResult {
  /** `null` when the process ended on a signal, for example after the time limit. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartedCli {
  readonly pid: number;
  /** What the process wrote to stderr so far. */
  stderr(): string;
  kill(signal: NodeJS.Signals): void;
  /**
   * Signals the CLI's whole process group, as a terminal does on Ctrl-C; only for a CLI started
   * with `ownGroup`.
   */
  killGroup(signal: NodeJS.Signals): void;
  readonly done: Promise<CliResult>;
}

export interface StartOptions {
  /** Starts the CLI in a process group of its own, so the test can signal the group. */
  readonly ownGroup?: boolean;
}

/** Starts the built CLI as a user would, without colour, so a test can signal it while it runs. */
export function startCli(
  args: readonly string[],
  cwd: string,
  options: StartOptions = {},
): StartedCli {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env,
    stdio: 'pipe',
    detached: options.ownGroup === true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const done = new Promise<CliResult>((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
  const { pid } = child;
  if (pid === undefined) {
    throw new Error('the CLI process did not start');
  }
  return {
    pid,
    killGroup: (signal) => {
      if (options.ownGroup !== true) {
        throw new Error('the CLI shares the test runner process group');
      }
      process.kill(-pid, signal);
    },
    stderr: () => Buffer.concat(stderr).toString('utf8'),
    kill: (signal) => {
      child.kill(signal);
    },
    done,
  };
}

/** Runs the built CLI as a user would, without colour, and collects both streams. */
export function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  return startCli(args, cwd).done;
}
