import { expect, test, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import type { ComparisonPage } from '../../src/report/schema.js';
import {
  cellButtons,
  openEveryCellByKeyboard,
  openHtml,
  pageHtml,
  readComparisonPageFixture,
  SURFACE_CAPTION,
  tabKey,
} from './pages.js';

const BLOCK = 'page-comparison-block.json';
const PARTIAL = 'page-comparison-undecided-partial.json';

function region(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

function cellLabels(fixture: ComparisonPage): string[] {
  return fixture.comparison.cells.map((cell) => `${cell.ruleId} (${cell.lang}, ${cell.surface})`);
}

const SCRIPT_JA_RAW = 'script-ja (ja, raw)';

function detailHeading(page: Page, label: string) {
  return page.getByRole('heading', { level: 3, name: label, exact: true });
}

test.describe('002 report page', () => {
  for (const fixtureName of [BLOCK, PARTIAL]) {
    test(`002 FR-001 FR-007 opened alone and offline, shows every region and a cell detail (${fixtureName})`, async ({
      browser,
    }) => {
      const opened = await openHtml(
        browser,
        await pageHtml(await readComparisonPageFixture(fixtureName)),
      );
      try {
        const { page } = opened;
        await expect(region(page, en['summary.heading'])).toBeVisible();
        await expect(region(page, en['grid.heading'])).toBeVisible();
        await expect(region(page, en['metrics.heading'])).toBeVisible();
        await expect(region(page, en['scope.heading'])).toBeVisible();
        await expect(region(page, en['scope.reproduction.heading'])).toBeVisible();
        await cellButtons(page, SURFACE_CAPTION).filter({ hasText: SCRIPT_JA_RAW }).click();
        await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeVisible();
        expect(opened.outsideRequests()).toEqual([]);
        expect(await opened.cspViolations()).toEqual([]);
      } finally {
        await opened.close();
      }
    });

    test(`002 FR-011 Tab reaches every cell; Enter opens and Escape closes each detail (${fixtureName})`, async ({
      browser,
      browserName,
    }) => {
      const fixture = await readComparisonPageFixture(fixtureName);
      const opened = await openHtml(browser, await pageHtml(fixture));
      try {
        const texts = await openEveryCellByKeyboard(
          opened.page,
          SURFACE_CAPTION,
          tabKey(browserName),
        );
        const reached = cellLabels(fixture).filter((label) =>
          texts.some((text) => text.startsWith(label)),
        );
        expect(reached).toEqual(cellLabels(fixture));
      } finally {
        await opened.close();
      }
    });
  }

  test('002 FR-011 going back closes the detail and puts focus back on its cell', async ({
    browser,
  }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      const cell = cellButtons(page, SURFACE_CAPTION).filter({ hasText: SCRIPT_JA_RAW });
      await cell.focus();
      await page.keyboard.press('Enter');
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeFocused();
      await page.goBack();
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toHaveCount(0);
      await expect(cell).toBeFocused();
    } finally {
      await opened.close();
    }
  });

  test('002 FR-011 Escape in the language switch leaves the detail open', async ({ browser }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      await cellButtons(page, SURFACE_CAPTION).filter({ hasText: SCRIPT_JA_RAW }).click();
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeVisible();
      const languages = page.getByRole('combobox', { name: en['language.label'] });
      await languages.focus();
      await page.keyboard.press('Escape');
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeVisible();
      await expect(languages).toBeFocused();
    } finally {
      await opened.close();
    }
  });

  test('002 FR-004 reloading with a cell hash opens that detail', async ({ browser }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      await page.goto(`${page.url()}#/cell/script-ja/ja/raw`);
      await page.reload();
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeVisible();
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 FR-002 FR-007 the partial page shows the withheld banner on top and the gate undecided', async ({
    browser,
  }) => {
    const opened = await openHtml(
      browser,
      await pageHtml(await readComparisonPageFixture(PARTIAL)),
    );
    try {
      const { page } = opened;
      const banner = region(page, en['summary.withheld']);
      await expect(banner).toBeVisible();
      const firstRegion = page.getByRole('main').locator('section').first();
      await expect(firstRegion).toHaveAccessibleName(en['summary.withheld']);
      const bannerTop = (await banner.boundingBox())?.y ?? Infinity;
      const headingTop =
        (await page.getByRole('heading', { level: 1 }).boundingBox())?.y ?? -Infinity;
      expect(bannerTop).toBeLessThan(headingTop);
      const summary = region(page, en['summary.heading']);
      const gate = summary.locator('dt', { hasText: en['summary.gate'] }).locator('+ dd');
      await expect(gate).toHaveText('UNDECIDED');
    } finally {
      await opened.close();
    }
  });
});
