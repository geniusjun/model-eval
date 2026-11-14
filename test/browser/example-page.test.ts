import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import { comparisonPageSchema, type ComparisonPage } from '../../src/report/schema.js';
import {
  cellButtons,
  examplePagePath,
  openEveryCellByKeyboard,
  openFile,
  SURFACE_CAPTION,
  tabKey,
} from './pages.js';

const MAX_BYTES = 1_000_000;
const SUMMARY_WITHIN_MS = 2_000;
const BLOCKING_CELL = 'script-ja (ja, raw)';
const ANCHOR = '日本語だけで話す';
/** The commit, date and layer of the origin `examples/pogo/rules/pogo.yaml` gives script-ja. */
const ORIGIN = ['7e8f9a0', '2026-03-04', 'prompt'] as const;

const DATA_BLOCK = /<script type="application\/json" id="model-eval-data">([^<]*)<\/script>/;

/** The payload the example page carries, read back from its data block. */
async function examplePayload(): Promise<ComparisonPage> {
  const html = await readFile(examplePagePath(), 'utf8');
  const data = DATA_BLOCK.exec(html)?.[1];
  if (data === undefined) {
    throw new Error('the example page has no data block');
  }
  return comparisonPageSchema.parse(JSON.parse(data));
}

function openExample(browser: Parameters<typeof openFile>[0]) {
  const file = examplePagePath();
  return openFile(browser, path.dirname(file), path.basename(file));
}

test.describe('002 example page', () => {
  test('002 SC-001 is one file of at most 1,000,000 bytes', async () => {
    expect((await stat(examplePagePath())).size).toBeLessThanOrEqual(MAX_BYTES);
  });

  test('002 SC-002 shows the decision summary within 2 seconds, naming the blocking cell', async ({
    browser,
  }) => {
    const opened = await openExample(browser);
    try {
      const { page } = opened;
      const summary = page.getByRole('region', { name: en['summary.heading'], exact: true });
      await expect(summary).toBeVisible({ timeout: SUMMARY_WITHIN_MS });
      // Milliseconds since the navigation started, read after the summary showed.
      expect(await page.evaluate(() => performance.now())).toBeLessThan(SUMMARY_WITHIN_MS);
      // The blocking cell is the first row of the worse cells in the change chart.
      const worse = summary.locator('tbody').filter({
        has: page.getByRole('rowheader', { name: new RegExp(`^${en['summary.worse']}`) }),
      });
      await expect(worse.getByRole('link', { name: BLOCKING_CELL, exact: true })).toHaveCount(1);
      await expect(worse.getByRole('link').first()).toHaveText(BLOCKING_CELL);
      // The gate's reasons and blocking cells open from the line under the outcome.
      await summary.locator('summary', { hasText: en['summary.gateDetails'] }).click();
      const blocking = summary.locator('dt', { hasText: en['summary.blocking'] }).locator('+ dd');
      await expect(blocking.getByRole('listitem')).toHaveText([BLOCKING_CELL]);
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 SC-003 the blocking cell detail shows its prompt sentence and the rule origin', async ({
    browser,
  }) => {
    const opened = await openExample(browser);
    try {
      const { page } = opened;
      await cellButtons(page, SURFACE_CAPTION).filter({ hasText: BLOCKING_CELL }).click();
      const detail = page.getByRole('region', { name: BLOCKING_CELL, exact: true });
      await expect(detail.getByText(ANCHOR, { exact: true })).toBeVisible();
      await expect(
        detail.getByRole('heading', { name: en['grid.detail.origin'], exact: true }),
      ).toBeVisible();
      for (const part of ORIGIN) {
        await expect(detail.getByText(part, { exact: true })).toBeVisible();
      }
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 SC-001 every cell detail opens by keyboard alone, with no request', async ({
    browser,
    browserName,
  }) => {
    const { comparison } = await examplePayload();
    const opened = await openExample(browser);
    try {
      const texts = await openEveryCellByKeyboard(
        opened.page,
        SURFACE_CAPTION,
        tabKey(browserName),
      );
      expect(texts).toHaveLength(comparison.cells.length);
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});
