import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toFinding, type Diagnostic } from '../../../src/config/diagnostics.js';
import { loadProject, type LoadResult, type Project } from '../../../src/config/load.js';

const CONFIG = `version: 1
adapter:
  command: [node, adapter.mjs]
variants:
  - id: current
    model: model-a
pricing:
  model-a: { input: 0.1, output: 0.5 }
`;

const RULES = `rules:
  - id: no-emoji
    title: No emoji
    severity: major
    scope: global
    check: { type: emoji }
`;

const CASES = `cases:
  - id: greet-ko
    target: chat
    lang: ko
    provenance: synthetic
    input: { user: 안녕 }
`;

let root: string;

function pathOf(item: Diagnostic): string {
  return item.code === 'schema' ? item.params.path : '';
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'model-eval-load-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function project(files: Record<string, string>): Promise<Project> {
  await write(files);
  const result = await loadProject('model-eval.config.yaml', root);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return result.project;
}

async function problems(files: Record<string, string>): Promise<readonly Diagnostic[]> {
  await write(files);
  const result: LoadResult = await loadProject(path.join(root, 'model-eval.config.yaml'), root);
  if (result.ok) {
    throw new Error('expected the files to be rejected');
  }
  return result.diagnostics;
}

function valid(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'model-eval.config.yaml': CONFIG,
    'rules/base.yaml': RULES,
    'cases/chat-ko.yaml': CASES,
    ...overrides,
  };
}

describe('config loader', () => {
  it('001 FR-001 applies the documented defaults', async () => {
    const { config } = await project(valid());
    expect(config.data).toEqual({
      version: 1,
      lang: 'en',
      adapter: { command: ['node', 'adapter.mjs'], cwd: '.', env: {}, timeoutMs: 120_000 },
      files: { rules: 'rules/**/*.yaml', cases: 'cases/**/*.yaml' },
      variants: [{ id: 'current', model: 'model-a' }],
      pricing: { 'model-a': { input: 0.1, output: 0.5 } },
      sampling: { repeats: 5, seed: 1729 },
      stats: { confidence: 0.95, minCases: 3 },
      gate: { severities: [], margin: 0.1 },
      run: { concurrency: 4, retries: 2, maxAdapterErrorRate: 0.05, maxTransientRate: 0.5 },
      budget: { maxCostUsd: 1 },
      estimate: { outputTokens: 600 },
      report: {
        lowBaseline: 0.9,
        samples: 3,
        warn: {
          transientRate: 0.05,
          discardRateIncrease: 0.01,
          regenerationRateIncrease: 0.03,
          latencyP95Ratio: 1.5,
          costRatio: 2,
        },
      },
      output: { dir: '.model-eval' },
      redact: [],
    });
    const rule = (await project(valid())).ruleFiles[0]?.data.rules[0];
    expect(rule).toMatchObject({
      status: 'active',
      scope: 'global',
      targets: [],
      languages: [],
      anchors: [],
      gateOn: 'raw',
      origin: [],
    });
  });

  it('001 FR-025 reads every spelling of an empty gate as the same value', async () => {
    const empty = { severities: [], margin: 0.1 };
    expect((await project(valid())).config.data.gate).toEqual(empty);
    for (const spelling of ['gate:\n', 'gate: {}\n', 'gate:\n  severities: []\n']) {
      const { config } = await project(valid({ 'model-eval.config.yaml': `${CONFIG}${spelling}` }));
      expect(config.data.gate, spelling).toEqual(empty);
    }
  });

  it('001 FR-025 defaults gate.margin to 0.10 when severities are set', async () => {
    const { config } = await project(
      valid({ 'model-eval.config.yaml': `${CONFIG}gate:\n  severities: [blocking]\n` }),
    );
    expect(config.data.gate).toEqual({ severities: ['blocking'], margin: 0.1 });
  });

  it('001 FR-001 requires version, adapter.command, variants and pricing', async () => {
    const diagnostics = await problems(valid({ 'model-eval.config.yaml': 'adapter: {}\n' }));
    expect(diagnostics.map((item) => pathOf(item))).toEqual([
      'version',
      'adapter.command',
      'variants',
      'pricing',
    ]);
  });

  it('001 FR-017 requires mode of pattern and phrases and unit of length', async () => {
    const rules = [
      '  - { id: a, title: t, severity: minor, check: { type: pattern, regex: x } }',
      '  - { id: b, title: t, severity: minor, check: { type: phrases, any: [x] } }',
      '  - { id: c, title: t, severity: minor, check: { type: length, max: 3 } }',
    ].join('\n');
    const diagnostics = await problems(valid({ 'rules/base.yaml': `rules:\n${rules}\n` }));
    expect(diagnostics.map((item) => pathOf(item))).toEqual([
      'rules[0].check.mode',
      'rules[1].check.mode',
      'rules[2].check.unit',
    ]);
  });

  it('001 FR-017 rejects checks that check nothing', async () => {
    const rules = [
      '  - { id: a, title: t, severity: minor, check: { type: phrases, mode: forbid } }',
      '  - { id: b, title: t, severity: minor, check: { type: overlap, minChars: 5 } }',
      '  - { id: c, title: t, severity: minor, check: { type: length, unit: chars } }',
    ].join('\n');
    const diagnostics = await problems(valid({ 'rules/base.yaml': `rules:\n${rules}\n` }));
    expect(diagnostics.map(pathOf)).toEqual(['rules[0].check', 'rules[1].check', 'rules[2].check']);
  });

  it('001 FR-031 rejects a redact pattern that matches the empty string', async () => {
    const diagnostics = await problems(
      valid({ 'model-eval.config.yaml': `${CONFIG}redact:\n  - { pattern: "x*", replace: y }\n` }),
    );
    expect(diagnostics.map(pathOf)).toEqual(['redact[0].pattern']);
  });

  it('001 FR-001 treats a section written without a value as left out', async () => {
    const { config } = await project(
      valid({ 'model-eval.config.yaml': `${CONFIG}stats:\nbudget:\nreport:\n` }),
    );
    expect(config.data.stats).toEqual({ confidence: 0.95, minCases: 3 });
    expect(config.data.budget).toEqual({ maxCostUsd: 1 });
    expect(config.data.report.lowBaseline).toBe(0.9);
    const nested = await project(
      valid({
        'model-eval.config.yaml': `${CONFIG}report:\n  warn:\n  samples: 5\nbudget:\n  maxCostUsd: null\n`,
      }),
    );
    expect(nested.config.data.report.warn.costRatio).toBe(2);
    expect(nested.config.data.report.samples).toBe(5);
    expect(nested.config.data.budget.maxCostUsd).toBeNull();
  });

  it('001 FR-001 reports YAML that cannot be turned into data as a schema error', async () => {
    const level = (name: string, previous: string): string =>
      `${name}: &${name} [${Array.from({ length: 10 }, () => `*${previous}`).join(', ')}]\n`;
    const bomb = `a: &a [x, x, x, x, x, x, x, x, x, x]\n${level('b', 'a')}${level('c', 'b')}d: [${Array.from({ length: 10 }, () => '*c').join(', ')}]\n`;
    const diagnostics = await problems(valid({ 'rules/base.yaml': bomb }));
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'schema', level: 'error', line: 1, column: 1 }),
    ]);
  });

  it('001 FR-001 keeps budget.maxCostUsd null as no cap', async () => {
    const { config } = await project(
      valid({ 'model-eval.config.yaml': `${CONFIG}budget:\n  maxCostUsd: null\n` }),
    );
    expect(config.data.budget.maxCostUsd).toBeNull();
  });

  it('001 FR-001 resolves relative paths and globs from the config folder', async () => {
    await write(valid({ 'rules/nested/more.yaml': RULES.replace('no-emoji', 'no-emoji-2') }));
    await mkdir(path.join(root, 'elsewhere'));
    const result = await loadProject('../model-eval.config.yaml', path.join(root, 'elsewhere'));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { paths, ruleFiles, caseFiles } = result.project;
    expect(paths.configDir).toBe(root);
    expect(paths.adapterCwd).toBe(root);
    expect(paths.outputDir).toBe(path.join(root, '.model-eval'));
    expect(ruleFiles.map((file) => path.relative(root, file.path))).toEqual([
      'rules/base.yaml',
      'rules/nested/more.yaml',
    ]);
    expect(caseFiles.map((file) => path.relative(root, file.path))).toEqual(['cases/chat-ko.yaml']);
  });

  it('001 FR-001 reports a missing field with file, line, column and level error', async () => {
    const diagnostics = await problems(
      valid({
        'rules/base.yaml':
          'rules:\n  - id: no-emoji\n    severity: major\n    check: { type: emoji }\n',
      }),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'schema',
        level: 'error',
        file: path.join('rules', 'base.yaml'),
        line: 2,
        column: 5,
        params: { path: 'rules[0].title', detail: expect.any(String) as unknown },
      }),
    ]);
  });

  it('001 FR-001 points at the offending value and at unknown keys', async () => {
    const diagnostics = await problems(
      valid({
        'cases/chat-ko.yaml': `${CASES}    provenance2: x\n  - id: Bad_Id\n    target: chat\n    provenance: real\n    input: {}\n`,
      }),
    );
    expect(
      diagnostics.map((item) => ({ line: item.line, column: item.column, path: pathOf(item) })),
    ).toEqual([
      { line: 7, column: 5, path: 'cases[0].provenance2' },
      { line: 8, column: 9, path: 'cases[1].id' },
      { line: 10, column: 17, path: 'cases[1].provenance' },
    ]);
  });

  it('001 FR-001 reports YAML syntax errors and duplicate keys with positions', async () => {
    const diagnostics = await problems(
      valid({ 'rules/base.yaml': 'rules:\n  - id: a\n    id: b\n' }),
    );
    expect(diagnostics[0]).toMatchObject({ code: 'schema', level: 'error', line: 3 });
  });

  it('001 FR-001 rejects NaN and infinity in case input', async () => {
    const diagnostics = await problems(
      valid({
        'cases/chat-ko.yaml': CASES.replace(
          '{ user: 안녕 }',
          '{ user: 안녕, score: .nan, max: .inf }',
        ),
      }),
    );
    expect(diagnostics.map(pathOf)).toEqual(['cases[0].input.score', 'cases[0].input.max']);
  });

  it('001 FR-001 enforces the ID pattern of rules, cases and variants', async () => {
    const longId = 'a'.repeat(65);
    const diagnostics = await problems(
      valid({
        'model-eval.config.yaml': CONFIG.replace('id: current', 'id: Current'),
        'rules/base.yaml': RULES.replace('no-emoji', longId),
        'cases/chat-ko.yaml': CASES.replace('greet-ko', '-greet'),
      }),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics.map(pathOf)).toEqual(['variants[0].id']);
    const files = await problems(
      valid({
        'rules/base.yaml': RULES.replace('no-emoji', longId),
        'cases/chat-ko.yaml': CASES.replace('greet-ko', '-greet'),
      }),
    );
    expect(files.map(pathOf)).toEqual(['rules[0].id', 'cases[0].id']);
  });

  it('001 FR-017 accepts every check type and rejects completed and review inside combinators', async () => {
    const checks = [
      '{ type: script, allow: [Hangul, Latin, Common], ignoreFrom: input.nickname }',
      '{ type: pattern, regex: "요$", flags: m, mode: forbid }',
      '{ type: phrases, mode: forbid, anyFrom: params.words }',
      '{ type: overlap, with: [abc], minChars: 10 }',
      '{ type: length, max: 200, unit: graphemes }',
      '{ type: json, schema: { type: object } }',
      '{ type: completed }',
      '{ type: review, samples: 2 }',
      '{ type: all, checks: [{ type: emoji }, { type: not, check: { type: length, min: 1, unit: chars } }] }',
      '{ type: any, checks: [{ type: emoji }] }',
    ];
    const rules = checks
      .map(
        (check, index) =>
          `  - { id: r${String(index)}, title: t, severity: minor, check: ${check} }`,
      )
      .join('\n');
    const { ruleFiles } = await project(valid({ 'rules/base.yaml': `rules:\n${rules}\n` }));
    expect(ruleFiles[0]?.data.rules).toHaveLength(checks.length);

    for (const inner of ['{ type: completed }', '{ type: review }']) {
      const diagnostics = await problems(
        valid({
          'rules/base.yaml': `rules:\n  - { id: r, title: t, severity: minor, check: { type: not, check: ${inner} } }\n`,
        }),
      );
      expect(diagnostics.map(pathOf)).toEqual(['rules[0].check.check.type']);
    }
  });

  it('001 FR-017 rejects g and y regex flags, bad regexes and bad case paths', async () => {
    const rules = [
      '  - { id: a, title: t, severity: minor, check: { type: pattern, regex: x, flags: g, mode: forbid } }',
      '  - { id: b, title: t, severity: minor, check: { type: pattern, regex: "(", mode: forbid } }',
      '  - { id: c, title: t, severity: minor, check: { type: phrases, mode: forbid, anyFrom: words } }',
    ].join('\n');
    const diagnostics = await problems(valid({ 'rules/base.yaml': `rules:\n${rules}\n` }));
    expect(diagnostics.map(pathOf)).toEqual([
      'rules[0].check.flags',
      'rules[1].check.regex',
      'rules[2].check.anyFrom',
    ]);
  });

  it('001 FR-005 rejects examples on review and completed rules', async () => {
    const diagnostics = await problems(
      valid({
        'rules/base.yaml':
          'rules:\n  - id: r\n    title: t\n    severity: minor\n    check: { type: review }\n    examples: { pass: [], fail: [] }\n',
      }),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        line: 6,
        params: { path: 'rules[0].examples', detail: expect.any(String) as unknown },
      }),
    ]);
  });

  it('001 FR-004 rejects an anchor quote of whitespace alone', async () => {
    const diagnostics = await problems(
      valid({
        'rules/base.yaml':
          'rules:\n  - id: r\n    title: t\n    severity: minor\n    check: { type: emoji }\n    anchors: [{ lang: ko, quote: " \\n " }, { lang: ko, quote: " a " }]\n',
      }),
    );
    expect(diagnostics.map(pathOf)).toEqual(['rules[0].anchors[0].quote']);
  });

  it('001 FR-001 enforces value ranges of the config', async () => {
    const config = CONFIG.concat(
      'sampling:\n  repeats: 0\n',
      'stats:\n  minCases: 2\ngate:\n  severities: [critical]\n  margin: 1.5\nredact:\n  - { pattern: "(", replace: x }\n',
    );
    const diagnostics = await problems(valid({ 'model-eval.config.yaml': config }));
    expect(diagnostics.map((item) => pathOf(item))).toEqual([
      'sampling.repeats',
      'stats.minCases',
      'gate.severities[0]',
      'gate.margin',
      'redact[0].pattern',
    ]);
  });

  it('001 FR-034 gives the validator detail in Korean with --lang ko and keeps the record English', async () => {
    await write(valid({ 'model-eval.config.yaml': CONFIG.replace('version: 1', 'version: 2') }));
    const ko = await loadProject('model-eval.config.yaml', root, 'ko');
    const en = await loadProject('model-eval.config.yaml', root);
    if (ko.ok || en.ok) {
      throw new Error('expected the config to be rejected');
    }
    const [koFinding] = ko.diagnostics;
    const [enFinding] = en.diagnostics;
    expect(koFinding?.localDetail).toMatch(/[가-힣]/);
    expect(enFinding?.localDetail).toBeUndefined();
    expect(koFinding === undefined ? undefined : toFinding(koFinding)).toEqual(
      enFinding === undefined ? undefined : toFinding(enFinding),
    );
    expect(koFinding === undefined ? {} : toFinding(koFinding)).not.toHaveProperty('level');
  });

  it('001 FR-001 reports a missing config file as a schema error', async () => {
    const result = await loadProject('missing.yaml', root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]).toMatchObject({
        code: 'schema',
        level: 'error',
        line: 1,
        column: 1,
      });
    }
  });
});
