import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { parse as parseYaml, parseDocument } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configSchema, rulesFileSchema } from '../../src/config/schema.js';
import { message } from '../../src/messages/index.js';
import { comparisonPage, DATA_PLACEHOLDER, listPage } from '../../src/report/page-data.js';
import { listPageSchema } from '../../src/report/schema.js';
import { ROOT, runCli } from './support/cli.js';
import { SWAP } from './support/commands.js';
import {
  dryRunPlanOf,
  entries,
  parseLintEnvelope,
  parseSwapEnvelope,
  readComparison,
  readPage,
} from './support/outputs.js';
import { recordAdapter } from './support/project.js';

// SC-001 and SC-006: the steps of quickstart.md §Verify: Example Swap Check, run on a copy of
// examples/pogo as a fresh clone has it. The example's adapter needs only Node and never calls
// a model; its `next` variant breaks the Japanese script rule on purpose.

const EXAMPLE = path.join(ROOT, 'examples/pogo');
const OUTPUT_DIR = '.model-eval';

/** SC-006: the whole example check runs in CI within 3 minutes. */
const BUDGET_MS = 180_000;

const SCRIPT_JA_QUOTE = '日本語だけで話す';

let folder: string;
let startedAt: number;

/** The rule IDs of a text in the order they first appear. */
function ruleOrder(text: string, ruleIds: readonly string[]): string[] {
  return ruleIds
    .map((id) => ({ id, at: text.search(new RegExp(`(?<![\\w-])${id}(?![\\w-])`, 'u')) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ id }) => id);
}

async function ruleIdsOfExample(): Promise<string[]> {
  const text = await readFile(path.join(folder, 'rules/pogo.yaml'), 'utf8');
  return rulesFileSchema.parse(parseYaml(text)).rules.map((rule) => rule.id);
}

beforeAll(async () => {
  startedAt = Date.now();
  folder = await mkdtemp(path.join(tmpdir(), 'model-eval-pogo-'));
  // A fresh clone has no output directory, even when the example was run in place before.
  await cp(EXAMPLE, folder, {
    recursive: true,
    filter: (source) => path.basename(source) !== OUTPUT_DIR,
  });
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('001 example examples/pogo (quickstart.md §Verify: Example Swap Check)', () => {
  it(
    '001 SC-006 step 0: the CLI prints a version',
    async () => {
      const cli = await runCli(['--version'], folder);
      expect(cli.code).toBe(0);
      expect(cli.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
    },
    BUDGET_MS,
  );

  it(
    '001 SC-006 step 1: lint --render exits 0 with the one planted anchor-missing warning, and 1 with --max-warnings 0',
    async () => {
      const cli = await runCli(['lint', '--render', '--json'], folder);
      expect(cli.code).toBe(0);
      const envelope = parseLintEnvelope(cli.stdout);
      expect(envelope.result?.errors).toEqual([]);
      expect(envelope.warnings).toEqual([
        expect.objectContaining({
          code: 'anchor-missing',
          ruleId: 'no-emoji',
          lang: 'en',
          params: { quote: 'Never use emoji' },
        }),
      ]);
      const strict = await runCli(['lint', '--render', '--max-warnings', '0'], folder);
      expect(strict.code).toBe(1);
    },
    BUDGET_MS,
  );

  it(
    '001 SC-006 step 2: swap --dry-run shows calls, both estimates, the reservation and the gated cells without a generate request',
    async () => {
      // The same project behind a recorder, so the test sees every request the adapter receives.
      const document = parseDocument(
        await readFile(path.join(folder, 'model-eval.config.yaml'), 'utf8'),
      );
      const recorder = await recordAdapter(
        folder,
        configSchema.parse(document.toJS()).adapter.command,
      );
      document.setIn(['adapter', 'command'], recorder.command);
      await writeFile(path.join(folder, 'recorded.config.yaml'), document.toString());

      const cli = await runCli(
        [...SWAP, '--dry-run', '--json', '--config', 'recorded.config.yaml'],
        folder,
      );
      expect(cli.code).toBe(0);
      const plan = dryRunPlanOf(parseSwapEnvelope(cli.stdout));
      expect(plan.variants.map((variant) => variant.variant)).toEqual(['current', 'next']);
      for (const variant of plan.variants) {
        expect(variant.calls).toBeGreaterThan(0);
        expect(variant.reservationUsd).toBeGreaterThan(0);
      }
      expect(plan.expectedUsd).toBeGreaterThan(0);
      expect(plan.conservativeUsd ?? 0).toBeGreaterThanOrEqual(plan.expectedUsd ?? 0);
      expect(plan.maxCostUsd).toBe(1);
      expect(plan.cells.length).toBeGreaterThan(0);
      for (const cell of plan.cells) {
        expect(cell.plannedTrials).toBeGreaterThanOrEqual(cell.nMin);
      }
      expect((await recorder.sessions()).length).toBeGreaterThan(0);
      expect(await recorder.generateRequests()).toEqual([]);
      expect(await entries(path.join(folder, OUTPUT_DIR, 'runs'))).toEqual([]);
    },
    BUDGET_MS,
  );

  it(
    '001 SC-001 step 3: swap exits 1, the decision summary starts with the Japanese script-ja cell and report.md says which rule, language and prompt sentence blocked',
    async () => {
      const cli = await runCli([...SWAP], folder);
      expect(cli.code).toBe(1);
      const ruleIds = await ruleIdsOfExample();
      const summaryAt = cli.stdout.indexOf(message('en', 'human.summary'));
      expect(summaryAt).toBeGreaterThanOrEqual(0);
      expect(ruleOrder(cli.stdout.slice(summaryAt), ruleIds)[0]).toBe('script-ja');

      const outputDir = path.join(folder, OUTPUT_DIR);
      const [comparisonId, ...others] = await entries(path.join(outputDir, 'comparisons'));
      expect(others).toEqual([]);
      if (comparisonId === undefined) {
        throw new Error('the swap wrote no comparison');
      }
      const { comparison, reportMarkdown } = await readComparison(outputDir, comparisonId);
      expect(comparison.gate.outcome).toBe('block');
      expect(comparison.gate.blocking).toEqual([
        { ruleId: 'script-ja', lang: 'ja', surface: 'raw' },
      ]);
      expect(comparison.summary.worse[0]).toMatchObject({ ruleId: 'script-ja', lang: 'ja' });
      expect(ruleOrder(reportMarkdown, ruleIds)[0]).toBe('script-ja');
      expect(reportMarkdown).toContain(SCRIPT_JA_QUOTE);
      expect(cli.stdout).toContain(
        path.join(OUTPUT_DIR, 'comparisons', comparisonId, 'report.html'),
      );
    },
    BUDGET_MS,
  );

  it(
    '001 FR-031 the swap also writes report.html and the output index.html from the built template',
    async () => {
      const outputDir = path.join(folder, OUTPUT_DIR);
      const [comparisonId] = await entries(path.join(outputDir, 'comparisons'));
      if (comparisonId === undefined) {
        throw new Error('the swap wrote no comparison');
      }
      const { comparison, dir } = await readComparison(outputDir, comparisonId);
      const template = await readFile(path.join(ROOT, 'dist/viewer/report.html'), 'utf8');
      const emptyTemplate = template.replace(DATA_PLACEHOLDER, '');
      const page = await readPage(path.join(dir, 'report.html'));
      expect(page.data).toEqual(comparisonPage(comparison, 'en'));
      expect(page.frame).toBe(emptyTemplate);
      const index = await readPage(path.join(outputDir, 'index.html'));
      expect(index.data).toEqual(await listPage(outputDir, 'en'));
      expect(index.frame).toBe(emptyTemplate);
      expect(listPageSchema.parse(index.data).comparisons).toEqual([
        expect.objectContaining({
          comparisonId,
          href: `comparisons/${comparisonId}/report.html`,
          gate: 'block',
        }),
      ]);
    },
    BUDGET_MS,
  );

  it('001 SC-006 the steps together finish within 3 minutes', () => {
    expect(Date.now() - startedAt).toBeLessThan(BUDGET_MS);
  });
});

const replySchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().nullable(),
  result: z.unknown().optional(),
  error: z.object({ code: z.int(), message: z.string() }).optional(),
});

type Reply = z.infer<typeof replySchema>;

/** Sends lines to the example adapter, closes its stdin and collects what it wrote to stdout. */
function exchange(lines: readonly string[]): Promise<{ code: number | null; replies: Reply[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(EXAMPLE, 'adapter.mjs')], { stdio: 'pipe' });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      resolve({
        code,
        replies: text
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => replySchema.parse(JSON.parse(line))),
      });
    });
    child.stdin.end(lines.map((line) => `${line}\n`).join(''));
  });
}

describe('001 example adapter examples/pogo/adapter.mjs', () => {
  it(
    '001 SC-001 answers a line it cannot read with a JSON-RPC error and keeps serving',
    async () => {
      const { code, replies } = await exchange([
        'not json',
        '[1, 2]',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'toString' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown' }),
      ]);
      // The id each reply carries, with its JSON-RPC error code or its result.
      expect(
        replies.map((reply) =>
          reply.error === undefined
            ? { id: reply.id, result: reply.result }
            : { id: reply.id, error: reply.error.code },
        ),
      ).toEqual([
        { id: null, error: -32700 },
        { id: null, error: -32600 },
        { id: 1, error: -32601 },
        { id: 2, result: null },
      ]);
      expect(code).toBe(0);
    },
    BUDGET_MS,
  );
});
