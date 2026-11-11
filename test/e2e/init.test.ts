import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import { envelopeSchema, resultSchemas } from '../../src/cli/results.js';
import { message } from '../../src/messages/index.js';
import { runCli, type CliResult } from './support/cli.js';
import { E2E } from './support/commands.js';
import { parseLintEnvelope, schemaErrors } from './support/outputs.js';
import type { ConfigInput } from './support/project.js';

// User Story 3, acceptance scenario 2 without `--adapter`: `model-eval init` in an empty folder,
// and next to a config of the user's own (contracts/cli.md §Commands, FR-033).

const CONFIG = 'model-eval.config.yaml';
const RULES = 'rules/example.yaml';
const CASES = 'cases/example.yaml';
const CREATED = [CONFIG, RULES, CASES];
const IGNORE_ENTRY = '.model-eval/';

const initEnvelopeSchema = envelopeSchema('init').extend({
  result: resultSchemas.init.nullable(),
});

const folders: string[] = [];

afterAll(async () => {
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function emptyFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-init-'));
  folders.push(folder);
  return folder;
}

/** The `init --json` document on stdout, checked against `schemas/init.schema.json`. */
function initEnvelope(cli: CliResult) {
  const value: unknown = JSON.parse(cli.stdout);
  expect(schemaErrors('init.schema.json', value)).toEqual([]);
  return initEnvelopeSchema.parse(value);
}

/** A valid config of the user's own, with some keys set. */
function configWith(overrides: Partial<ConfigInput>): string {
  const config: ConfigInput = {
    version: 1,
    adapter: { command: ['node', 'adapter.mjs'] },
    variants: [{ id: 'current', model: 'model-a' }],
    pricing: { 'model-a': { input: 1, output: 2 } },
    ...overrides,
  };
  return stringify(config);
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

describe('001 init', () => {
  it(
    '001 FR-033 in an empty folder init creates the config template, example rules and cases and ignores the output directory',
    async () => {
      const folder = await emptyFolder();
      const cli = await runCli(['init', '--json'], folder);
      expect(cli.code).toBe(0);
      const envelope = initEnvelope(cli);
      expect(envelope).toEqual({
        schemaVersion: '1',
        command: 'init',
        exit: { code: 0, name: 'ok' },
        result: { created: CREATED, gitignoreUpdated: true },
        warnings: [],
      });
      for (const file of CREATED) {
        expect((await readFile(path.join(folder, file), 'utf8')).length).toBeGreaterThan(0);
      }
      expect(lines(await readFile(path.join(folder, '.gitignore'), 'utf8'))).toEqual([
        IGNORE_ENTRY,
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 lint --no-adapter passes on what init created, without errors or warnings',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init'], folder)).code).toBe(0);
      const cli = await runCli(['lint', '--no-adapter', '--json'], folder);
      expect(cli.code).toBe(0);
      const envelope = parseLintEnvelope(cli.stdout);
      expect(envelope.exit).toEqual({ code: 0, name: 'ok' });
      expect(envelope.result?.errors).toEqual([]);
      expect(envelope.warnings).toEqual([]);
      const strict = await runCli(['lint', '--no-adapter', '--max-warnings', '0'], folder);
      expect(strict.code).toBe(0);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 with an existing config init keeps it, writes no example files and does not repeat the ignore entry',
    async () => {
      const folder = await emptyFolder();
      expect((await runCli(['init'], folder)).code).toBe(0);
      const edited = `${await readFile(path.join(folder, CONFIG), 'utf8')}# edited by hand\n`;
      await writeFile(path.join(folder, CONFIG), edited);
      // The user renamed the example files; init must not bring them back.
      await rename(path.join(folder, RULES), path.join(folder, 'rules/base.yaml'));
      await rename(path.join(folder, CASES), path.join(folder, 'cases/base.yaml'));
      const cli = await runCli(['init', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({ created: [], gitignoreUpdated: false });
      expect(await readFile(path.join(folder, CONFIG), 'utf8')).toBe(edited);
      expect(await readdir(path.join(folder, 'rules'))).toEqual(['base.yaml']);
      expect(await readdir(path.join(folder, 'cases'))).toEqual(['base.yaml']);
      expect(lines(await readFile(path.join(folder, '.gitignore'), 'utf8'))).toEqual([
        IGNORE_ENTRY,
      ]);
    },
    E2E.timeout,
  );

  it(
    "001 FR-033 with an existing config init ignores that config's output.dir and writes nothing else",
    async () => {
      const folder = await emptyFolder();
      await mkdir(path.join(folder, 'eval'));
      await writeFile(
        path.join(folder, 'eval', CONFIG),
        configWith({ output: { dir: 'out/runs' } }),
      );
      const cli = await runCli(['init', '--config', `eval/${CONFIG}`, '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({ created: [], gitignoreUpdated: true });
      expect(lines(await readFile(path.join(folder, 'eval/.gitignore'), 'utf8'))).toEqual([
        'out/runs/',
      ]);
      expect((await readdir(path.join(folder, 'eval'))).sort()).toEqual(['.gitignore', CONFIG]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 an output.dir outside the config folder is not added, and init says so',
    async () => {
      const folder = await emptyFolder();
      await writeFile(path.join(folder, CONFIG), configWith({ output: { dir: '../shared-out' } }));
      const cli = await runCli(['init'], folder);
      expect(cli.code).toBe(0);
      expect(lines(cli.stdout)).toEqual([
        message('en', 'human.init.kept', { path: CONFIG }),
        message('en', 'human.init.outsideFolder', { dir: '../shared-out', path: '.gitignore' }),
      ]);
      expect(await readdir(folder)).toEqual([CONFIG]);
      const json = await runCli(['init', '--json'], folder);
      expect(initEnvelope(json).result).toEqual({ created: [], gitignoreUpdated: false });
    },
    E2E.timeout,
  );

  it(
    '001 FR-034 an output.dir that is the config folder itself is named as . in the notice',
    async () => {
      const folder = await emptyFolder();
      await writeFile(path.join(folder, CONFIG), configWith({ output: { dir: '.' } }));
      const cli = await runCli(['init'], folder);
      expect(cli.code).toBe(0);
      expect(lines(cli.stdout)).toEqual([
        message('en', 'human.init.kept', { path: CONFIG }),
        message('en', 'human.init.outsideFolder', { dir: '.', path: '.gitignore' }),
      ]);
      expect(await readdir(folder)).toEqual([CONFIG]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-034 with --config in a subfolder the notice names the output directory and .gitignore from the working folder',
    async () => {
      const folder = await emptyFolder();
      await mkdir(path.join(folder, 'eval'));
      await writeFile(
        path.join(folder, 'eval', CONFIG),
        configWith({ output: { dir: '../shared-out' } }),
      );
      const cli = await runCli(['init', '--config', `eval/${CONFIG}`], folder);
      expect(cli.code).toBe(0);
      expect(lines(cli.stdout)).toEqual([
        message('en', 'human.init.kept', { path: `eval/${CONFIG}` }),
        message('en', 'human.init.outsideFolder', { dir: 'shared-out', path: 'eval/.gitignore' }),
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 an existing config that cannot be loaded ends init with exit 4 and the loader findings, writing nothing',
    async () => {
      const folder = await emptyFolder();
      const broken = configWith({}).replace('version: 1', 'version: 2');
      await writeFile(path.join(folder, CONFIG), broken);
      const cli = await runCli(['init', '--json'], folder);
      expect(cli.code).toBe(4);
      expect(initEnvelope(cli)).toEqual({
        schemaVersion: '1',
        command: 'init',
        exit: { code: 4, name: 'config-error' },
        result: null,
        warnings: [],
      });
      expect(cli.stderr).toContain(message('en', 'human.configInvalid.one'));
      expect(cli.stderr).toContain(`${CONFIG}:1:`);
      expect(await readdir(folder)).toEqual([CONFIG]);
      expect(await readFile(path.join(folder, CONFIG), 'utf8')).toBe(broken);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 a .gitignore line that already ignores the output directory in another spelling is kept as the only entry',
    async () => {
      for (const spelling of [
        '.model-eval',
        '.model-eval/',
        '/.model-eval',
        '/.model-eval/',
        '**/.model-eval',
        '**/.model-eval/',
      ]) {
        const folder = await emptyFolder();
        const ignore = `node_modules/\r\n${spelling}\r\n`;
        await writeFile(path.join(folder, '.gitignore'), ignore);
        const cli = await runCli(['init', '--json'], folder);
        expect(cli.code, spelling).toBe(0);
        expect(initEnvelope(cli).result?.gitignoreUpdated, spelling).toBe(false);
        expect(await readFile(path.join(folder, '.gitignore'), 'utf8'), spelling).toBe(ignore);
      }
    },
    E2E.timeout,
  );

  it(
    "001 FR-034 without --lang init speaks the existing config's lang, and --lang wins",
    async () => {
      const folder = await emptyFolder();
      await writeFile(path.join(folder, CONFIG), configWith({ lang: 'ko' }));
      const ko = await runCli(['init'], folder);
      expect(ko.code).toBe(0);
      expect(lines(ko.stdout)).toEqual([
        message('ko', 'human.init.kept', { path: CONFIG }),
        message('ko', 'human.init.ignored', { entry: IGNORE_ENTRY, path: '.gitignore' }),
      ]);
      const en = await runCli(['init', '--lang', 'en'], folder);
      expect(lines(en.stdout)).toEqual([
        message('en', 'human.init.kept', { path: CONFIG }),
        message('en', 'human.init.alreadyIgnored', { entry: IGNORE_ENTRY, path: '.gitignore' }),
      ]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 init adds the entry to an existing .gitignore after its last line and creates only missing files',
    async () => {
      const folder = await emptyFolder();
      await writeFile(path.join(folder, '.gitignore'), 'node_modules/\n*.log');
      await mkdir(path.join(folder, 'rules'));
      const ownRules = 'rules: []\n';
      await writeFile(path.join(folder, RULES), ownRules);
      const cli = await runCli(['init', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({
        created: [CONFIG, CASES],
        gitignoreUpdated: true,
      });
      expect(await readFile(path.join(folder, RULES), 'utf8')).toBe(ownRules);
      expect(await readFile(path.join(folder, '.gitignore'), 'utf8')).toBe(
        `node_modules/\n*.log\n${IGNORE_ENTRY}\n`,
      );
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 with --config init writes the files and the ignore entry next to that config',
    async () => {
      const folder = await emptyFolder();
      const cli = await runCli(['init', '--config', 'eval/checks.yaml', '--json'], folder);
      expect(cli.code).toBe(0);
      expect(initEnvelope(cli).result).toEqual({
        created: ['eval/checks.yaml', 'eval/rules/example.yaml', 'eval/cases/example.yaml'],
        gitignoreUpdated: true,
      });
      expect(lines(await readFile(path.join(folder, 'eval/.gitignore'), 'utf8'))).toEqual([
        IGNORE_ENTRY,
      ]);
      const lint = await runCli(['lint', '--no-adapter', '--config', 'eval/checks.yaml'], folder);
      expect(lint.code).toBe(0);
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 a file that cannot be written ends init with exit 4, no result and a message',
    async () => {
      const folder = await emptyFolder();
      // A regular file where the config folder should be: no directory can be made there.
      await writeFile(path.join(folder, 'eval'), 'not a folder\n');
      const cli = await runCli(['init', '--config', 'eval/checks.yaml', '--json'], folder);
      expect(cli.code).toBe(4);
      expect(initEnvelope(cli)).toEqual({
        schemaVersion: '1',
        command: 'init',
        exit: { code: 4, name: 'config-error' },
        result: null,
        warnings: [],
      });
      expect(cli.stderr).toContain(message('en', 'cli.init.writeFailed', { detail: '' }).trim());
      expect(cli.stderr).not.toContain(
        message('en', 'cli.init.createdBeforeFailure', { paths: '' }).trim(),
      );
      expect(await readFile(path.join(folder, 'eval'), 'utf8')).toBe('not a folder\n');
    },
    E2E.timeout,
  );

  it(
    '001 FR-033 a write that fails after some files were created names those files in the exit 4 message',
    async () => {
      const folder = await emptyFolder();
      // A folder where .gitignore should be: the template files are written, the entry is not.
      await mkdir(path.join(folder, '.gitignore'));
      const cli = await runCli(['init', '--json'], folder);
      expect(cli.code).toBe(4);
      expect(initEnvelope(cli).result).toBeNull();
      expect(cli.stderr).toContain(
        message('en', 'cli.init.createdBeforeFailure', { paths: CREATED.join(', ') }),
      );
    },
    E2E.timeout,
  );

  it(
    '001 FR-034 human output names each created file and the ignore entry, in English and in Korean',
    async () => {
      const english = await emptyFolder();
      const en = await runCli(['init'], english);
      expect(en.code).toBe(0);
      expect(lines(en.stdout)).toEqual([
        ...CREATED.map((file) => message('en', 'human.init.created', { path: file })),
        message('en', 'human.init.ignored', { entry: IGNORE_ENTRY, path: '.gitignore' }),
        message('en', 'human.init.next', { config: CONFIG }),
      ]);
      const again = await runCli(['init'], english);
      expect(lines(again.stdout)).toEqual([
        message('en', 'human.init.kept', { path: CONFIG }),
        message('en', 'human.init.alreadyIgnored', { entry: IGNORE_ENTRY, path: '.gitignore' }),
      ]);

      const korean = await emptyFolder();
      const ko = await runCli(['init', '--lang', 'ko'], korean);
      expect(ko.code).toBe(0);
      expect(lines(ko.stdout)).toEqual([
        ...CREATED.map((file) => message('ko', 'human.init.created', { path: file })),
        message('ko', 'human.init.ignored', { entry: IGNORE_ENTRY, path: '.gitignore' }),
        message('ko', 'human.init.next', { config: CONFIG }),
      ]);
      expect(ko.stdout).not.toBe(en.stdout);
    },
    E2E.timeout,
  );
});
