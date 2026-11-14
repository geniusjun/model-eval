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
      const fixture = await readComparisonPageFixture(fixtureName);
      const opened = await openHtml(browser, await pageHtml(fixture));
      try {
        const { page } = opened;
        await expect(region(page, en['summary.heading'])).toBeVisible();
        await expect(region(page, en['grid.heading'])).toBeVisible();
        await expect(region(page, en['metrics.heading'])).toBeVisible();
        await expect(region(page, en['scope.heading'])).toBeVisible();
        await expect(page.getByRole('main').locator('footer')).toContainText(
          fixture.comparison.comparisonId,
        );
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

  /** The block fixture with model names long enough to wrap the title over several lines. */
  async function longTitlePayload(): Promise<ComparisonPage> {
    const fixture = await readComparisonPageFixture(BLOCK);
    const { baseline, candidate } = fixture.comparison;
    const long = (model: string) => `${model}-${'long-snapshot-name-'.repeat(4)}2026-11-01`;
    const rename = (run: typeof baseline) => ({
      ...run,
      variant: { ...run.variant, model: long(run.variant.model) },
    });
    return {
      ...fixture,
      comparison: {
        ...fixture.comparison,
        baseline: rename(baseline),
        candidate: rename(candidate),
      },
    };
  }

  /** The top bar's height before the page measures it: `--topbar-height`, 6.5rem. */
  const DEFAULT_BAR_HEIGHT = 104;

  for (const [name, payload, width, tallBar] of [
    ['the block page', () => readComparisonPageFixture(BLOCK), 1280, false],
    ['a title that wraps', longTitlePayload, 800, true],
  ] as const) {
    test(`002 FR-011 a section button of the top bar moves focus to its region heading below the bar and keeps the hash (${name})`, async ({
      browser,
    }) => {
      const opened = await openHtml(browser, await pageHtml(await payload()));
      try {
        const { page } = opened;
        await page.setViewportSize({ width, height: 720 });
        const sections = page.getByRole('navigation', { name: en['nav.label'], exact: true });
        const metrics = sections.getByRole('button', { name: new RegExp(`^${en['nav.metrics']}`) });
        await expect(sections.getByRole('button')).toHaveCount(5);
        await metrics.focus();
        await page.keyboard.press('Enter');
        const heading = page.getByRole('heading', { level: 2, name: en['metrics.heading'] });
        await expect(heading).toBeFocused();
        await expect(heading).toBeInViewport();
        // Shown below the sticky top bar, however tall the bar is, not under it.
        const headingBox = await heading.boundingBox();
        const barBox = await page.getByRole('main').locator('header').boundingBox();
        if (tallBar) {
          // The case is only worth its name if the bar outgrows the default padding.
          expect(barBox?.height ?? 0).toBeGreaterThan(DEFAULT_BAR_HEIGHT);
        }
        expect(headingBox?.y ?? -Infinity).toBeGreaterThanOrEqual(
          (barBox?.y ?? 0) + (barBox?.height ?? Infinity),
        );
        await expect(metrics).toHaveAttribute('aria-current', 'true');
        expect(new URL(page.url()).hash).toBe('');
        expect(opened.outsideRequests()).toEqual([]);
      } finally {
        await opened.close();
      }
    });
  }

  test('002 FR-016 supporting details start closed, open from the keyboard and leave cell and side links working', async ({
    browser,
  }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      const details = page.getByRole('main').locator('details');
      expect(await details.count()).toBeGreaterThanOrEqual(5);
      expect(
        await details.evaluateAll((all) => all.filter((item) => item.hasAttribute('open'))),
      ).toEqual([]);
      // Closed, the full metrics table is in the page but not shown.
      const metricsName = { name: en['metrics.table.caption'], exact: true };
      const allMetrics = page.getByRole('table', { ...metricsName, includeHidden: true });
      await expect(allMetrics).toHaveCount(1);
      await expect(allMetrics).toBeHidden();
      await page.locator('summary', { hasText: en['metrics.all'] }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('table', metricsName)).toBeVisible();
      await expect(
        page.getByRole('table', { name: en['metrics.responseModels'], exact: true }),
      ).toBeVisible();
      // The cell and side-by-side links still open their views.
      await page.goto(`${page.url().split('#')[0] ?? ''}#/cell/script-ja/ja/raw`);
      await page.reload();
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeVisible();
      await page.goto(
        `${page.url().split('#')[0] ?? ''}#/side/no-unprompted-self-state/mood-vague-ko/0`,
      );
      await page.reload();
      await expect(
        region(page, en['side.heading']).getByRole('heading', { level: 3, name: /mood-vague-ko/ }),
      ).toBeVisible();
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 FR-002 FR-011 a row of the change chart opens its cell detail from the keyboard', async ({
    browser,
  }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      const link = region(page, en['summary.heading']).getByRole('link', {
        name: SCRIPT_JA_RAW,
        exact: true,
      });
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#\/cell\/script-ja\/ja\/raw$/);
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeFocused();
      await expect(detailHeading(page, SCRIPT_JA_RAW)).toBeInViewport();
      expect(opened.outsideRequests()).toEqual([]);
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
