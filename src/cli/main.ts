import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { Lang } from '../config/schema.js';
import { isLang, message, type MessageKey, type MessageParams } from '../messages/index.js';
import { createRedactor } from '../report/redact.js';
import { EXIT_CODES, type ExitCode, type ExitName } from './exit-codes.js';
import { colorEnabled, createOutput, type Output, type TextStream } from './output.js';
import { COMMANDS, type Command } from './results.js';

export const DEFAULT_CONFIG_PATH = 'model-eval.config.yaml';

export interface CliContext {
  readonly version: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: TextStream;
  readonly stderr: TextStream;
}

export interface CommonOptions {
  readonly config: string;
  readonly json: boolean;
  readonly lang: Lang | undefined;
  readonly verbose: boolean;
  readonly noColor: boolean;
}

type OptionSpecs = NonNullable<ParseArgsConfig['options']>;
type OptionValue = string | boolean | (string | boolean)[] | undefined;

export interface CommandInvocation {
  readonly context: CliContext;
  readonly common: CommonOptions;
  readonly output: Output;
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
}

export interface CommandHandler {
  readonly options: OptionSpecs;
  run(invocation: CommandInvocation): Promise<ExitName>;
}

export const COMMAND_HANDLERS: Partial<Record<Command, CommandHandler>> = {};

const COMMON_OPTIONS = {
  config: { type: 'string', default: DEFAULT_CONFIG_PATH },
  json: { type: 'boolean', default: false },
  lang: { type: 'string' },
  verbose: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
} as const satisfies OptionSpecs;

const TOP_LEVEL_OPTIONS = {
  ...COMMON_OPTIONS,
  version: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies OptionSpecs;

/** Common options that take a value, so the word after them is not the command. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['--config', '--lang']);

interface Scan {
  /** Index of the command word in argv, if any. */
  readonly commandIndex: number | undefined;
  readonly json: boolean;
  readonly noColor: boolean;
  readonly lang: string | undefined;
}

/**
 * Finds the command word and the options that shape error output before full parsing, so a
 * usage error still honours `--json`, `--no-color` and `--lang` wherever they appear.
 */
function scan(argv: readonly string[]): Scan {
  let commandIndex: number | undefined;
  let json = false;
  let noColor = false;
  let lang: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      break;
    }
    if (arg.startsWith('--lang=')) {
      lang = arg.slice('--lang='.length);
    } else if (VALUE_OPTIONS.has(arg)) {
      if (arg === '--lang') {
        lang = argv[index + 1];
      }
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-color') {
      noColor = true;
    } else if (!arg.startsWith('-') && commandIndex === undefined) {
      commandIndex = index;
    }
  }
  return { commandIndex, json, noColor, lang };
}

type Parsed =
  | { ok: true; values: Record<string, OptionValue>; positionals: string[] }
  | { ok: false; detail: string };

function parse(args: readonly string[], options: OptionSpecs): Parsed {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals: true,
      strict: true,
    });
    return { ok: true, values, positionals };
  } catch (error) {
    return { ok: false, detail: describe(error) };
  }
}

function isCommand(value: string): value is Command {
  return COMMANDS.some((command) => command === value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commonOptions(
  values: Readonly<Record<string, OptionValue>>,
  lang: Lang | undefined,
): CommonOptions {
  const config = values.config;
  return {
    config: typeof config === 'string' ? config : DEFAULT_CONFIG_PATH,
    json: values.json === true,
    lang,
    verbose: values.verbose === true,
    noColor: values['no-color'] === true,
  };
}

export async function main(context: CliContext): Promise<ExitCode> {
  const { argv } = context;
  const found = scan(argv);
  const word = found.commandIndex === undefined ? undefined : argv[found.commandIndex];
  const command = word !== undefined && isCommand(word) ? word : undefined;
  const messageLang: Lang = found.lang !== undefined && isLang(found.lang) ? found.lang : 'en';
  const output = createOutput({
    json: found.json,
    color: colorEnabled({ noColorFlag: found.noColor, env: context.env, stream: context.stdout }),
    redactor: createRedactor([]),
    stdout: context.stdout,
    stderr: context.stderr,
  });

  const fail = (exit: ExitName, key: MessageKey, params?: MessageParams): ExitCode => {
    output.progress(message(messageLang, key, params));
    if (!output.envelopeWritten) {
      output.envelopeWithoutResult(command ?? null, exit, []);
    }
    return EXIT_CODES[exit];
  };

  const handler = command === undefined ? undefined : COMMAND_HANDLERS[command];
  const rest =
    found.commandIndex === undefined
      ? argv
      : argv.filter((_arg, index) => index !== found.commandIndex);
  const parsed = parse(
    rest,
    handler === undefined ? TOP_LEVEL_OPTIONS : { ...COMMON_OPTIONS, ...handler.options },
  );
  if (!parsed.ok) {
    return fail('config-error', 'cli.invalidOptions', { detail: parsed.detail });
  }
  if (found.lang !== undefined && !isLang(found.lang)) {
    return fail('config-error', 'cli.invalidLang', { value: found.lang });
  }
  const lang = found.lang !== undefined && isLang(found.lang) ? found.lang : undefined;

  if (word === undefined) {
    if (parsed.values.version === true) {
      context.stdout.write(`${context.version}\n`);
      return EXIT_CODES.ok;
    }
    if (parsed.values.help === true) {
      context.stdout.write(`${message(messageLang, 'cli.usage')}\n`);
      return EXIT_CODES.ok;
    }
    return fail('config-error', 'cli.missingCommand');
  }
  if (command === undefined) {
    return fail('config-error', 'cli.unknownCommand', { command: word });
  }
  if (handler === undefined) {
    return fail('config-error', 'cli.unavailableCommand', { command });
  }
  try {
    const exit = await handler.run({
      context,
      common: commonOptions(parsed.values, lang),
      output,
      values: parsed.values,
      positionals: parsed.positionals,
    });
    return EXIT_CODES[exit];
  } catch (error) {
    return fail('internal-error', 'cli.internalError', { detail: describe(error) });
  }
}
