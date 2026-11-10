import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

import { listResultEntries } from '../run/writer.js';

/** Where comparisons live in the output directory (data-model §Comparison). */
export const COMPARISONS_DIR = 'comparisons';
export const COMPARISON_FILE = 'comparison.json';
export const REPORT_MARKDOWN_FILE = 'report.md';
export const REPORT_PAGE_FILE = 'report.html';

/** A saved comparison as one reader needs it, under its folder name. */
export interface SavedComparison<T> {
  readonly folder: string;
  readonly comparison: T;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function readSaved<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The comparisons under `comparisons/` that `schema` reads, in folder name order. Temporary
 * names are skipped, and so is a folder without a readable comparison, which is not a result.
 */
export async function savedComparisons<T>(
  outputDir: string,
  schema: z.ZodType<T>,
): Promise<SavedComparison<T>[]> {
  const root = path.join(outputDir, COMPARISONS_DIR);
  const saved: SavedComparison<T>[] = [];
  for (const folder of await listResultEntries(root)) {
    const comparison = await readSaved(path.join(root, folder, COMPARISON_FILE), schema);
    if (comparison !== undefined) {
      saved.push({ folder, comparison });
    }
  }
  return saved;
}
