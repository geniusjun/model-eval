import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { envelopeSchema, resultSchemas } from '../../src/cli/results.js';
import { BUNDLED_HELPER_VERSION } from '../../src/lint/helper-version.js';
import { message } from '../../src/messages/index.js';
import { ROOT, runCli, type CliResult } from './support/cli.js';
import { E2E } from './support/commands.js';
import { parseLintEnvelope, schemaErrors } from './support/outputs.js';

// User Story 3, acceptance scenario 2 with `--adapter`: `model-eval init --adapter python|node`
// writes an adapter skeleton that uses the feature 003 helper, for Python with the helper file
// next to it, and lint passes on what it wrote (contracts/cli.md §Commands, FR-033, FR-035).
// The Python skeleton starts with the `python3` on PATH, 3.10 or newer.

const CONFIG = 'model-eval.config.yaml';
const EXAMPLES = [CONFIG, 'rules/example.yaml', 'cases/example.yaml'];
const PYTHON_HELPER = path.join(ROOT, 'adapters/python/model_eval_adapter.py');

const initEnvelopeSchema = envelopeSchema('init').extend({
  result: resultSchemas.init.nullable(),
});

const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function emptyFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-init-adapter-'));
  folders.push(folder);
  return folder;
}

/** The `init --json` document on stdout, checked against `schemas/init.schema.json`. */
function initEnvelope(cli: CliResult) {
  const value: unknown = JSON.parse(cli.stdout);
  expect(schemaErrors('init.schema.json', value)).toEqual([]);
  return initEnvelopeSchema.parse(value);
}

/** Makes `model-eval/adapter` resolve from the folder, as installing the tool there would. */
async function installTool(folder: string): Promise<void> {
  await mkdir(path.join(folder, 'node_modules'));
  await symlink(ROOT, path.join(folder, 'node_modules', 'model-eval'), 'dir');
}

async function lintPasses(folder: string): Promise<void> {
  const cli = await runCli(['lint', '--json'], folder);
  const envelope = parseLintEnvelope(cli.stdout);
  expect(envelope.exit, cli.stderr).toEqual({ code: 0, name: 'ok' });
  expect(envelope.result?.errors).toEqual([]);
  expect(envelope.warnings).toEqual([]);
}

describe('001 init --adapter', () => {
  it(
    '001 FR-033 init --adapter python writes the config, examples, a skeleton that uses the helper and the helper file next to it',
    async () => {
      const folder = await emptyFolder();
      const cli = await runCli(['init', '--adapter', 'python', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({
        created: [...EXAMPLES, 'adapter.py', 'model_eval_adapter.py'],
        gitignoreUpdated: true,
      });
      const config = await readFile(path.join(folder, CONFIG), 'utf8');
      expect(config).toMatch(/^ {2}command: \[python3, adapter\.py\] +#/mu);
      const skeleton = await readFile(path.join(folder, 'adapter.py'), 'utf8');
      expect(skeleton).toContain('from model_eval_adapter import Adapter');
      expect(await readFile(path.join(folder, 'model_eval_adapter.py'), 'utf8')).toBe(
        await readFile(PYTHON_HELPER, 'utf8'),
      );
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 init --adapter node writes the config, examples and a skeleton that uses model-eval/adapter',
    async () => {
      const folder = await emptyFolder();
      const cli = await runCli(['init', '--adapter', 'node', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({
        created: [...EXAMPLES, 'adapter.mjs'],
        gitignoreUpdated: true,
      });
      const config = await readFile(path.join(folder, CONFIG), 'utf8');
      expect(config).toMatch(/^ {2}command: \[node, adapter\.mjs\] +#/mu);
      const skeleton = await readFile(path.join(folder, 'adapter.mjs'), 'utf8');
      expect(skeleton).toContain("import { defineAdapter } from 'model-eval/adapter';");
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 lint passes on the Python skeleton init wrote',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init', '--adapter', 'python'], folder)).code).toBe(0);
      await lintPasses(folder);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 lint passes on the Node skeleton init wrote, with the tool installed in the folder',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init', '--adapter', 'node'], folder)).code).toBe(0);
      await installTool(folder);
      await lintPasses(folder);
    },
    E2E.timeout,
  );

  it(
    '001 FR-035 an older copied Python helper gives helper-outdated, and init keeps that copy',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init', '--adapter', 'python'], folder)).code).toBe(0);
      const helperFile = path.join(folder, 'model_eval_adapter.py');
      const helper = await readFile(helperFile, 'utf8');
      const older = helper.replace(/^HELPER_VERSION = ".*"$/mu, 'HELPER_VERSION = "0.0.1"');
      expect(older).not.toBe(helper);
      await writeFile(helperFile, older);
      const again = await runCli(['init', '--adapter', 'python', '--json'], folder);
      expect(initEnvelope(again).result).toEqual({ created: [], gitignoreUpdated: false });
      expect(await readFile(helperFile, 'utf8')).toBe(older);
      const cli = await runCli(['lint', '--json'], folder);
      expect(cli.code).toBe(0);
      const warnings = parseLintEnvelope(cli.stdout).warnings;
      expect(warnings.filter((warning) => warning.code === 'helper-outdated')).toMatchObject([
        { code: 'helper-outdated', params: { version: '0.0.1', bundled: BUNDLED_HELPER_VERSION } },
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 with an existing config init --adapter keeps it and writes the skeleton next to it',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init'], folder)).code).toBe(0);
      const config = await readFile(path.join(folder, CONFIG), 'utf8');
      const cli = await runCli(['init', '--adapter', 'node'], folder);
      expect(cli.code).toBe(0);
      expect(cli.stdout.split('\n').filter((line) => line !== '')).toEqual([
        message('en', 'human.init.kept', { path: CONFIG }),
        message('en', 'human.init.created', { path: 'adapter.mjs' }),
        message('en', 'human.init.alreadyIgnored', { path: '.gitignore', entry: '.model-eval/' }),
        message('en', 'human.init.nextAdapter.node', { file: 'adapter.mjs', config: CONFIG }),
      ]);
      expect(await readFile(path.join(folder, CONFIG), 'utf8')).toBe(config);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 with a new config, init --adapter names every file and ends with the next step for that language',
    async () => {
      for (const [language, created] of [
        ['python', ['adapter.py', 'model_eval_adapter.py']],
        ['node', ['adapter.mjs']],
      ] as const) {
        const folder = await emptyFolder();
        const cli = await runCli(['init', '--adapter', language], folder);
        expect(cli.code).toBe(0);
        const key =
          language === 'python' ? 'human.init.nextAdapter.python' : 'human.init.nextAdapter.node';
        expect(cli.stdout.split('\n').filter((line) => line !== '')).toEqual([
          ...[...EXAMPLES, ...created].map((file) =>
            message('en', 'human.init.created', { path: file }),
          ),
          message('en', 'human.init.ignored', { path: '.gitignore', entry: '.model-eval/' }),
          message('en', key, { file: created[0], config: CONFIG }),
        ]);
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 init --adapter keeps a skeleton that exists and writes only what is missing',
    async () => {
      const folder = await emptyFolder();
      const own = '# my adapter\n';
      await writeFile(path.join(folder, 'adapter.py'), own);
      const cli = await runCli(['init', '--adapter', 'python', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({
        created: [...EXAMPLES, 'model_eval_adapter.py'],
        gitignoreUpdated: true,
      });
      expect(await readFile(path.join(folder, 'adapter.py'), 'utf8')).toBe(own);
    },
    E2E.timeout,
  );

  it(
    '001 FR-030 init --adapter with a language other than python or node exits 4 and writes nothing',
    async () => {
      const folder = await emptyFolder();
      const cli = await runCli(['init', '--adapter', 'ruby', '--json'], folder);
      expect(cli.code).toBe(4);
      expect(initEnvelope(cli).exit).toEqual({ code: 4, name: 'config-error' });
      expect(cli.stderr).toContain(message('en', 'cli.init.unknownAdapter', { value: 'ruby' }));
      expect(await readdir(folder)).toEqual([]);
    },
    E2E.timeout,
  );
});
