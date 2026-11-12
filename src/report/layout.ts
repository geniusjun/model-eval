import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { z } from 'zod';

import { listResultEntries } from '../run/writer.js';
import { comparisonSchema, type Comparison } from './schema.js';

/** Where comparisons live in the output directory (data-model §Comparison). */
export const COMPARISONS_DIR = 'comparisons';
export const COMPARISON_FILE = 'comparison.json';
export const REPORT_MARKDOWN_FILE = 'report.md';
export const REPORT_PAGE_FILE = 'report.html';
/** The comparison list at the output root (002 page-data §Payloads). */
export const INDEX_PAGE_FILE = 'index.html';

/** A saved comparison as one reader needs it, under its folder name. */
export interface SavedComparison<T> {
  readonly folder: string;
  readonly comparison: T;
}

/** Whether a read failed because the file, or a folder on its path, does not exist. */
export function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

type SavedRead<T> =
  | { readonly kind: 'read'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

async function readSaved<T>(file: string, schema: z.ZodType<T>): Promise<SavedRead<T>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return { kind: 'missing' };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'unreadable' };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { kind: 'read', value: parsed.data } : { kind: 'unreadable' };
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
    const read = await readSaved(path.join(root, folder, COMPARISON_FILE), schema);
    if (read.kind === 'read') {
      saved.push({ folder, comparison: read.value });
    }
  }
  return saved;
}

export function comparisonDir(outputDir: string, comparisonId: string): string {
  return path.join(outputDir, COMPARISONS_DIR, comparisonId);
}

export type SavedComparisonRead =
  | { readonly ok: true; readonly comparison: Comparison }
  | { readonly ok: false; readonly problem: 'missing' }
  | { readonly ok: false; readonly problem: 'unreadable'; readonly file: string }
  | {
      readonly ok: false;
      readonly problem: 'other-id';
      readonly file: string;
      /** The comparisonId the file holds. */
      readonly found: string;
    };

/**
 * The saved `comparison.json` of one comparison, as `report` rewrites its outputs from it. The
 * folder name is the comparison's ID, so a file holding another ID is not this comparison.
 */
export async function readSavedComparison(
  outputDir: string,
  comparisonId: string,
): Promise<SavedComparisonRead> {
  const file = path.join(comparisonDir(outputDir, comparisonId), COMPARISON_FILE);
  const read = await readSaved(file, comparisonSchema);
  switch (read.kind) {
    case 'read':
      return read.value.comparisonId === comparisonId
        ? { ok: true, comparison: read.value }
        : { ok: false, problem: 'other-id', file, found: read.value.comparisonId };
    case 'missing':
      return { ok: false, problem: 'missing' };
    case 'unreadable':
      return { ok: false, problem: 'unreadable', file };
  }
}
