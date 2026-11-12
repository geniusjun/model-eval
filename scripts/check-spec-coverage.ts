// Constitution IX: every FR of a feature whose status is `In Progress` or `Implemented` has a test
// whose name carries the feature number and the FR ID, for example `001 FR-007`. SC IDs are
// listed but not enforced. Exits with 1 when an FR has no such test or a `specs/` folder has no
// spec.md.

import { glob, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const CHECKED_STATUSES: ReadonlySet<string> = new Set(['In Progress', 'Implemented']);
const TEST_FILES = ['test/**/*.test.ts', 'test/**/*.test.tsx'];
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
