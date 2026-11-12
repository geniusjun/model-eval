import { expect, test, type Locator, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import type { ComparisonPage } from '../../src/report/schema.js';
import { openHtml, pageHtml, readComparisonPageFixture } from './pages.js';

// Model output reaches the page only as text (plan D5): markup, script ends, comment starts and
// replacement patterns in it show literally and never become elements or run.

const FIXTURE_PAGES = [
  'page-comparison-block.json',
  'page-comparison-undecided-partial.json',
  'page-comparison-no-gate.json',
] as const;

/** The candidate's answer to greet-ja, repeat 0: a failing example of script-ja (ja, raw). */
const RAW = 'こんにちは </script><!-- $& <img src=x onerror=alert(1)> ```js\nalert(1)\n``` 안녕';
const FINAL = 'こんにちは <b>ok</b> `` x `` $1';
/** The candidate's error on mood-vague-ko, repeat 0, a review sample. */
const ERROR = '429 rate limited <!-- $& -->';
/** The candidate's most common error message in the fixture. */
const TOP_MESSAGE = '429 rate limited `retry`';
/** Planted in its place in memory, so the metrics also show markup, script ends and newlines. */
const PLANTED_TOP_MESSAGE = '429 </script><!-- <img src=x onerror=alert(1)> <b>x</b> $&\nretry';

const CELL = 'script-ja (ja, raw)';

/** Each planted text with a view that shows it and the region it shows in. */
const SHOWN = [
  { hash: '#/cell/script-ja/ja/raw', region: CELL, text: RAW },
  { hash: '#/cell/script-ja/ja/raw', region: CELL, text: FINAL },
  { hash: '#/side/script-ja/greet-ja/0', region: en['side.heading'], text: RAW },
  { hash: '#/side/script-ja/greet-ja/0', region: en['side.heading'], text: FINAL },
  {
    hash: '#/side/no-unprompted-self-state/mood-vague-ko/0',
    region: en['side.heading'],
    text: ERROR,
  },
  { hash: '#/', region: en['metrics.heading'], text: PLANTED_TOP_MESSAGE },
] as const;

/** The planted texts as the fixture holds them, so a changed fixture fails here first. */
function fixtureTexts(fixture: ComparisonPage): string[] {
  const { samples, ops } = fixture.comparison;
  return [
    ...samples.texts.flatMap((sample) =>
      'error' in sample ? [sample.error.message] : [sample.raw, sample.final ?? ''],
    ),
    ...ops.candidate.topMessages.map((top) => top.message),
  ];
}

/** How many elements without child elements hold exactly `text`. */
function textElements(scope: Locator, text: string): Promise<number> {
  return scope.evaluate(
    (root, wanted) =>
      [...root.querySelectorAll('*')].filter(
        (element) => element.childElementCount === 0 && element.textContent === wanted,
      ).length,
    text,
  );
}

async function show(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

for (const name of FIXTURE_PAGES) {
  test(`002 FR-009 SC-004 shows the untrusted texts of ${name} literally and makes nothing of them`, async ({
    browser,
  }) => {
    // English, so regions are found by their English names whatever the fixture's language.
    const fixture = { ...(await readComparisonPageFixture(name)), lang: 'en' as const };
    expect(fixtureTexts(fixture)).toEqual(expect.arrayContaining([RAW, FINAL, ERROR, TOP_MESSAGE]));
    const [top] = fixture.comparison.ops.candidate.topMessages;
    if (top === undefined) {
      throw new Error(`${name} has no top message`);
    }
    top.message = PLANTED_TOP_MESSAGE;
    const opened = await openHtml(browser, await pageHtml(fixture));
    try {
      const { page } = opened;
      const scripts = await page.locator('script').count();
      for (const { hash, region, text } of SHOWN) {
        await show(page, hash);
        const scope = page.getByRole('region', { name: region, exact: true });
        await expect
          .poll(() => textElements(scope, text), { message: `${hash} ${text}` })
          .toBeGreaterThan(0);
      }
      await expect(page.locator('img, b, iframe, object, embed')).toHaveCount(0);
      await expect(page.locator('script')).toHaveCount(scripts);
      expect(opened.dialogs).toEqual([]);
    } finally {
      await opened.close();
    }
  });
}
