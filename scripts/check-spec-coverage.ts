// Constitution IX: every FR of a feature whose status is `In Progress` or `Implemented` has a test
// whose name carries the feature number and the FR ID, for example `001 FR-007` in vitest and
// `test_003_FR_007_…` in pytest. SC IDs are listed but not enforced. Exits with 1 when an FR has
// no such test or a `specs/` folder has no spec.md.

import { glob, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const CHECKED_STATUSES: ReadonlySet<string> = new Set(['In Progress', 'Implemented']);
const TEST_FILES = ['test/**/*.test.ts', 'test/**/*.test.tsx'];
const PYTEST_FILES = ['adapters/python/tests/**/test_*.py'];
const TEST_FUNCTIONS: ReadonlySet<string> = new Set(['describe', 'it', 'test']);
/**
 * Modifiers whose body never runs, so neither their name nor the names inside cover anything.
 * `skipIf` and `runIf` are not among them: their tests run wherever the condition allows.
 */
const NOT_RUN: ReadonlySet<string> = new Set(['skip', 'todo']);

export interface Feature {
  /** The three-digit feature number. */
  readonly id: string;
  /** The folder name under `specs/`. */
  readonly name: string;
  readonly status: string | null;
  readonly requirements: readonly string[];
  readonly successCriteria: readonly string[];
}

export interface Missing {
  readonly requirements: readonly string[];
  readonly successCriteria: readonly string[];
}

export interface FeatureCoverage extends Feature {
  readonly missing: Missing;
}

export interface CoverageReport {
  /** The checked features only. */
  readonly features: readonly FeatureCoverage[];
  /** `specs/` folders without a `spec.md`, whose status cannot be read. */
  readonly withoutSpec: readonly string[];
}

/** Defined IDs only: list items that start with the bold ID, not IDs a sentence mentions. */
function definedIds(specText: string, kind: 'FR' | 'SC'): string[] {
  const pattern = new RegExp(`^- \\*\\*(${kind}-\\d{3})\\*\\*:`, 'gm');
  return [...specText.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** `name` is a `specs/` folder such as `001-swap-check`. */
export function parseFeature(name: string, specText: string): Feature {
  const status = /^\*\*Status\*\*:\s*(.+?)\s*$/m.exec(specText)?.[1] ?? null;
  return {
    id: name.slice(0, 3),
    name,
    status,
    requirements: definedIds(specText, 'FR'),
    successCriteria: definedIds(specText, 'SC'),
  };
}

export function isChecked(feature: Feature): boolean {
  return feature.status !== null && CHECKED_STATUSES.has(feature.status);
}

/** The function a test call goes back to: `it` for `it(…)`, `it.each(…)(…)` and `it.skip(…)`. */
function calleeChain(expression: ts.Expression): string[] {
  if (ts.isIdentifier(expression)) {
    return [expression.text];
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return [...calleeChain(expression.expression), expression.name.text];
  }
  if (ts.isCallExpression(expression)) {
    return calleeChain(expression.expression);
  }
  return [];
}

/** The static text of a title; a template's substitutions become `${…}`. */
function titleText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce(
      (text, span) => `${text}\${…}${span.literal.text}`,
      node.head.text,
    );
  }
  return null;
}

/** The names of the `describe`, `it` and `test` calls of a test file, in source order. */
export function testTitles(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false);
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [root, ...modifiers] = calleeChain(node.expression);
      if (root !== undefined && TEST_FUNCTIONS.has(root)) {
        if (modifiers.some((modifier) => NOT_RUN.has(modifier))) {
          return;
        }
        const first = node.arguments[0];
        const title = first === undefined ? null : titleText(first);
        if (title !== null) {
          titles.push(title);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

/** `NNN FR-###` and `NNN SC-###` for each ID that follows a feature number, as in `001 FR-019 FR-032`. */
export function carriedRequirements(title: string): string[] {
  return [...title.matchAll(/\b(\d{3})((?:[\s,]+(?:FR|SC)-\d{3}\b)+)/g)].flatMap((match) => {
    const [, feature, ids] = match;
    return feature === undefined || ids === undefined
      ? []
      : [...ids.matchAll(/(?:FR|SC)-\d{3}/g)].map((id) => `${feature} ${id[0]}`);
  });
}

export function findMissing(feature: Feature, carried: ReadonlySet<string>): Missing {
  const uncovered = (ids: readonly string[]): string[] =>
    ids.filter((id) => !carried.has(`${feature.id} ${id}`));
  return {
    requirements: uncovered(feature.requirements),
    successCriteria: uncovered(feature.successCriteria),
  };
}

/** One logical line of Python source: physical lines joined inside brackets and strings. */
interface PythonLine {
  /** Leading spaces and tabs of the first physical line. */
  readonly indent: number;
  /** The code with comments removed and string contents left out, so only the quotes remain. */
  readonly code: string;
}

/**
 * Splits Python source into logical lines. String contents are dropped, so a `def` inside a
 * docstring or a test name written in a string is never read as code.
 */
function pythonLines(source: string): PythonLine[] {
  const lines: PythonLine[] = [];
  let code = '';
  let indent = 0;
  let atLineStart = true;
  let depth = 0;
  let index = 0;
  const endLine = (): void => {
    if (code.trim() !== '') {
      lines.push({ indent, code: code.trim() });
    }
    code = '';
    atLineStart = true;
  };
  while (index < source.length) {
    const char = source.charAt(index);
    if (atLineStart) {
      const leading = /^[ \t]*/.exec(source.slice(index))?.[0] ?? '';
      indent = leading.length;
      index += leading.length;
      atLineStart = false;
      continue;
    }
    if (char === '#') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '\\' && source.charAt(index + 1) === '\n') {
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = source.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index = stringEnd(source, index + quote.length, quote);
      code += quote + quote;
      continue;
    }
    if (char === '\n') {
      index += 1;
      if (depth === 0) {
        endLine();
      } else {
        code += ' ';
      }
      continue;
    }
    if ('([{'.includes(char)) {
      depth += 1;
    } else if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1);
    }
    code += char;
    index += 1;
  }
  endLine();
  return lines;
}

/** The index after the closing quote; a one-quote string also ends at its line end. */
function stringEnd(source: string, start: number, quote: string): number {
  let index = start;
  while (index < source.length) {
    if (source.charAt(index) === '\\') {
      index += 2;
    } else if (source.startsWith(quote, index)) {
      return index + quote.length;
    } else if (quote.length === 1 && source.charAt(index) === '\n') {
      return index;
    } else {
      index += 1;
    }
  }
  return source.length;
}

/** `pytest.mark.skip` and `pytest.mark.xfail`, not `pytest.mark.skipif`. */
const SKIPPING_DECORATOR = /^@\s*pytest\.mark\.(?:skip|xfail)\b/;
const SKIP_MARK = /\bpytest\.mark\.skip\b/;
const PYTEST_MARK = /^pytestmark\s*(?::[^=]*)?=(.*)$/s;
const DEFINITION = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;

interface Scope {
  readonly indent: number;
  /** A module-level class chain of `Test` classes, whose methods pytest collects. */
  readonly collects: boolean;
  readonly skipped: boolean;
}

/**
 * The pytest tests of a file that run: `def test_…` and `async def test_…` at module level and in
 * classes whose name starts with `Test`, without a `pytest.mark.skip` or `pytest.mark.xfail`
 * decorator on them or their class, in a module whose `pytestmark` does not hold
 * `pytest.mark.skip`. `pytest.mark.skipif` tests run wherever the condition allows, so they count.
 */
export function pytestTestNames(sourceText: string): string[] {
  const names: string[] = [];
  const scopes: Scope[] = [];
  let decorators: string[] = [];
  let moduleSkipped = false;
  for (const { indent, code } of pythonLines(sourceText)) {
    while (scopes.length > 0 && (scopes.at(-1)?.indent ?? -1) >= indent) {
      scopes.pop();
    }
    if (code.startsWith('@')) {
      decorators.push(code);
      continue;
    }
    const parent = scopes.at(-1);
    const collects = parent === undefined || parent.collects;
    const skipped =
      (parent?.skipped ?? false) || decorators.some((line) => SKIPPING_DECORATOR.test(line));
    decorators = [];
    const definition = DEFINITION.exec(code);
    if (definition === null) {
      const mark = PYTEST_MARK.exec(code);
      if (parent === undefined && mark !== null && SKIP_MARK.test(mark[1] ?? '')) {
        moduleSkipped = true;
      }
      continue;
    }
    const [, kind, name = ''] = definition;
    if (kind === 'class') {
      scopes.push({ indent, collects: collects && name.startsWith('Test'), skipped });
      continue;
    }
    if (collects && !skipped && name.startsWith('test_')) {
      names.push(name);
    }
    scopes.push({ indent, collects: false, skipped });
  }
  return moduleSkipped ? [] : names;
}

/** `NNN FR-###` and `NNN SC-###` for each `_FR_###` or `_SC_###` after `NNN` in a pytest name. */
export function pytestRequirements(name: string): string[] {
  return [...name.matchAll(/(?:^|_)(\d{3})((?:_(?:FR|SC)_\d{3})+)(?=_|$)/g)].flatMap((match) => {
    const [, feature, ids] = match;
    return feature === undefined || ids === undefined
      ? []
      : [...ids.matchAll(/(FR|SC)_(\d{3})/g)].map(
          ([, kind, id]) => `${feature} ${kind ?? ''}-${id ?? ''}`,
        );
  });
}

/** The spec text, or null when the folder has no `spec.md`. */
async function readSpec(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readFeatures(root: string): Promise<{ features: Feature[]; withoutSpec: string[] }> {
  const specs = path.join(root, 'specs');
  const folders = (await readdir(specs, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const texts = await Promise.all(
    folders.map(async (name) => ({
      name,
      text: await readSpec(path.join(specs, name, 'spec.md')),
    })),
  );
  return {
    features: texts.flatMap(({ name, text }) => (text === null ? [] : [parseFeature(name, text)])),
    withoutSpec: texts.flatMap(({ name, text }) => (text === null ? [name] : [])),
  };
}

async function readCarried(root: string): Promise<Set<string>> {
  const carried = new Set<string>();
  for await (const file of glob(TEST_FILES, { cwd: root })) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const title of testTitles(text, file)) {
      for (const id of carriedRequirements(title)) {
        carried.add(id);
      }
    }
  }
  for await (const file of glob(PYTEST_FILES, { cwd: root })) {
    const text = await readFile(path.join(root, file), 'utf8');
    for (const name of pytestTestNames(text)) {
      for (const id of pytestRequirements(name)) {
        carried.add(id);
      }
    }
  }
  return carried;
}

export async function checkSpecCoverage(root: string): Promise<CoverageReport> {
  const [{ features, withoutSpec }, carried] = await Promise.all([
    readFeatures(root),
    readCarried(root),
  ]);
  return {
    features: features
      .filter(isChecked)
      .map((feature) => ({ ...feature, missing: findMissing(feature, carried) })),
    withoutSpec,
  };
}

function describeFeature(feature: FeatureCoverage): string[] {
  const { requirements, successCriteria } = feature.missing;
  const covered = feature.requirements.length - requirements.length;
  return [
    `${feature.name} (${feature.status ?? 'no status'}): ${String(covered)} of ${String(feature.requirements.length)} FRs have a test.`,
    ...(requirements.length === 0 ? [] : [`  FRs without a test: ${requirements.join(', ')}`]),
    ...(successCriteria.length === 0
      ? []
      : [`  SCs without a test (not enforced): ${successCriteria.join(', ')}`]),
  ];
}

export async function main(root: string): Promise<number> {
  const report = await checkSpecCoverage(root);
  const lines = [
    ...(report.features.length === 0
      ? ['No feature is In Progress or Implemented; nothing to check.']
      : report.features.flatMap(describeFeature)),
    ...report.withoutSpec.map((name) => `specs/${name} has no spec.md, so its status is unknown.`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  const failed =
    report.withoutSpec.length > 0 ||
    report.features.some((feature) => feature.missing.requirements.length > 0);
  return failed ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(fileURLToPath(new URL('../', import.meta.url)));
}
