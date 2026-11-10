import { describe, expect, it } from 'vitest';

import { EXIT_CODES, exitStatus, resolveExit } from '../../../src/cli/exit-codes.js';
import { COMMAND_HANDLERS, main, type CliContext } from '../../../src/cli/main.js';
import { colorEnabled, createOutput, type TextStream } from '../../../src/cli/output.js';
import { envelopeSchema } from '../../../src/cli/results.js';
import { CATALOGS, message, selectLang } from '../../../src/messages/index.js';
import { createRedactor } from '../../../src/report/redact.js';
import { cellNoteSchema } from '../../../src/report/schema.js';

interface Captured extends TextStream {
  readonly chunks: string[];
}

function capture(isTTY = false): Captured {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
}

const PHONE = createRedactor([{ pattern: '\\b01[0-9]-?\\d{3,4}-?\\d{4}\\b', replace: '<phone>' }]);

describe('--json envelope', () => {
  it('001 FR-030 writes exactly one envelope with schemaVersion to stdout and progress to stderr', () => {
    const stdout = capture();
    const stderr = capture();
    const output = createOutput({ json: true, color: false, redactor: PHONE, stdout, stderr });
    output.progress('sending 20 trials');
    output.print('human line that --json drops');
    output.envelope('report', 'ok', { comparisonId: 'cmp-0123456789ab' }, []);

    expect(stdout.chunks).toHaveLength(1);
    const parsed: unknown = JSON.parse(stdout.chunks[0] ?? '');
    const envelope = envelopeSchema('report').parse(parsed);
    expect(envelope).toEqual({
      schemaVersion: '1',
      command: 'report',
      exit: { code: 0, name: 'ok' },
      result: { comparisonId: 'cmp-0123456789ab' },
      warnings: [],
    });
    expect(stderr.chunks).toEqual(['sending 20 trials\n']);
    expect(() => {
      output.envelope('report', 'ok', { comparisonId: 'cmp-0123456789ab' }, []);
    }).toThrow();
  });

  it('001 FR-030 writes human lines to stdout without --json and no envelope', () => {
    const stdout = capture();
    const output = createOutput({
      json: false,
      color: false,
      redactor: PHONE,
      stdout,
      stderr: capture(),
    });
    output.print('Gate: pass');
    output.envelope('report', 'ok', { comparisonId: 'cmp-0123456789ab' }, []);
    expect(stdout.chunks).toEqual(['Gate: pass\n']);
  });
});

describe('exit codes', () => {
  it('001 FR-030 publishes the code of every exit name', () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      failed: 1,
      undecided: 2,
      'run-failed': 3,
      'config-error': 4,
      'over-budget': 5,
      'internal-error': 6,
    });
    expect(exitStatus('over-budget')).toEqual({ code: 5, name: 'over-budget' });
  });

  it('001 FR-030 resolves overlaps in the order 6, 4, 5, 3, 1, 2, 0', () => {
    expect(resolveExit(['undecided', 'failed'])).toBe('failed');
    expect(resolveExit(['failed', 'run-failed'])).toBe('run-failed');
    expect(resolveExit(['run-failed', 'over-budget'])).toBe('over-budget');
    expect(resolveExit(['over-budget', 'config-error', 'ok'])).toBe('config-error');
    expect(resolveExit(['config-error', 'internal-error'])).toBe('internal-error');
    expect(resolveExit(['ok', 'undecided'])).toBe('undecided');
    expect(resolveExit([])).toBe('ok');
  });
});

describe('messages', () => {
  it('001 FR-034 has the same keys in en.json and ko.json', () => {
    expect(Object.keys(CATALOGS.ko).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    for (const text of [...Object.values(CATALOGS.en), ...Object.values(CATALOGS.ko)]) {
      expect(text.trim()).not.toBe('');
    }
  });

  it('001 FR-034 uses the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
    for (const key of Object.keys(CATALOGS.en) as (keyof typeof CATALOGS.en)[]) {
      expect(placeholders(CATALOGS.ko[key])).toEqual(placeholders(CATALOGS.en[key]));
    }
  });

  it('001 FR-034 has the text of every cell note code in both languages', () => {
    for (const note of cellNoteSchema.options) {
      expect(message('en', `note.${note}`)).not.toBe(message('ko', `note.${note}`));
    }
  });

  it('001 FR-034 selects --lang, then the config lang, else en', () => {
    expect(selectLang('ko', 'en')).toBe('ko');
    expect(selectLang(undefined, 'ko')).toBe('ko');
    expect(selectLang(undefined, undefined)).toBe('en');
  });

  it('001 FR-034 fills placeholders and fails on a missing parameter', () => {
    expect(message('en', 'cli.unknownCommand', { command: 'swapp' })).toContain('"swapp"');
    expect(message('ko', 'cli.unknownCommand', { command: 'swapp' })).toContain('"swapp"');
    expect(message('en', 'cli.unknownCommand', { command: '$&' })).toContain('"$&"');
    expect(() => message('en', 'cli.unknownCommand')).toThrow();
  });
});

describe('redaction of stdout and stderr', () => {
  it('001 FR-031 redacts progress, human lines and the free text of the envelope', () => {
    const stdout = capture();
    const stderr = capture();
    const human = createOutput({ json: false, color: false, redactor: PHONE, stdout, stderr });
    human.print('call 010-1234-5678 now');
    human.progress('adapter said 01012345678');
    expect(stdout.chunks).toEqual(['call <phone> now\n']);
    expect(stderr.chunks).toEqual(['adapter said <phone>\n']);

    const jsonOut = capture();
    const json = createOutput({
      json: true,
      color: false,
      redactor: PHONE,
      stdout: jsonOut,
      stderr,
    });
    json.envelope(
      'lint',
      'failed',
      {
        errors: [
          {
            code: 'schema',
            file: 'cases/010-1234-5678.yaml',
            params: { path: 'cases[0].input', detail: 'bad 010-1234-5678' },
          },
        ],
        info: [],
      },
      [{ code: 'anchor-missing', params: { quote: 'call 010-9876-5432' }, caseIds: ['greet-ko'] }],
    );
    const written = JSON.parse(jsonOut.chunks[0] ?? '') as {
      result: { errors: { file: string; params: { detail: string } }[] };
      warnings: { params: { quote: string } }[];
    };
    expect(written.result.errors[0]?.params.detail).toBe('bad <phone>');
    expect(written.warnings[0]?.params.quote).toBe('call <phone>');
    expect(written.result.errors[0]?.file).toBe('cases/010-1234-5678.yaml');
  });

  it('001 FR-031 keeps $& in the replacement literal', () => {
    const redactor = createRedactor([{ pattern: 'secret', replace: '[$&]' }]);
    expect(redactor.text('a secret b')).toBe('a [$&] b');
    expect(
      redactor.json({ raw: 'secret', evidence: ['secret', 'x'], nested: { message: 'secret' } }),
    ).toEqual({
      raw: '[$&]',
      evidence: ['[$&]', 'x'],
      nested: { message: '[$&]' },
    });
  });

  it('001 FR-031 leaves identifiers, hashes, codes and model names as they are', () => {
    const redactor = createRedactor([{ pattern: 'next', replace: 'X' }]);
    const record = {
      caseId: 'next-ko',
      variant: { id: 'next', model: 'next-model' },
      code: 'next',
      raw: 'next time',
    };
    expect(redactor.json(record)).toEqual({ ...record, raw: 'X time' });
  });

  it('001 FR-031 inserts nothing for a zero-width match', () => {
    const redactor = createRedactor([{ pattern: '\\b(?:secret)?', replace: '<x>' }]);
    expect(redactor.text('a secret b')).toBe('a <x> b');
  });

  it('001 FR-031 leaves a cell note code as it is', () => {
    const redactor = createRedactor([{ pattern: 'drop', replace: 'X' }]);
    expect(redactor.json({ note: 'drop-within-margin', raw: 'drop' })).toEqual({
      note: 'drop-within-margin',
      raw: 'X',
    });
  });

  it('001 FR-031 switches to the config redaction rules once they are loaded', () => {
    const stderr = capture();
    const output = createOutput({
      json: false,
      color: false,
      redactor: createRedactor([]),
      stdout: capture(),
      stderr,
    });
    output.progress('call 010-1234-5678');
    output.setRedactor(PHONE);
    output.progress('call 010-1234-5678');
    expect(stderr.chunks).toEqual(['call 010-1234-5678\n', 'call <phone>\n']);
  });

  it('001 FR-031 redacts text before styling it', () => {
    const tty = capture(true);
    const output = createOutput({
      json: false,
      color: true,
      redactor: PHONE,
      stdout: tty,
      stderr: tty,
    });
    const styled = output.style('red', '010-1234-5678');
    expect(styled).toContain('<phone>');
    expect(styled).not.toContain('010-1234-5678');
  });
});

describe('colour', () => {
  it('001 FR-034 turns colour off with --no-color, NO_COLOR or a non-terminal stream', () => {
    const tty = capture(true);
    expect(colorEnabled({ noColorFlag: false, env: {}, stream: tty })).toBe(true);
    expect(colorEnabled({ noColorFlag: true, env: {}, stream: tty })).toBe(false);
    expect(colorEnabled({ noColorFlag: false, env: { NO_COLOR: '1' }, stream: tty })).toBe(false);
    expect(colorEnabled({ noColorFlag: false, env: { NO_COLOR: '' }, stream: tty })).toBe(true);
    expect(colorEnabled({ noColorFlag: false, env: {}, stream: capture(false) })).toBe(false);
    const plain = createOutput({
      json: false,
      color: false,
      redactor: PHONE,
      stdout: tty,
      stderr: tty,
    });
    expect(plain.style('red', 'x')).toBe('x');
    const coloured = createOutput({
      json: false,
      color: true,
      redactor: PHONE,
      stdout: tty,
      stderr: tty,
    });
    expect(coloured.style('red', 'x')).not.toBe('x');
  });
});

describe('command line frame', () => {
  function context(argv: string[]): CliContext & { stdout: Captured; stderr: Captured } {
    return { version: '9.9.9', argv, cwd: '/', env: {}, stdout: capture(), stderr: capture() };
  }

  it('001 FR-030 prints the version', async () => {
    const ctx = context(['--version']);
    expect(await main(ctx)).toBe(0);
    expect(ctx.stdout.chunks).toEqual(['9.9.9\n']);
  });

  it('001 FR-034 prints usage errors in the --lang language', async () => {
    const en = context(['nope']);
    expect(await main(en)).toBe(4);
    expect(en.stderr.chunks.join('')).toContain('Unknown command "nope"');
    const ko = context(['nope', '--lang', 'ko']);
    expect(await main(ko)).toBe(4);
    expect(ko.stderr.chunks.join('')).toContain('알 수 없는 명령');
    const bad = context(['--lang', 'fr']);
    expect(await main(bad)).toBe(4);
    expect(bad.stderr.chunks.join('')).toContain('--lang must be en or ko');
    const unparsable = context(['--lang', 'ko', '--bogus']);
    expect(await main(unparsable)).toBe(4);
    expect(unparsable.stderr.chunks.join('')).toContain('잘못된 옵션');
  });

  it('001 FR-030 finds the command after common options', async () => {
    const ctx = context(['--verbose', '--config', 'x.yaml', 'lint']);
    expect(await main(ctx)).toBe(4);
    expect(ctx.stderr.chunks.join('')).toContain('The command "lint" is not available');
  });

  it('001 FR-030 writes a config-error envelope for a usage error under --json', async () => {
    const unknown = context(['--json', 'nope']);
    expect(await main(unknown)).toBe(4);
    expect(JSON.parse(unknown.stdout.chunks.join(''))).toEqual({
      schemaVersion: '1',
      command: null,
      exit: { code: 4, name: 'config-error' },
      result: null,
      warnings: [],
    });
    const known = context(['lint', '--json', '--bogus']);
    expect(await main(known)).toBe(4);
    const envelope = envelopeSchema('lint').parse(JSON.parse(known.stdout.chunks.join('')));
    expect(envelope).toMatchObject({
      command: 'lint',
      result: null,
      exit: { name: 'config-error' },
    });
  });

  it('001 FR-030 ends an unexpected error with exit 6 and an internal-error envelope', async () => {
    COMMAND_HANDLERS.report = {
      options: {},
      run: () => Promise.reject(new Error('boom')),
    };
    try {
      const ctx = context(['report', '--json']);
      expect(await main(ctx)).toBe(6);
      expect(ctx.stderr.chunks.join('')).toContain('Internal error: boom');
      const envelope = envelopeSchema('report').parse(JSON.parse(ctx.stdout.chunks.join('')));
      expect(envelope).toMatchObject({ exit: { code: 6, name: 'internal-error' }, result: null });
    } finally {
      delete COMMAND_HANDLERS.report;
    }
  });
});
