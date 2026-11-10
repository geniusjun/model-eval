import { styleText } from 'node:util';

import type { Redactor } from '../report/redact.js';
import { SCHEMA_VERSION } from '../report/schema.js';
import { exitStatus, type ExitName } from './exit-codes.js';
import type { Command, CommandResult, Envelope, EnvelopeWarning } from './results.js';

export interface TextStream {
  write(chunk: string): unknown;
  readonly isTTY?: boolean | undefined;
}

export type Style = Parameters<typeof styleText>[0];

export interface OutputOptions {
  readonly json: boolean;
  readonly color: boolean;
  readonly redactor: Redactor;
  readonly stdout: TextStream;
  readonly stderr: TextStream;
}

/**
 * Parts of an envelope that went through the config's `redact` rules already, as a Comparison
 * does when it is built; they are written as they are, so no free text is redacted twice.
 */
export interface RedactedParts {
  /** The whole `result`: a Comparison and the IDs beside it. */
  readonly result?: boolean;
  /** Warnings written after the others, as they are. */
  readonly warnings?: readonly EnvelopeWarning[];
}

/**
 * Every write goes through redaction exactly once (FR-031); `--json` keeps stdout for one
 * envelope.
 */
export interface Output {
  readonly json: boolean;
  /** Whether this command's envelope has been written. */
  readonly envelopeWritten: boolean;
  /** Applies the config's `redact` rules to every later write, once a command has loaded them. */
  setRedactor(redactor: Redactor): void;
  /** Human result lines on stdout; dropped under `--json`, where the envelope carries the result. */
  print(line: string): void;
  /** Like {@link print}, for a line made from text that went through redaction already. */
  printRedacted(line: string): void;
  /** Progress and diagnostics on stderr, in both modes. */
  progress(line: string): void;
  /** Redacts before styling, so colour codes never split a redaction pattern. */
  style(format: Style, text: string): string;
  envelope<C extends Command>(
    command: C,
    exit: ExitName,
    result: CommandResult<C> | null,
    warnings: readonly EnvelopeWarning[],
    redacted?: RedactedParts,
  ): void;
  /** For usage and internal errors, where there is no result and maybe no known command. */
  envelopeWithoutResult(
    command: Command | null,
    exit: ExitName,
    warnings: readonly EnvelopeWarning[],
  ): void;
}

export interface ColorInputs {
  readonly noColorFlag: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stream: TextStream;
}

/** `--no-color`, a non-empty `NO_COLOR` or a stream that is not a terminal turn colour off. */
export function colorEnabled({ noColorFlag, env, stream }: ColorInputs): boolean {
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  return !noColorFlag && !noColorEnv && stream.isTTY === true;
}

export function createOutput(options: OutputOptions): Output {
  const { json, color, stdout, stderr } = options;
  let { redactor } = options;
  let envelopeWritten = false;
  const writeEnvelope = (envelope: Envelope<Command | null>, redacted: RedactedParts): void => {
    if (!json) {
      return;
    }
    if (envelopeWritten) {
      throw new Error('the --json envelope is written once per command');
    }
    envelopeWritten = true;
    // The same fields as redacting the whole envelope, without the parts redacted already.
    const written = {
      ...envelope,
      result: redacted.result === true ? envelope.result : redactor.json(envelope.result),
      warnings: [
        ...envelope.warnings.map((warning) => redactor.json(warning)),
        ...(redacted.warnings ?? []),
      ],
    };
    stdout.write(`${JSON.stringify(written)}\n`);
  };
  const write = (line: string): void => {
    if (!json) {
      stdout.write(`${line}\n`);
    }
  };
  return {
    json,
    get envelopeWritten() {
      return envelopeWritten;
    },
    setRedactor(next) {
      redactor = next;
    },
    print(line) {
      write(redactor.text(line));
    },
    printRedacted(line) {
      write(line);
    },
    progress(line) {
      stderr.write(`${redactor.text(line)}\n`);
    },
    style(format, text) {
      const redacted = redactor.text(text);
      return color ? styleText(format, redacted, { validateStream: false }) : redacted;
    },
    envelope(command, exit, result, warnings, redacted = {}) {
      writeEnvelope(
        { schemaVersion: SCHEMA_VERSION, command, exit: exitStatus(exit), result, warnings },
        redacted,
      );
    },
    envelopeWithoutResult(command, exit, warnings) {
      writeEnvelope(
        { schemaVersion: SCHEMA_VERSION, command, exit: exitStatus(exit), result: null, warnings },
        {},
      );
    },
  };
}
