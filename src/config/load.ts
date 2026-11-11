import { glob, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from 'yaml';
import { z } from 'zod';

import { compareCodeUnits } from '../adapter/canonical-json.js';
import { diagnostic, type Diagnostic } from './diagnostics.js';
import {
  casesFileSchema,
  configSchema,
  rulesFileSchema,
  type CasesFile,
  type Config,
  type Lang,
  type RulesFile,
} from './schema.js';

export interface Position {
  readonly line: number;
  readonly column: number;
}

export type PathSegment = string | number;

export interface SourceFile<T> {
  /** Absolute path. */
  readonly path: string;
  readonly data: T;
  /** Position of the value (or its key) at `segments`, else of its nearest existing parent. */
  locate(segments: readonly PathSegment[], target?: 'value' | 'key'): Position;
}

export interface ResolvedPaths {
  readonly configFile: string;
  readonly configDir: string;
  readonly adapterCwd: string;
  readonly outputDir: string;
}

export interface Project {
  readonly config: SourceFile<Config>;
  readonly ruleFiles: readonly SourceFile<RulesFile>[];
  readonly caseFiles: readonly SourceFile<CasesFile>[];
  readonly paths: ResolvedPaths;
}

export type LoadResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type FileResult<T> = { ok: true; file: SourceFile<T> } | { ok: false; diagnostics: Diagnostic[] };

const START: Position = { line: 1, column: 1 };

interface LoadContext {
  readonly display: (file: string) => string;
  readonly lang: Lang;
}

/** zod's own messages per language, for the human text of `schema` findings. */
const ZOD_LOCALES: Readonly<Record<Lang, z.core.$ZodErrorMap | undefined>> = {
  en: undefined,
  ko: z.locales.ko().localeError,
};

export type ConfigLoadResult =
  | {
      readonly ok: true;
      readonly config: SourceFile<Config>;
      readonly paths: ResolvedPaths;
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

function loadContext(cwd: string, lang: Lang): LoadContext {
  return { display: (file: string): string => path.relative(cwd, file) || file, lang };
}

/**
 * Loads the config file alone; its paths resolve from the config folder. `lang` is the language
 * of the human text of findings (`--lang`).
 */
export async function loadConfig(
  configPath: string,
  cwd: string,
  lang: Lang = 'en',
): Promise<ConfigLoadResult> {
  const configFile = path.resolve(cwd, configPath);
  const config = await loadFile(configFile, configSchema, loadContext(cwd, lang));
  if (!config.ok) {
    return { ok: false, diagnostics: config.diagnostics };
  }
  const configDir = path.dirname(configFile);
  const { data } = config.file;
  return {
    ok: true,
    config: config.file,
    paths: {
      configFile,
      configDir,
      adapterCwd: path.resolve(configDir, data.adapter.cwd),
      outputDir: path.resolve(configDir, data.output.dir),
    },
  };
}

/**
 * Loads the config and every rule and case file it points to; paths resolve from the config
 * folder. `lang` is the language of the human text of findings (`--lang`).
 */
export async function loadProject(
  configPath: string,
  cwd: string,
  lang: Lang = 'en',
): Promise<LoadResult> {
  const loaded = await loadConfig(configPath, cwd, lang);
  if (!loaded.ok) {
    return loaded;
  }
  const context = loadContext(cwd, lang);
  const { config, paths } = loaded;
  const [ruleFiles, caseFiles] = await Promise.all([
    loadAll(await expandGlob(config.data.files.rules, paths.configDir), rulesFileSchema, context),
    loadAll(await expandGlob(config.data.files.cases, paths.configDir), casesFileSchema, context),
  ]);
  const diagnostics = [...ruleFiles.diagnostics, ...caseFiles.diagnostics];
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    project: { config, ruleFiles: ruleFiles.files, caseFiles: caseFiles.files, paths },
  };
}

/** Matching files in code-unit order of their path relative to the config folder. */
export async function expandGlob(pattern: string, configDir: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const relative of glob(pattern, { cwd: configDir })) {
    const absolute = path.resolve(configDir, relative);
    if ((await stat(absolute)).isFile()) {
      matches.push(absolute);
    }
  }
  const relativeTo = (file: string): string => path.relative(configDir, file);
  return matches.sort((a, b) => compareCodeUnits(relativeTo(a), relativeTo(b)));
}

async function loadAll<T>(
  files: readonly string[],
  schema: z.ZodType<T>,
  context: LoadContext,
): Promise<{ files: SourceFile<T>[]; diagnostics: Diagnostic[] }> {
  const results = await Promise.all(files.map((file) => loadFile(file, schema, context)));
  return {
    files: results.flatMap((result) => (result.ok ? [result.file] : [])),
    diagnostics: results.flatMap((result) => (result.ok ? [] : result.diagnostics)),
  };
}

async function loadFile<T>(
  file: string,
  schema: z.ZodType<T>,
  context: LoadContext,
): Promise<FileResult<T>> {
  const shown = context.display(file);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      diagnostics: [schemaDiagnostic(shown, START, '', `cannot read the file: ${describe(error)}`)],
    };
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      ok: false,
      diagnostics: document.errors.map((error) => {
        const { line, col } = lineCounter.linePos(error.pos[0]);
        return schemaDiagnostic(shown, { line, column: col }, '', firstLine(error.message));
      }),
    };
  }

  const locate = (
    segments: readonly PathSegment[],
    target: 'value' | 'key' = 'value',
  ): Position => {
    const offset = nodeAt(document, segments, target)?.range?.[0] ?? 0;
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  let value: unknown;
  try {
    value = document.toJS();
  } catch (error) {
    return { ok: false, diagnostics: [schemaDiagnostic(shown, START, '', describe(error))] };
  }
  const input = withoutNullSections(value, schema);
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const localeError = ZOD_LOCALES[context.lang];
    // Parsing again in the other language yields the same issues in the same order.
    const local =
      localeError === undefined
        ? undefined
        : schema.safeParse(input, { error: localeError }).error?.issues;
    return {
      ok: false,
      diagnostics: parsed.error.issues.flatMap((issue, index) =>
        issueDiagnostics(issue, local?.[index]?.message, shown, locate),
      ),
    };
  }
  return { ok: true, file: { path: file, data: parsed.data, locate } };
}

function issueDiagnostics(
  issue: z.core.$ZodIssue,
  localDetail: string | undefined,
  file: string,
  locate: SourceFile<unknown>['locate'],
): Diagnostic[] {
  const segments = issue.path.filter(isPathSegment);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const at = [...segments, key];
      return schemaDiagnostic(
        file,
        locate(at, 'key'),
        formatPath(at),
        'unknown field',
        localDetail,
      );
    });
  }
  return [
    schemaDiagnostic(file, locate(segments), formatPath(segments), issue.message, localDetail),
  ];
}

/**
 * A section written without a value (`stats:`, `report: { warn: }`) is a section left out, so
 * its defaults apply. Sections are the keys whose schema is an object; a `null` elsewhere (such as
 * `budget.maxCostUsd: null`) keeps its meaning.
 */
function withoutNullSections(value: unknown, schema: z.core.$ZodType): unknown {
  const target = unwrapDefaults(schema);
  if (target instanceof z.ZodArray && Array.isArray(value)) {
    return value.map((item: unknown) => withoutNullSections(item, target.element));
  }
  if (!(target instanceof z.ZodObject) || typeof value !== 'object' || value === null) {
    return value;
  }
  const shape: Readonly<Record<string, z.core.$ZodType | undefined>> = target.shape;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]: [string, unknown]) => {
      const field = shape[key];
      if (field === undefined) {
        return [[key, member]];
      }
      if (member === null && unwrapDefaults(field) instanceof z.ZodObject) {
        return [];
      }
      return [[key, withoutNullSections(member, field)]];
    }),
  );
}

function unwrapDefaults(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodOptional
  ) {
    return unwrapDefaults(schema.unwrap());
  }
  return schema;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `path` is the field (empty for the whole file); `detail` is the parser's or validator's text. */
function schemaDiagnostic(
  file: string,
  position: Position,
  path: string,
  detail: string,
  localDetail?: string,
): Diagnostic {
  return diagnostic(
    {
      code: 'schema',
      params: { path, detail },
      file,
      line: position.line,
      column: position.column,
    },
    localDetail,
  );
}

/** Walks the YAML tree by keys and indexes; an empty value is located at its key. */
function nodeAt(
  document: Document,
  segments: readonly PathSegment[],
  target: 'value' | 'key',
): Node | undefined {
  let current: unknown = document.contents;
  let found: Node | undefined = isNode(current) ? current : undefined;
  for (const [index, segment] of segments.entries()) {
    if (isMap(current)) {
      const pair = current.items.find(
        (item) => isPair(item) && isScalar(item.key) && String(item.key.value) === String(segment),
      );
      if (pair === undefined) {
        return found;
      }
      const wantsKey = target === 'key' && index === segments.length - 1;
      const located = isNode(pair.value) && !wantsKey ? pair.value : pair.key;
      current = pair.value;
      found = isNode(located) ? located : found;
    } else if (isSeq(current) && typeof segment === 'number') {
      const item: unknown = current.items[segment];
      if (!isNode(item)) {
        return found;
      }
      current = item;
      found = item;
    } else {
      return found;
    }
  }
  return found;
}

function isNode(value: unknown): value is Node {
  return isScalar(value) || isMap(value) || isSeq(value);
}

function isPathSegment(segment: PropertyKey): segment is PathSegment {
  return typeof segment === 'string' || typeof segment === 'number';
}

function formatPath(segments: readonly PathSegment[]): string {
  return segments
    .map((segment, index) => {
      if (typeof segment === 'number') {
        return `[${String(segment)}]`;
      }
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? text;
}
