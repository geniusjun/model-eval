import path from 'node:path';

import type { Lang } from '../config/schema.js';
import { writeFolderAtomic } from '../run/writer.js';
import { COMPARISON_FILE, COMPARISONS_DIR, REPORT_MARKDOWN_FILE } from './layout.js';
import { renderReport } from './markdown.js';
import type { Redactor } from './redact.js';
import { comparisonSchema, type Comparison } from './schema.js';

/**
 * Applies the config `redact` rules to the free text of a Comparison (FR-031). Every surface
 * written from a comparison starts from this one result, so redaction runs exactly once.
 */
export function redactComparison(comparison: Comparison, redactor: Redactor): Comparison {
  return comparisonSchema.parse(redactor.json(comparison));
}

export interface ComparisonWriteOptions {
  readonly outputDir: string;
  readonly comparison: Comparison;
  /** The language of the command, for the text of `report.md`. */
  readonly lang: Lang;
  readonly redactor: Redactor;
}

export interface WrittenComparison {
  readonly dir: string;
  readonly comparison: string;
  readonly report: string;
}

/**
 * Writes `comparisons/<comparisonId>/` with the redacted `comparison.json` and `report.md`
 * (plan D6, item 2): a new folder is written under a temporary name and renamed; when the folder
 * exists, also because another process created it first, each file is replaced on its own.
 */
export async function writeComparison(options: ComparisonWriteOptions): Promise<WrittenComparison> {
  const comparison = redactComparison(options.comparison, options.redactor);
  const dir = path.join(options.outputDir, COMPARISONS_DIR, comparison.comparisonId);
  await writeFolderAtomic(dir, {
    [COMPARISON_FILE]: `${JSON.stringify(comparison, null, 2)}\n`,
    [REPORT_MARKDOWN_FILE]: renderReport(comparison, options.lang),
  });
  return {
    dir,
    comparison: path.join(dir, COMPARISON_FILE),
    report: path.join(dir, REPORT_MARKDOWN_FILE),
  };
}
