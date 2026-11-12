import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import {
  examplePagePath,
  openFile,
  openHtml,
  pageHtml,
  readComparisonPageFixture,
  visitEveryView,
  type OpenedPage,
} from './pages.js';

// The page sends nothing anywhere (FR-010): no request beyond its own file, whatever the reader
// does, and nothing the CSP has to block.

const FIXTURE_PAGES = [
  'page-comparison-block.json',
  'page-comparison-undecided-partial.json',
  'page-comparison-no-gate.json',
] as const;

/** Switches the page to Korean and back with the language switch. */
async function switchLanguage(page: Page): Promise<void> {
  const select = page.getByRole('combobox', { name: en['language.label'] });
  await select.selectOption('ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.getByRole('combobox').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

async function useEverything(opened: OpenedPage): Promise<void> {
  const { page } = opened;
  let views = 0;
  await visitEveryView(page, () => {
    views += 1;
    return Promise.resolve();
  });
  expect(views).toBeGreaterThan(1);
  await switchLanguage(page);
  expect(opened.outsideRequests()).toEqual([]);
  expect(await opened.cspViolations()).toEqual([]);
}

for (const name of FIXTURE_PAGES) {
  test(`002 FR-010 ${name}: loading, every cell detail, every side-by-side position and the language switch make no request`, async ({
    browser,
  }) => {
    // English, so views are found by their English names whatever the fixture's language.
    const fixture = { ...(await readComparisonPageFixture(name)), lang: 'en' as const };
    const opened = await openHtml(browser, await pageHtml(fixture));
    try {
      await useEverything(opened);
    } finally {
      await opened.close();
    }
  });
}

test('002 FR-010 the example page: loading, every view and the language switch make no request', async ({
  browser,
}) => {
  const file = examplePagePath();
  const opened = await openFile(browser, path.dirname(file), path.basename(file));
  try {
    await useEverything(opened);
  } finally {
    await opened.close();
  }
});
