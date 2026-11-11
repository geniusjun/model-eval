import path from 'node:path';

import type { Lang } from '../config/schema.js';
import { listResultEntries, writeFileAtomic, writeFolderAtomic } from '../run/writer.js';
import {
  COMPARISON_FILE,
  comparisonDir,
  REPORT_MARKDOWN_FILE,
  REPORT_PAGE_FILE,
} from './layout.js';
import { renderReport, type ReviewSamplesAt } from './markdown.js';
import type { Comparison } from './schema.js';

export interface ComparisonWriteOptions {
  readonly outputDir: string;
  /** The redacted Comparison of `buildComparison`, written as it is. */
  readonly comparison: Comparison;
  /** The language of the command, for the text of `report.md`. */
  readonly lang: Lang;
}

export interface WrittenComparison {
  readonly dir: string;
  readonly comparison: string;
  readonly report: string;
  /** The result page, when the folder holds one; `report.md` then points readers to it. */
  readonly page?: string;
}

/** The result page when the folder's files include it, else `samples.review` of the comparison. */
function reviewSamplesAt(files: readonly string[]): ReviewSamplesAt {
  return files.includes(REPORT_PAGE_FILE) ? 'result-page' : 'comparison-json';
}

function writtenFiles(dir: string, at: ReviewSamplesAt): WrittenComparison {
  return {
    dir,
    comparison: path.join(dir, COMPARISON_FILE),
    report: path.join(dir, REPORT_MARKDOWN_FILE),
    ...(at === 'result-page' ? { page: path.join(dir, REPORT_PAGE_FILE) } : {}),
  };
}

/**
 * Writes `comparisons/<comparisonId>/` with `comparison.json` and `report.md` (plan D6, item 2):
 * a new folder is written under a temporary name and renamed; when the folder exists, also
 * because another process created it first, each file is replaced on its own.
 */
export async function writeComparison({
  outputDir,
  comparison,
  lang,
}: ComparisonWriteOptions): Promise<WrittenComparison> {
  const dir = comparisonDir(outputDir, comparison.comparisonId);
  const files = { [COMPARISON_FILE]: `${JSON.stringify(comparison, null, 2)}\n` };
  const at = reviewSamplesAt(Object.keys(files));
  await writeFolderAtomic(dir, {
    ...files,
    [REPORT_MARKDOWN_FILE]: renderReport(comparison, lang, at),
  });
  return writtenFiles(dir, at);
}

/**
 * Rewrites `report.md` of a saved comparison from its `comparison.json`, for example in another
 * language or with a newer tool version; the saved comparison itself is left as it is, and the
 * report points to the result page when the folder holds one.
 */
export async function rewriteReport({
  outputDir,
  comparison,
  lang,
}: ComparisonWriteOptions): Promise<WrittenComparison> {
  const dir = comparisonDir(outputDir, comparison.comparisonId);
  const at = reviewSamplesAt(await listResultEntries(dir));
  await writeFileAtomic(path.join(dir, REPORT_MARKDOWN_FILE), renderReport(comparison, lang, at));
  return writtenFiles(dir, at);
}
