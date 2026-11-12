import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import ko from '../../viewer/src/i18n/ko.json' with { type: 'json' };
import type { Lang } from '../../src/config/schema.js';
import type { ComparisonPage } from '../../src/report/schema.js';
import {
  openHtml,
  pageHtml,
  pageHtmlWithData,
  readComparisonPageFixture,
  readPageFixture,
  type OpenedPage,
} from './pages.js';

// plan D7: lint is the first line; axe on the rendered pages is the guarantee.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
const LANGS: readonly Lang[] = ['en', 'ko'];
const SCHEMES = ['light', 'dark'] as const;
const CATALOGS = { en, ko } as const;

const BLOCK = 'page-comparison-block.json';
const PARTIAL = 'page-comparison-undecided-partial.json';
const LIST = 'page-list.json';

type Scheme = (typeof SCHEMES)[number];

/** Opens `html` in `lang` through `?lang=`, which every page reads, under `scheme`. */
async function openIn(browser: Browser, html: string, lang: Lang, scheme: Scheme) {
  const opened = await openHtml(browser, html);
  const { page } = opened;
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${page.url()}#/?lang=${lang}`);
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
  return opened;
}

/**
 * Runs axe and expects no violation; `view` names what is open. With `include`, axe checks only
 * the elements that selector matches.
 */
async function expectNoViolation(page: Page, view: string, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  const results = await (include === undefined ? builder : builder.include(include)).analyze();
  const found = results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
  expect(found, view).toEqual([]);
}

/** The grid's cell buttons: the buttons of the tables captioned with a surface, in `lang`. */
function cellButtons(page: Page, lang: Lang) {
  const caption = new RegExp(`^${CATALOGS[lang]['grid.caption'].replace('{surface}', '.+')}$`);
  return page.getByRole('table', { name: caption }).getByRole('button');
}

/**
 * The rule buttons of the side-by-side view, found by their list alone. In Firefox under
 * Playwright 1.65, a page that runs axe and answers a `region` query by name crashes, in either
 * order and on any page; the cause is upstream.
 */
function sideRules(page: Page, lang: Lang) {
  return page
    .getByRole('list', { name: CATALOGS[lang]['side.rules'], exact: true })
    .getByRole('button');
}

/**
 * The selector of the section whose heading has focus: the cell detail or side-by-side position
 * that just opened, which moves focus to its heading.
 */
async function openedSection(page: Page): Promise<string> {
  await expect(page.locator('h3:focus')).toHaveCount(1);
  const selector = await page.evaluate(() => {
    const id = document.activeElement?.id ?? '';
    return `section[aria-labelledby="${CSS.escape(id)}"]`;
  });
  await expect(page.locator(selector)).toHaveCount(1);
  return selector;
}

async function withPage(opened: OpenedPage, check: (page: Page) => Promise<void>): Promise<void> {
  try {
    await check(opened.page);
  } finally {
    await opened.close();
  }
}

/** A fixture page with no latency values for the candidate, so its chart has nothing to draw. */
async function noLatencyPayload(): Promise<ComparisonPage> {
  const fixture = await readComparisonPageFixture(BLOCK);
  const { ops } = fixture.comparison;
  const candidate = { ...ops.candidate, latencyMs: { p50: null, p95: null, values: [] } };
  return {
    ...fixture,
    comparison: { ...fixture.comparison, ops: { ...ops, candidate } },
  };
}

test.describe('002 accessibility', () => {
  for (const lang of LANGS) {
    for (const scheme of SCHEMES) {
      for (const fixtureName of [BLOCK, PARTIAL]) {
        test(`002 FR-003 FR-011 FR-014 axe finds no violation with each cell detail and the side-by-side view open (${fixtureName}, ${lang}, ${scheme})`, async ({
          browser,
        }) => {
          const html = await pageHtml(await readComparisonPageFixture(fixtureName));
          await withPage(await openIn(browser, html, lang, scheme), async (page) => {
            await expectNoViolation(page, 'summary');
            const cells = cellButtons(page, lang);
            const count = await cells.count();
            expect(count).toBeGreaterThan(0);
            for (let index = 0; index < count; index += 1) {
              const cell = cells.nth(index);
              await cell.click();
              await expect(cell).toHaveAttribute('aria-expanded', 'true');
              await expectNoViolation(
                page,
                `detail of ${(await cell.textContent()) ?? ''}`,
                await openedSection(page),
              );
            }
            const rules = sideRules(page, lang);
            expect(await rules.count()).toBeGreaterThan(0);
            for (let index = 0; index < (await rules.count()); index += 1) {
              const rule = rules.nth(index);
              await rule.click();
              await expect(rule).toHaveAttribute('aria-pressed', 'true');
              await expectNoViolation(
                page,
                `side by side of ${(await rule.textContent()) ?? ''}`,
                await openedSection(page),
              );
            }
          });
        });
      }

      test(`002 FR-014 axe finds no violation on a page whose candidate has no latency values (${lang}, ${scheme})`, async ({
        browser,
      }) => {
        const html = await pageHtml(await noLatencyPayload());
        await withPage(await openIn(browser, html, lang, scheme), async (page) => {
          await expect(
            page.getByText(
              CATALOGS[lang]['metrics.latency.notMeasured'].replace('{variant}', 'next'),
            ),
          ).toBeVisible();
          await expectNoViolation(page, 'summary');
        });
      });

      test(`002 FR-012 FR-014 axe finds no violation on the invalid-data error screen (${lang}, ${scheme})`, async ({
        browser,
      }) => {
        const payload = { ...(await readPageFixture(BLOCK)), schemaVersion: '2' };
        const html = await pageHtmlWithData(JSON.stringify(payload));
        await withPage(await openIn(browser, html, lang, scheme), async (page) => {
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            CATALOGS[lang]['invalid.heading'],
          );
          await expectNoViolation(page, 'error screen');
        });
      });

      test(`002 FR-014 axe finds no violation on the list page (${lang}, ${scheme})`, async ({
        browser,
      }) => {
        const html = await pageHtml(await readPageFixture(LIST));
        await withPage(await openIn(browser, html, lang, scheme), async (page) => {
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            CATALOGS[lang]['list.heading'],
          );
          await expectNoViolation(page, 'list');
        });
      });
    }
  }
});
