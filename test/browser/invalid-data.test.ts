import { expect, test, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import { DATA_PLACEHOLDER } from '../../src/report/page-data.js';
import {
  openHtml,
  pageHtml,
  pageHtmlWithData,
  readComparisonPageFixture,
  readPageFixture,
  readTemplate,
} from './pages.js';

const BLOCK = 'page-comparison-block.json';

/** The heading of the report that the block fixture page shows: the title of report.md. */
const REPORT_HEADING = 'model-eval report: current (model-a) → next (model-b)';

/**
 * The page shows the error screen and nothing of the report: one heading, the language switch
 * and the one message, no section heading, no table and no figure.
 */
async function expectOnlyErrorScreen(page: Page, message: string): Promise<void> {
  const main = page.getByRole('main');
  await expect(main).toHaveCount(1);
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(en['invalid.heading']);
  await expect(page.getByRole('heading')).toHaveCount(1);
  await expect(main.locator('p')).toHaveText([message]);
  await expect(page.getByRole('combobox', { name: en['language.label'] })).toBeVisible();
  await expect(page.locator('table, svg, button, section')).toHaveCount(0);
}

test.describe('002 invalid data', () => {
  test('002 FR-012 shows the error screen naming version 2 and no report region', async ({
    browser,
  }) => {
    const payload = { ...(await readPageFixture(BLOCK)), schemaVersion: '2' };
    const opened = await openHtml(browser, await pageHtmlWithData(JSON.stringify(payload)));
    try {
      const named = en['invalid.unsupported'].replace('{found}', '2').replace('{supported}', '1');
      await expectOnlyErrorScreen(opened.page, named);
      expect(await opened.cspViolations()).toEqual([]);
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 FR-012 shows the error screen naming version 1 for a payload without comparison', async ({
    browser,
  }) => {
    const { comparison: _dropped, ...payload } = await readComparisonPageFixture(BLOCK);
    const opened = await openHtml(browser, await pageHtmlWithData(JSON.stringify(payload)));
    try {
      await expectOnlyErrorScreen(opened.page, en['invalid.mismatch'].replace('{found}', '1'));
    } finally {
      await opened.close();
    }
  });

  test('002 FR-012 says that no version was found when the placeholder is left as it is', async ({
    browser,
  }) => {
    const template = await readTemplate();
    expect(template).toContain(DATA_PLACEHOLDER);
    const opened = await openHtml(browser, template);
    try {
      await expectOnlyErrorScreen(opened.page, en['invalid.noVersion']);
    } finally {
      await opened.close();
    }
  });

  test('002 FR-010 FR-012 validates and renders a fixture page with no CSP violation and no request', async ({
    browser,
  }) => {
    const opened = await openHtml(browser, await pageHtml(await readPageFixture(BLOCK)));
    try {
      const { page } = opened;
      await expect(page.getByRole('heading', { level: 1, name: REPORT_HEADING })).toBeVisible();
      await expect(page.getByRole('heading', { name: en['invalid.heading'] })).toHaveCount(0);
      expect(await opened.cspViolations()).toEqual([]);
      expect(opened.outsideRequests()).toEqual([]);
      expect(opened.dialogs).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});
