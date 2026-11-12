import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Lang } from '../config/schema.js';
import { listResultEntries, writeFileAtomic, writeFolderAtomic } from '../run/writer.js';
import {
  COMPARISON_FILE,
  comparisonDir,
  INDEX_PAGE_FILE,
  REPORT_MARKDOWN_FILE,
  REPORT_PAGE_FILE,
} from './layout.js';
import { renderReport, type ReviewSamplesAt } from './markdown.js';
import { comparisonPage, fillTemplate, listPage } from './page-data.js';
import type { Comparison, ListPage } from './schema.js';
import { readPageTemplate } from './template.js';

export interface ComparisonWriteOptions {
  readonly outputDir: string;
  /** The redacted Comparison of `buildComparison`, written as it is. */
  readonly comparison: Comparison;
  /** The language of the command, for the text of `report.md` and the pages. */
  readonly lang: Lang;
  /**
   * The result page template; `PAGE_TEMPLATE` of the package when left out. Without a template
   * there, no `report.html` and no `index.html` are written, and `report.md` points readers to
   * `samples.review` of `comparison.json`.
   */
  readonly templateFile?: string;
}

export interface WrittenComparison {
  readonly dir: string;
  readonly comparison: string;
  readonly report: string;
  /** The result page, when the folder holds one; `report.md` then points readers to it. */
  readonly page?: string;
  /** The output root's comparison list, when this write wrote it. */
  readonly index?: string;
  /** Whether the page template was there; without it no page and no list were written. */
  readonly templateFound: boolean;
}

/** The result page when the folder's files include it, else `samples.review` of the comparison. */
function reviewSamplesAt(files: readonly string[]): ReviewSamplesAt {
  return files.includes(REPORT_PAGE_FILE) ? 'result-page' : 'comparison-json';
}

function writtenFiles(dir: string, at: ReviewSamplesAt, index?: string): WrittenComparison {
  return {
    dir,
    comparison: path.join(dir, COMPARISON_FILE),
    report: path.join(dir, REPORT_MARKDOWN_FILE),
    ...(at === 'result-page' ? { page: path.join(dir, REPORT_PAGE_FILE) } : {}),
    ...(index === undefined ? { templateFound: false } : { index, templateFound: true }),
  };
}

/** Writes of `index.html` that may follow one write, when other writers keep adding folders. */
const INDEX_WRITES = 3;

/**
 * Rewrites the output root's `index.html` from the comparison folders it holds now. Another
 * writer may add a folder after this listing and rename its own older list over this one, so the
 * listing is read again after each write and written again while it changed.
 */
export async function writeIndex(
  outputDir: string,
  template: string,
  lang: Lang,
  list: (outputDir: string, lang: Lang) => Promise<ListPage> = listPage,
): Promise<string> {
  const file = path.join(outputDir, INDEX_PAGE_FILE);
  let listing = await list(outputDir, lang);
  for (let write = 1; ; write += 1) {
    await writeFileAtomic(file, fillTemplate(template, listing));
    const current = await list(outputDir, lang);
    if (write === INDEX_WRITES || isDeepStrictEqual(current, listing)) {
      return file;
    }
    listing = current;
  }
}

/**
 * Writes `comparisons/<comparisonId>/` with `comparison.json`, `report.md` and, with the page
 * template, `report.html`, then the output `index.html` (plan D6, item 2): a new folder is
 * written under a temporary name and renamed; when the folder exists, also because another
 * process created it first, each file is replaced on its own.
 */
export async function writeComparison({
  outputDir,
  comparison,
  lang,
  templateFile,
}: ComparisonWriteOptions): Promise<WrittenComparison> {
  const dir = comparisonDir(outputDir, comparison.comparisonId);
  const template = await readPageTemplate(templateFile);
  const files: Record<string, string> = {
    [COMPARISON_FILE]: `${JSON.stringify(comparison, null, 2)}\n`,
  };
  if (template !== undefined) {
    files[REPORT_PAGE_FILE] = fillTemplate(template, comparisonPage(comparison, lang));
  }
  const at = reviewSamplesAt(Object.keys(files));
  await writeFolderAtomic(dir, {
    ...files,
    [REPORT_MARKDOWN_FILE]: renderReport(comparison, lang, at),
  });
  const index = template === undefined ? undefined : await writeIndex(outputDir, template, lang);
  return writtenFiles(dir, at, index);
}

/**
 * Rewrites `report.md` and, with the page template, `report.html` and the output `index.html`
 * of a saved comparison from its `comparison.json`, for example in another language or with a
 * newer tool version; the saved comparison itself is left as it is. Without a template, the
 * report points to the result page when the folder holds one.
 */
export async function rewriteReport({
  outputDir,
  comparison,
  lang,
  templateFile,
}: ComparisonWriteOptions): Promise<WrittenComparison> {
  const dir = comparisonDir(outputDir, comparison.comparisonId);
  const template = await readPageTemplate(templateFile);
  if (template !== undefined) {
    await writeFileAtomic(
      path.join(dir, REPORT_PAGE_FILE),
      fillTemplate(template, comparisonPage(comparison, lang)),
    );
  }
  const at = reviewSamplesAt(await listResultEntries(dir));
  await writeFileAtomic(path.join(dir, REPORT_MARKDOWN_FILE), renderReport(comparison, lang, at));
  const index = template === undefined ? undefined : await writeIndex(outputDir, template, lang);
  return writtenFiles(dir, at, index);
}
