import { expect, test, type Page } from '@playwright/test';

import en from '../../viewer/src/i18n/en.json' with { type: 'json' };
import ko from '../../viewer/src/i18n/ko.json' with { type: 'json' };
import type { Lang } from '../../src/config/schema.js';
import { verdictText } from '../../src/report/code-text.js';
import { verdictSchema, type ComparisonPage } from '../../src/report/schema.js';
import {
  cellButtons,
  openHtml,
  pageHtml,
  readComparisonPageFixture,
  SURFACE_CAPTION,
} from './pages.js';

const BLOCK = 'page-comparison-block.json';
const SCRIPT_JA_RAW = 'script-ja (ja, raw)';
const REVIEW_RULE = 'no-unprompted-self-state';

/** WCAG 2.1 AA for body text (1.4.3). */
const MIN_TEXT_CONTRAST = 4.5;

const REGION_KEYS = [
  'summary.heading',
  'grid.heading',
  'side.heading',
  'metrics.heading',
  'scope.heading',
  'scope.reproduction.heading',
] as const;

const CATALOGS = { en, ko } as const;

/** The Korean caption of a grid table; `SURFACE_CAPTION` is the English one. */
const SURFACE_CAPTION_KO = new RegExp(`^${ko['grid.caption'].replace('{surface}', '.+')}$`);

/** A run of Hangul letters, the script only Korean page strings and Korean data use. */
const HANGUL_WORD = /\p{Script=Hangul}+/gu;

function region(page: Page, name: string) {
  return page.getByRole('region', { name, exact: true });
}

async function expectRegionHeadings(page: Page, lang: Lang): Promise<void> {
  for (const key of REGION_KEYS) {
    await expect(region(page, CATALOGS[lang][key])).toBeVisible();
  }
}

/** Every string value in `value`, at any depth. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

/**
 * The Hangul words on the page that come from neither the data nor the name of the Korean
 * option. Model answers, case inputs and anchors may be Korean in any page language; any other
 * Hangul word is a page string that did not change language.
 */
async function untranslatedWords(page: Page, payload: ComparisonPage): Promise<string[]> {
  const allowed = new Set(
    [...strings(payload), en['language.ko']].flatMap((text) => text.match(HANGUL_WORD) ?? []),
  );
  const texts = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      found.push(node.textContent ?? '');
    }
    return found;
  });
  return texts
    .flatMap((text) => text.match(HANGUL_WORD) ?? [])
    .filter((word) => !allowed.has(word));
}

/** The block fixture with its cells spread over every verdict, so each badge colour shows. */
async function everyVerdictPayload(): Promise<ComparisonPage> {
  const fixture = await readComparisonPageFixture(BLOCK);
  const verdicts = verdictSchema.options;
  expect(fixture.comparison.cells.length).toBeGreaterThanOrEqual(verdicts.length);
  const cells = fixture.comparison.cells.map((cell, index) => ({
    ...cell,
    verdict: verdicts[index % verdicts.length] ?? cell.verdict,
  }));
  return { ...fixture, comparison: { ...fixture.comparison, cells } };
}

type Rgb = readonly [number, number, number];

/** A computed `rgb()` or opaque `rgba()` colour; the page uses only opaque colours. */
function parseRgb(css: string): Rgb {
  const match = /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*1)?\)$/.exec(
    css,
  );
  if (match === null) {
    throw new Error(`not an opaque rgb colour: ${css}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Relative luminance of WCAG 2.1. */
function luminance([red, green, blue]: Rgb): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(parseRgb(foreground)), luminance(parseRgb(background))].sort(
    (a, b) => b - a,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

interface ColourPair {
  readonly color: string;
  readonly background: string;
}

/** The page background and the colour of the body text written on it. */
function pageColours(page: Page): Promise<ColourPair> {
  return page.evaluate(() => {
    const paragraph = document.querySelector('main p');
    if (paragraph === null) {
      throw new Error('the page has no paragraph');
    }
    return {
      color: getComputedStyle(paragraph).color,
      background: getComputedStyle(document.documentElement).backgroundColor,
    };
  });
}

/** The colours of the verdict badge inside the grid cell button whose label is `label`. */
function badgeColours(page: Page, label: string, verdict: string): Promise<ColourPair> {
  return cellButtons(page, SURFACE_CAPTION)
    .filter({ hasText: label })
    .getByText(verdict, { exact: true })
    .evaluate((badge) => ({
      color: getComputedStyle(badge).color,
      background: getComputedStyle(badge).backgroundColor,
    }));
}

test.describe('002 language and theme', () => {
  test('002 FR-013 a Korean payload starts in Korean; English writes ?lang=en, changes every page string and survives a reload', async ({
    browser,
  }) => {
    const fixture = await readComparisonPageFixture(BLOCK);
    const payload: ComparisonPage = { ...fixture, lang: 'ko' };
    const opened = await openHtml(browser, await pageHtml(payload));
    try {
      const { page } = opened;
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await expectRegionHeadings(page, 'ko');
      for (const cell of fixture.comparison.cells) {
        const label = `${cell.ruleId} (${cell.lang}, ${cell.surface})`;
        await expect(
          cellButtons(page, SURFACE_CAPTION_KO).filter({ hasText: label }),
        ).toContainText(verdictText('ko', cell.verdict));
      }

      await page.getByRole('combobox', { name: ko['language.label'] }).selectOption('en');
      await expect(page).toHaveURL(/#\/\?lang=en$/);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expectRegionHeadings(page, 'en');
      expect(await untranslatedWords(page, payload)).toEqual([]);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expectRegionHeadings(page, 'en');
      expect(await untranslatedWords(page, payload)).toEqual([]);

      await cellButtons(page, SURFACE_CAPTION).filter({ hasText: SCRIPT_JA_RAW }).click();
      await expect(page.getByRole('heading', { level: 3, name: SCRIPT_JA_RAW })).toBeVisible();
      await expect(page).toHaveURL(/#\/cell\/script-ja\/ja\/raw\?lang=en$/);
      expect(await untranslatedWords(page, payload)).toEqual([]);

      await region(page, en['side.heading'])
        .getByRole('button', { name: REVIEW_RULE, exact: true })
        .click();
      await expect(page).toHaveURL(/#\/side\/.+\?lang=en$/);
      expect(await untranslatedWords(page, payload)).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  test('002 FR-013 ?lang=ko overrides an English payload', async ({ browser }) => {
    const fixture = await readComparisonPageFixture(BLOCK);
    expect(fixture.lang).toBe('en');
    const opened = await openHtml(browser, await pageHtml(fixture));
    try {
      const { page } = opened;
      await page.goto(`${page.url()}#/?lang=ko`);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await expectRegionHeadings(page, 'ko');
    } finally {
      await opened.close();
    }
  });

  test('002 FR-014 light and dark schemes differ, and body text and every verdict badge reach 4.5:1', async ({
    browser,
  }) => {
    const payload = await everyVerdictPayload();
    const opened = await openHtml(browser, await pageHtml(payload));
    try {
      const { page } = opened;
      const backgrounds: string[] = [];
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const body = await pageColours(page);
        backgrounds.push(body.background);
        expect(
          contrast(body.color, body.background),
          `${colorScheme} body text`,
        ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        for (const cell of payload.comparison.cells) {
          const label = `${cell.ruleId} (${cell.lang}, ${cell.surface})`;
          const badge = await badgeColours(page, label, verdictText('en', cell.verdict));
          expect(
            contrast(badge.color, badge.background),
            `${colorScheme} ${cell.verdict} badge`,
          ).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        }
      }
      expect(new Set(backgrounds).size).toBe(2);
    } finally {
      await opened.close();
    }
  });
});
