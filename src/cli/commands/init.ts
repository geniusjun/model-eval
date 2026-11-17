import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../../config/load.js';
import type { Lang } from '../../config/schema.js';
import { message, selectLang } from '../../messages/index.js';
import { createRedactor } from '../../report/redact.js';
import type { ExitName } from '../exit-codes.js';
import { initLines, type IgnoreState, type InitFile, type InitOutcome } from '../human/init.js';
import { diagnosticLines } from '../human/swap.js';
import type { CommandHandler, CommandInvocation } from '../main.js';
import {
  ADAPTER_SKELETONS,
  isAdapterLanguage,
  PYTHON_HELPER_FILE,
  type AdapterLanguage,
} from '../templates/adapter.js';
import { CASES_TEMPLATE } from '../templates/cases.js';
import { configTemplate, OUTPUT_DIR } from '../templates/config.js';
import { RULES_TEMPLATE } from '../templates/rules.js';
import { printAll } from './run-setup.js';

// `model-eval init [--adapter python|node]` (contracts/cli.md §Commands, FR-033). A new config
// comes with example rules and cases; an existing config is kept and only its `output.dir` is
// added to the `.gitignore` of the config folder. With `--adapter`, an adapter skeleton that uses
// the helper of feature 003 is written next to the config, and for Python the helper file the
// package ships next to it. Existing files are never overwritten.

/** The rule and case files go where the template's `files` globs look, from the config folder. */
const EXAMPLE_FILES = [
  { relative: 'rules/example.yaml', content: RULES_TEMPLATE },
  { relative: 'cases/example.yaml', content: CASES_TEMPLATE },
] as const;

/** The Python helper this package ships, from `dist/cli/commands/` and `src/cli/commands/`. */
const PYTHON_HELPER = new URL(`../../../adapters/python/${PYTHON_HELPER_FILE}`, import.meta.url);

/** A Node.js file system error, with a code such as `EEXIST`. */
type SystemError = Error & { readonly code: string };

function isSystemError(error: unknown): error is SystemError {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

/** Creates the file unless it exists; `false` when it existed. */
async function createFile(file: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, content, { flag: 'wx' });
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/** The `.gitignore` lines that ignore the folder `dir` below the `.gitignore` folder. */
function ignoreLines(dir: string): ReadonlySet<string> {
  return new Set(['', '/', '**/'].flatMap((prefix) => [`${prefix}${dir}`, `${prefix}${dir}/`]));
}

/** Appends `<dir>/` after the last line unless a line ignores the folder already. */
async function addIgnoreEntry(file: string, dir: string): Promise<IgnoreState> {
  const text = await readIfPresent(file);
  const ignoring = ignoreLines(dir);
  if (text.split(/\r?\n/u).some((line) => ignoring.has(line.trim()))) {
    return 'present';
  }
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${separator}${dir}/\n`);
  return 'added';
}

function isBelow(relative: string): boolean {
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function slashes(file: string): string {
  return file.split(path.sep).join('/');
}

/** What a start needs from the config: the output language and the output directory. */
interface ConfigUse {
  readonly lang: Lang;
  readonly outputDir: string;
}

type ExistingConfig =
  { readonly ok: true; readonly use: ConfigUse } | { readonly ok: false; readonly exit: ExitName };

/** Loads a config the user has, as other commands do; a config that does not load ends init. */
async function existingConfig(invocation: CommandInvocation): Promise<ExistingConfig> {
  const { common, context, output } = invocation;
  const startLang = common.lang ?? 'en';
  const loaded = await loadConfig(common.config, context.cwd, startLang);
  if (!loaded.ok) {
    for (const line of diagnosticLines(startLang, loaded.diagnostics)) {
      output.progress(line);
    }
    output.envelope('init', 'config-error', null, []);
    return { ok: false, exit: 'config-error' };
  }
  const { data } = loaded.config;
  output.setRedactor(createRedactor(data.redact));
  return {
    ok: true,
    use: { lang: selectLang(common.lang, data.lang), outputDir: loaded.paths.outputDir },
  };
}

/** The adapter skeleton and, for Python, the helper file: written next to the config file. */
async function adapterFiles(
  language: AdapterLanguage,
  configDir: string,
): Promise<{ readonly file: string; readonly created: boolean }[]> {
  const skeleton = ADAPTER_SKELETONS[language];
  // The helper is read first, so a package without it writes no skeleton either.
  const helper = language === 'python' ? await readFile(PYTHON_HELPER, 'utf8') : undefined;
  const skeletonFile = path.join(configDir, skeleton.file);
  const written = [
    { file: skeletonFile, created: await createFile(skeletonFile, skeleton.content) },
  ];
  if (helper !== undefined) {
    const helperFile = path.join(configDir, PYTHON_HELPER_FILE);
    written.push({ file: helperFile, created: await createFile(helperFile, helper) });
  }
  return written;
}

async function init(invocation: CommandInvocation): Promise<ExitName> {
  const { common, context, output, values } = invocation;
  const display = (file: string): string => slashes(path.relative(context.cwd, file)) || '.';
  const configFile = path.resolve(context.cwd, common.config);
  const configDir = path.dirname(configFile);
  const files: InitFile[] = [];
  let lang: Lang = common.lang ?? 'en';
  const adapter = values.adapter;
  if (typeof adapter === 'string' && !isAdapterLanguage(adapter)) {
    output.progress(message(lang, 'cli.init.unknownAdapter', { value: adapter }));
    output.envelope('init', 'config-error', null, []);
    return 'config-error';
  }
  const language = typeof adapter === 'string' && isAdapterLanguage(adapter) ? adapter : undefined;
  try {
    const command = language === undefined ? undefined : ADAPTER_SKELETONS[language].command;
    const newConfig = await createFile(configFile, configTemplate(command));
    files.push({ path: display(configFile), created: newConfig });
    let outputDir = path.resolve(configDir, OUTPUT_DIR);
    if (newConfig) {
      for (const { relative, content } of EXAMPLE_FILES) {
        const file = path.join(configDir, relative);
        files.push({ path: display(file), created: await createFile(file, content) });
      }
    } else {
      const existing = await existingConfig(invocation);
      if (!existing.ok) {
        return existing.exit;
      }
      ({ lang, outputDir } = existing.use);
    }
    if (language !== undefined) {
      for (const { file, created } of await adapterFiles(language, configDir)) {
        files.push({ path: display(file), created });
      }
    }
    const gitignore = path.join(configDir, '.gitignore');
    const relative = path.relative(configDir, outputDir);
    const outcome: InitOutcome = {
      files,
      gitignore: {
        path: display(gitignore),
        dir: slashes(relative),
        outputDir: display(outputDir),
        state: isBelow(relative) ? await addIgnoreEntry(gitignore, slashes(relative)) : 'outside',
      },
      templateConfig: newConfig ? display(configFile) : undefined,
      adapter:
        language === undefined
          ? undefined
          : {
              language,
              file: display(path.join(configDir, ADAPTER_SKELETONS[language].file)),
              config: display(configFile),
            },
    };
    printAll(invocation, initLines(lang, outcome));
    output.envelope(
      'init',
      'ok',
      {
        created: files.filter((file) => file.created).map((file) => file.path),
        gitignoreUpdated: outcome.gitignore.state === 'added',
      },
      [],
    );
    return 'ok';
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    output.progress(message(lang, 'cli.init.writeFailed', { detail: error.message }));
    const created = files.filter((file) => file.created).map((file) => file.path);
    if (created.length > 0) {
      output.progress(
        message(lang, 'cli.init.createdBeforeFailure', { paths: created.join(', ') }),
      );
    }
    output.envelope('init', 'config-error', null, []);
    return 'config-error';
  }
}

export const initCommand: CommandHandler = {
  options: {
    adapter: { type: 'string' },
  },
  run: init,
};
