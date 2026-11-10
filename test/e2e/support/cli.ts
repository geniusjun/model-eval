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

/** Runs the built CLI as a user would, without colour, and collects both streams. */
export function runCli(args: readonly string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
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
}
