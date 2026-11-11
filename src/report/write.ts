import path from 'node:path';

import type { Lang } from '../config/schema.js';
import { writeFileAtomic, writeFolderAtomic } from '../run/writer.js';
import { COMPARISON_FILE, comparisonDir, REPORT_MARKDOWN_FILE } from './layout.js';
import { renderReport } from './markdown.js';
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
  await writeFolderAtomic(dir, {
    [COMPARISON_FILE]: `${JSON.stringify(comparison, null, 2)}\n`,
    [REPORT_MARKDOWN_FILE]: renderReport(comparison, lang),
  });
  return {
    dir,
    comparison: path.join(dir, COMPARISON_FILE),
    report: path.join(dir, REPORT_MARKDOWN_FILE),
  };
}

/**
 * Rewrites `report.md` of a saved comparison from its `comparison.json`, for example in another
 * language or with a newer tool version; the saved comparison itself is left as it is.
 */
export async function rewriteReport({
  outputDir,
  comparison,
  lang,
}: ComparisonWriteOptions): Promise<WrittenComparison> {
  const dir = comparisonDir(outputDir, comparison.comparisonId);
  const report = path.join(dir, REPORT_MARKDOWN_FILE);
  await writeFileAtomic(report, renderReport(comparison, lang));
  return { dir, comparison: path.join(dir, COMPARISON_FILE), report };
}
