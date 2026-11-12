import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import {
  examplePagePath,
  openFile,
  openHtml,
  pageHtml,
  readComparisonPageFixture,
  tabKey,
  tabTo,
} from './pages.js';

const BLOCK = 'page-comparison-block.json';
const REVIEW_RULE = 'no-unprompted-self-state';

function sideRegion(page: Page) {
  return page.getByRole('region', { name: en['side.heading'], exact: true });
}

/** The heading of the shown position, which names the rule, the case and the repeat. */
function positionHeading(page: Page) {
  return sideRegion(page).getByRole('heading', { level: 3, name: new RegExp(REVIEW_RULE) });
}

function moveButton(page: Page, key: 'side.nextCase' | 'side.nextRepeat') {
  return sideRegion(page).getByRole('button', { name: en[key], exact: true });
}

/** Opens the review rule with the keyboard only; focus lands on the position heading. */
async function openReviewRule(page: Page, key: string): Promise<void> {
  await tabTo(page, REVIEW_RULE, key);
  await page.keyboard.press('Enter');
  await expect(positionHeading(page)).toBeFocused();
}

test.describe('002 side by side', () => {
  test('002 FR-005 FR-011 on the block page, the keyboard opens the review rule and shows the transient error in place of the answer', async ({
    browser,
    browserName,
  }) => {
    const opened = await openHtml(browser, await pageHtml(await readComparisonPageFixture(BLOCK)));
    try {
      const { page } = opened;
      const key = tabKey(browserName);
      await openReviewRule(page, key);
      await expect(positionHeading(page)).toContainText('mood-vague-ko');
      const candidate = sideRegion(page).getByRole('group', { name: 'Candidate (next)' });
      await expect(
        candidate.getByText(en['sample.error'].replace('{kind}', 'transient'), { exact: true }),
      ).toBeVisible();
      await expect(
        candidate.getByText('429 rate limited <!-- $& -->', { exact: true }),
      ).toBeVisible();
      // One case with one repeat: every move stops at the end.
      for (const move of ['side.nextCase', 'side.nextRepeat'] as const) {
        await tabTo(page, en[move], key);
        await page.keyboard.press('Enter');
        await expect(moveButton(page, move)).toHaveAttribute('aria-disabled', 'true');
        await expect(positionHeading(page)).toContainText('mood-vague-ko');
      }
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 SC-001 on the example page, the review rule steps through its cases and repeats', async ({
    browser,
    browserName,
  }) => {
    const file = examplePagePath();
    const opened = await openFile(browser, path.dirname(file), path.basename(file));
    try {
      const { page } = opened;
      const key = tabKey(browserName);
      await openReviewRule(page, key);
      const heading = positionHeading(page);
      await expect(heading).toContainText('mood-vague-en');
      await tabTo(page, en['side.nextRepeat'], key);
      await page.keyboard.press('Enter');
      await expect(heading).toContainText('mood-vague-en · repeat 1');
      await page.keyboard.press('Enter');
      await expect(heading).toContainText('mood-vague-en · repeat 2');
      await expect(moveButton(page, 'side.nextRepeat')).toHaveAttribute('aria-disabled', 'true');
      await tabTo(page, en['side.nextCase'], key);
      await page.keyboard.press('Enter');
      await expect(heading).toContainText('mood-vague-ja · repeat 0');
      await page.keyboard.press('Enter');
      await expect(heading).toContainText('mood-vague-ko · repeat 0');
      await expect(moveButton(page, 'side.nextCase')).toHaveAttribute('aria-disabled', 'true');
      expect(opened.outsideRequests()).toEqual([]);
    } finally {
      await opened.close();
    }
  });
});
