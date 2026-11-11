#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { z } from 'zod';

import { EXIT_CODES } from './cli/exit-codes.js';
import { main } from './cli/main.js';

try {
  const packageJson = z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  process.exitCode = await main({
    version: packageJson.version,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  // Reached only when main itself fails; it handles command errors with its own output.
  process.stderr.write(
    `model-eval: internal error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = EXIT_CODES['internal-error'];
}
