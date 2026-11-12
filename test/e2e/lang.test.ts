import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { message, type MessageKey, type MessageParams } from '../../src/messages/index.js';
import { runCli, type CliResult } from './support/cli.js';
import { E2E, SWAP, useProjects } from './support/commands.js';
import {
  comparisonOf,
  parseCompareEnvelope,
  parseGradeEnvelope,
  parseLintEnvelope,
  parseSwapEnvelope,
  resultOf,
  swapRunOf,
} from './support/outputs.js';
import { greetCases } from './support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA } from './support/rules.js';

// FR-034 and contracts/cli.md §`--json` Output: `--lang ko` turns human output into Korean and
// leaves every command's `--json` output as it is.

const project = useProjects();

const KO = ['--lang', 'ko'] as const;
const JSON_FLAG = ['--json'] as const;

type Command = (args: readonly string[]) => Promise<CliResult>;

/** One command line run in the default language and again with `--lang ko`. */
interface LangPair {
  readonly en: CliResult;
  readonly ko: CliResult;
}

async function inBothLanguages(command: Command, args: readonly string[]): Promise<LangPair> {
  const en = await command(args);
  const ko = await command([...args, ...KO]);
  return { en, ko };
}

/** `compare` writes the comparison again with a new `createdAt`. */
function withoutCreatedAt(text: string): string {
  return text.replaceAll(/"createdAt":"[^"]*"/gu, '"createdAt":""');
}

/**
 * A new run's own values (data-model §Identifiers and Hashing): the time and random digits of
 * run and swap IDs, the grade set and comparison IDs hashed from them, and `createdAt`.
 */
function withoutNewRunValues(text: string): string {
  return withoutCreatedAt(
    text
      .replaceAll(/\d{8}-\d{6}-([a-z0-9][a-z0-9._-]{0,63})-[0-9a-f]{4}/gu, '<time>-$1-<hex>')
      .replaceAll(/\b(gs|cmp)-[0-9a-f]{12}\b/gu, '$1-<hex>'),
  );
}

function expectSameJson({ en, ko }: LangPair, normalise: (text: string) => string = String): void {
  expect(ko.code).toBe(en.code);
  expect(en.stdout).not.toBe('');
  expect(normalise(ko.stdout)).toBe(normalise(en.stdout));
}

/** A line of a command's human output, as the message files write it in each language. */
interface KnownLine {
  readonly key: MessageKey;
  readonly params?: MessageParams;
}

function trimmedLines(cli: CliResult): string[] {
  return `${cli.stdout}${cli.stderr}`.split('\n').map((line) => line.trim());
}

/** The English line in English output, its Korean form and not the English one with `--lang ko`. */
function expectTranslated({ en, ko }: LangPair, { key, params }: KnownLine, label: string): void {
  const english = message('en', key, params);
  const korean = message('ko', key, params);
  expect(korean, label).not.toBe(english);
  expect(ko.code, label).toBe(en.code);
  expect(trimmedLines(en), label).toContain(english);
  expect(trimmedLines(ko), label).toContain(korean);
  expect(trimmedLines(ko), label).not.toContain(english);
}

/** The `human.lint.summary` line of a `lint --json` run's findings. */
function lintSummary(json: CliResult): KnownLine {
  const envelope = parseLintEnvelope(json.stdout);
  const { errors, info } = resultOf(envelope);
  return {
    key: 'human.lint.summary',
    params: { errors: errors.length, warnings: envelope.warnings.length, info: info.length },
  };
}

describe('001 FR-034 init with --lang ko', () => {
  const folders: string[] = [];

  afterAll(async () => {
    await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
  });

  const init: Command = async (args) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-lang-'));
    folders.push(folder);
    return runCli(['init', ...args], folder);
  };

  it('001 FR-034 prints the same --json and Korean human output', async () => {
    const json = await inBothLanguages(init, JSON_FLAG);
    expect(json.en.code).toBe(0);
    expectSameJson(json);
    expectTranslated(
      await inBothLanguages(init, []),
      { key: 'human.init.next', params: { config: 'model-eval.config.yaml' } },
      'init',
    );
  });
});

describe('001 FR-034 every project command with --lang ko', () => {
  let json: Readonly<Record<string, LangPair>>;
  let human: Readonly<Record<string, LangPair>>;
  let known: Readonly<Record<string, KnownLine>>;

  beforeAll(async () => {
    const saved = await project({
      scenario: 'swap-script-ja',
      rules: [ANSWERED, SCRIPT_JA, NO_EMOJI],
      cases: greetCases({ ko: 2, ja: 2 }),
      config: { gate: { severities: ['blocking'] } },
    });
    const command: Command = (args) => saved.run(args);
    // Each new run starts from an empty output folder, so cost history and prior comparisons
    // are the same in both languages.
    const fresh: Command = async (args) => {
      await rm(saved.outputDir, { recursive: true, force: true });
      return saved.run(args);
    };
    const run = ['run', '--variant', 'current'];
    const lint = await inBothLanguages(command, ['lint', ...JSON_FLAG]);
    const runs = await inBothLanguages(fresh, [...run, ...JSON_FLAG]);
    const swap = await inBothLanguages(fresh, [...SWAP, ...JSON_FLAG]);
    const swapped = parseSwapEnvelope(swap.ko.stdout);
    const runIds = swapRunOf(swapped).runs;
    const grade = ['grade', runIds[0]];
    const compare = ['compare', ...runIds];
    const { comparisonId } = comparisonOf(swapped);
    const report = ['report', comparisonId];
    json = {
      lint,
      run: runs,
      swap,
      grade: await inBothLanguages(command, [...grade, ...JSON_FLAG]),
      compare: await inBothLanguages(command, [...compare, ...JSON_FLAG]),
      report: await inBothLanguages(command, [...report, ...JSON_FLAG]),
    };
    human = {
      lint: await inBothLanguages(command, ['lint']),
      grade: await inBothLanguages(command, grade),
      compare: await inBothLanguages(command, compare),
      report: await inBothLanguages(command, report),
      run: await inBothLanguages(command, run),
      swap: await inBothLanguages(command, SWAP),
    };
    const gradeJson = parseGradeEnvelope(json.grade?.en.stdout ?? '');
    known = {
      lint: lintSummary(lint.en),
      run: { key: 'human.outcomes' },
      swap: { key: 'human.summary' },
      grade: { key: 'human.grade.reused', params: { gradeSetId: resultOf(gradeJson).gradeSetId } },
      compare: { key: 'human.opsNote' },
      report: {
        key: 'human.written.report',
        params: { path: path.join('.model-eval', 'comparisons', comparisonId, 'report.md') },
      },
    };
  }, E2E.timeout);

  const pairOf = (command: string): LangPair => {
    const pair = json[command];
    if (pair === undefined) {
      throw new Error(`no --json runs of ${command}`);
    }
    return pair;
  };

  it('001 FR-034 lint --json is byte-identical', () => {
    expect(pairOf('lint').en.code).toBe(0);
    expectSameJson(pairOf('lint'));
  });

  it('001 FR-034 run --json differs only in the new run ID and the grade set ID', () => {
    expect(pairOf('run').en.code).toBe(0);
    expectSameJson(pairOf('run'), withoutNewRunValues);
  });

  it('001 FR-034 swap --json differs only in new IDs and createdAt', () => {
    expect(pairOf('swap').en.code).toBe(2);
    expectSameJson(pairOf('swap'), withoutNewRunValues);
  });

  it('001 FR-034 grade --json is byte-identical', () => {
    expect(pairOf('grade').en.code).toBe(0);
    expectSameJson(pairOf('grade'));
  });

  it('001 FR-034 compare --json differs only in createdAt', () => {
    const compare = pairOf('compare');
    expect(compare.en.code).toBe(2);
    expect(resultOf(parseCompareEnvelope(compare.ko.stdout)).comparison.priorComparisons).toBe(0);
    expectSameJson(compare, withoutCreatedAt);
  });

  it('001 FR-034 report --json is byte-identical', () => {
    expect(pairOf('report').en.code).toBe(0);
    expectSameJson(pairOf('report'));
  });

  it('001 FR-034 prints the human output of each command in Korean', () => {
    expect(Object.keys(human).sort()).toEqual(Object.keys(json).sort());
    expect(Object.keys(known).sort()).toEqual(Object.keys(json).sort());
    for (const [command, pair] of Object.entries(human)) {
      const line = known[command];
      if (line === undefined) {
        throw new Error(`no known line of ${command}`);
      }
      expectTranslated(pair, line, command);
    }
  });
});

describe('001 FR-034 a schema finding with --lang ko', () => {
  let json: LangPair;
  let human: LangPair;

  beforeAll(async () => {
    const saved = await project({
      scenario: 'swap-clean',
      rules: [ANSWERED],
      cases: greetCases({ ko: 1 }),
    });
    await writeFile(
      path.join(saved.root, 'rules', 'rules.yaml'),
      'rules:\n  - id: answered\n    title: Answered\n    severity: fatal\n    scope: global\n' +
        '    check: { type: completed }\n',
    );
    const command: Command = (args) => saved.run(args);
    json = await inBothLanguages(command, ['lint', ...JSON_FLAG]);
    human = await inBothLanguages(command, ['lint']);
  }, E2E.timeout);

  it("001 FR-034 keeps the validator's detail English in --json and Korean in human output", () => {
    expect(json.en.code).toBe(1);
    expectSameJson(json);
    expectTranslated(human, lintSummary(json.en), 'lint');
  });
});
