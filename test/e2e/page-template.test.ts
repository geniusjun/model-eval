import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main, type CliContext } from '../../src/cli/main.js';
import { message } from '../../src/messages/index.js';
import { ROOT } from './support/cli.js';
import { E2E, SWAP } from './support/commands.js';
import { entries } from './support/outputs.js';

// Without the result page template, as in a source checkout whose viewer is not built, the
// commands still write comparison.json and report.md, say on stderr that no page was written,
// and exit as the gate decides (001 FR-031).

const EXAMPLE = path.join(ROOT, 'examples/pogo');
const OUTPUT_DIR = '.model-eval';

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let folder: string;
let missingTemplate: string;

async function run(argv: readonly string[]): Promise<Ran> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stream = (chunks: string[]) => ({
    write: (chunk: string) => chunks.push(chunk),
  });
  const context: CliContext = {
    version: '0.0.0',
    argv,
    cwd: folder,
    env: { NO_COLOR: '1' },
    stdout: stream(stdout),
    stderr: stream(stderr),
    pageTemplate: missingTemplate,
  };
  const code = await main(context);
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function warning(lang: 'en' | 'ko'): string {
  return message(lang, 'cli.pageTemplateMissing', { file: missingTemplate });
}

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'model-eval-no-template-'));
  missingTemplate = path.join(folder, 'no-viewer', 'report.html');
  await cp(EXAMPLE, folder, {
    recursive: true,
    filter: (source) => path.basename(source) !== OUTPUT_DIR,
  });
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('001 commands without the result page template', () => {
  it(
    '001 FR-031 swap warns once on stderr, exits 1 as the gate blocks, and writes no page',
    async () => {
      const swap = await run([...SWAP]);
      expect(swap.code).toBe(1);
      expect(swap.stderr.split(warning('en'))).toHaveLength(2);
      const outputDir = path.join(folder, OUTPUT_DIR);
      const [comparisonId] = await entries(path.join(outputDir, 'comparisons'));
      if (comparisonId === undefined) {
        throw new Error('the swap wrote no comparison');
      }
      const dir = path.join(outputDir, 'comparisons', comparisonId);
      expect(await entries(dir)).toEqual(['comparison.json', 'report.md']);
      expect(existsSync(path.join(outputDir, 'index.html'))).toBe(false);
      expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toContain('`samples.review`');
      expect(swap.stdout).not.toContain('report.html');

      const report = await run(['report', comparisonId, '--lang', 'ko']);
      expect(report.code).toBe(0);
      expect(report.stderr).toContain(warning('ko'));
      expect(await entries(dir)).toEqual(['comparison.json', 'report.md']);
    },
    E2E.timeout,
  );
});
