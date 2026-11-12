import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import { COMPARISON_FILE, comparisonDir, REPORT_PAGE_FILE } from '../../src/report/layout.js';
import { comparisonPage, fillTemplate, listPage } from '../../src/report/page-data.js';
import { comparisonSchema, type Comparison } from '../../src/report/schema.js';
import { FIXTURES, openFile, readTemplate } from './pages.js';

const INDEX_FILE = 'index.html';

/** The heading of the report page of every listed fixture: the title of report.md. */
const REPORT_HEADING = 'model-eval report: current (model-a) → next (model-b)';

/**
 * The three fixtures by `createdAt`, newest first. Their IDs sort `89…`, `c3…`, `ff…`, so this
 * order is neither name order nor its reverse, and only a sort by time gives it.
 */
const NEWEST = 'cmp-c3185cc21556';
const MIDDLE = 'cmp-ff954570aec2';
const OLDEST = 'cmp-89b170c0e72a';

async function readComparison(name: string): Promise<Comparison> {
  const text = await readFile(path.join(FIXTURES, `comparison-${name}.json`), 'utf8');
  return comparisonSchema.parse(JSON.parse(text));
}

/** Writes a comparison's `comparison.json` and `report.html` into `folder` of the output. */
async function writeComparison(
  outputDir: string,
  folder: string,
  comparison: Comparison,
  template: string,
): Promise<void> {
  const dir = comparisonDir(outputDir, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, COMPARISON_FILE), JSON.stringify(comparison));
  await writeFile(
    path.join(dir, REPORT_PAGE_FILE),
    fillTemplate(template, comparisonPage(comparison, 'en')),
  );
}

/**
 * An output directory with the three fixtures under their own IDs, a comparison a writer has not
 * finished in a `.tmp-` folder, and the `index.html` the writer makes of it.
 */
async function outputDirectory(): Promise<string> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'model-eval-list-'));
  const template = await readTemplate();
  for (const name of ['block', 'no-gate', 'undecided-partial']) {
    const comparison = await readComparison(name);
    await writeComparison(outputDir, comparison.comparisonId, comparison, template);
  }
  // Were the unfinished folder listed, its comparison would add a row, the newest one.
  const unfinished = {
    ...(await readComparison('no-gate')),
    createdAt: '2026-12-01T00:00:00.000Z',
  };
  await writeComparison(outputDir, `.tmp-${unfinished.comparisonId}`, unfinished, template);
  const list = await listPage(outputDir, 'en');
  await writeFile(path.join(outputDir, INDEX_FILE), fillTemplate(template, list));
  return outputDir;
}

test.describe('002 comparison list', () => {
  let outputDir = '';

  test.beforeEach(async () => {
    outputDir = await outputDirectory();
  });

  test.afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  test('002 FR-008 lists the finished comparisons by time, newest first, and not the unfinished one', async ({
    browser,
  }) => {
    const opened = await openFile(browser, outputDir, INDEX_FILE);
    try {
      const { page } = opened;
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(en['list.heading']);
      const table = page.getByRole('table', { name: en['list.heading'] });
      await expect(table.getByRole('rowheader')).toHaveText([NEWEST, MIDDLE, OLDEST]);
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  for (const comparisonId of [NEWEST, MIDDLE, OLDEST]) {
    test(`002 FR-008 FR-010 the link of ${comparisonId} opens its page without a request outside the output`, async ({
      browser,
    }) => {
      const opened = await openFile(browser, outputDir, INDEX_FILE);
      try {
        const { page } = opened;
        await page.getByRole('link', { name: comparisonId, exact: true }).click();
        await expect(page).toHaveURL(
          new RegExp(`/comparisons/${comparisonId}/${REPORT_PAGE_FILE.replace('.', '\\.')}$`),
        );
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(REPORT_HEADING);
        await expect(page.getByText(comparisonId, { exact: true }).first()).toBeVisible();
        expect(opened.outsideRequests()).toEqual([]);
        expect(await opened.cspViolations()).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  }
});
