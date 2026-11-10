import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Lang } from '../config/schema.js';
import { isTemporaryName } from '../run/writer.js';
import { COMPARISON_FILE, COMPARISONS_DIR, REPORT_PAGE_FILE } from './layout.js';
import {
  comparisonSchema,
  SCHEMA_VERSION,
  type Comparison,
  type ComparisonPage,
  type ListPage,
  type PageData,
} from './schema.js';

/** The template's data block holds this placeholder once (002 page-data §Embedded Block). */
export const DATA_PLACEHOLDER = '__MODEL_EVAL_DATA__';

/** The payload of `report.html`; the Comparison is the redacted one the writer saved. */
export function comparisonPage(comparison: Comparison, lang: Lang): ComparisonPage {
  return { schemaVersion: SCHEMA_VERSION, kind: 'comparison', lang, comparison };
}

type ListEntry = ListPage['comparisons'][number];

function listEntry(comparison: Comparison): ListEntry {
  return {
    comparisonId: comparison.comparisonId,
    href: [COMPARISONS_DIR, comparison.comparisonId, REPORT_PAGE_FILE].join('/'),
    baseline: comparison.baseline.variant.id,
    candidate: comparison.candidate.variant.id,
    createdAt: comparison.createdAt,
    gate: comparison.gate.outcome,
  };
}

function newestFirst(a: ListEntry, b: ListEntry): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  return byTime === 0 ? a.comparisonId.localeCompare(b.comparisonId) : byTime;
}

async function comparisonFolders(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !isTemporaryName(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function readComparison(folder: string): Promise<Comparison> {
  const file = path.join(folder, COMPARISON_FILE);
  const text = await readFile(file, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
  const parsed = comparisonSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${file} is not a comparison: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** The payload of the output root's `index.html`: every comparison folder, newest first. */
export async function listPage(outputDir: string, lang: Lang): Promise<ListPage> {
  const folders = await comparisonFolders(path.join(outputDir, COMPARISONS_DIR));
  const comparisons = await Promise.all(folders.map(readComparison));
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'list',
    lang,
    comparisons: comparisons.map(listEntry).sort(newestFirst),
  };
}

/** JSON with every `<` written as `<`, so `</script>` or `<!--` cannot end the block. */
export function serializePageData(page: PageData): string {
  return JSON.stringify(page).replaceAll('<', '\\u003c');
}

/**
 * Puts the payload into the page template. The replacer function inserts the data verbatim,
 * where a replacement string would expand `$&` and `$1` found in model output. Nothing else
 * in the template changes, so the script hash in its CSP still holds.
 */
export function fillTemplate(template: string, page: PageData): string {
  if (template.split(DATA_PLACEHOLDER).length !== 2) {
    throw new Error(`the page template must hold ${DATA_PLACEHOLDER} exactly once`);
  }
  const data = serializePageData(page);
  return template.replace(DATA_PLACEHOLDER, () => data);
}
