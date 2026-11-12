import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

import { configSchema } from '../../src/config/schema.js';
import { comparisonPage, fillTemplate } from '../../src/report/page-data.js';
import { createRedactor } from '../../src/report/redact.js';
import { comparisonSchema, type Comparison } from '../../src/report/schema.js';
import {
  openHtml,
  readComparisonPageFixture,
  readTemplate,
  ROOT,
  visitEveryView,
} from './pages.js';

// The page holds only what the writer redacted (FR-001): a phone number the example's `redact`
// rule matches never reaches the file or the screen, and its replacement shows as text.

const PHONE = '010-1234-5678';
const REPLACEMENT = '<phone>';

async function exampleRedactor() {
  const text = await readFile(path.join(ROOT, 'examples/pogo/model-eval.config.yaml'), 'utf8');
  return createRedactor(configSchema.parse(parseYaml(text)).redact);
}

/** The block fixture with the phone number in every sample text, error and top message. */
async function plantedComparison(): Promise<Comparison> {
  const { comparison } = await readComparisonPageFixture('page-comparison-block.json');
  const plant = (text: string) => `${text} ${PHONE}`;
  return {
    ...comparison,
    samples: {
      ...comparison.samples,
      texts: comparison.samples.texts.map((sample) =>
        'error' in sample
          ? { ...sample, error: { ...sample.error, message: plant(sample.error.message) } }
          : {
              ...sample,
              raw: plant(sample.raw),
              ...(sample.final === undefined ? {} : { final: plant(sample.final) }),
            },
      ),
    },
    ops: {
      ...comparison.ops,
      candidate: {
        ...comparison.ops.candidate,
        topMessages: comparison.ops.candidate.topMessages.map((top) => ({
          ...top,
          message: plant(top.message),
        })),
      },
    },
  };
}

test('002 FR-001 a phone number redacted by the example rule is in neither the file nor any view', async ({
  browser,
}) => {
  const planted = await plantedComparison();
  expect(JSON.stringify(planted)).toContain(PHONE);
  const redactor = await exampleRedactor();
  const redacted = comparisonSchema.parse(redactor.json(planted));
  const html = fillTemplate(await readTemplate(), comparisonPage(redacted, 'en'));
  expect(html).not.toContain(PHONE);
  expect(html).not.toContain(PHONE.replaceAll('-', ''));

  const opened = await openHtml(browser, html);
  try {
    const { page } = opened;
    const main = page.getByRole('main');
    let replacementsSeen = 0;
    await visitEveryView(page, async () => {
      const text = (await main.textContent()) ?? '';
      expect(text).not.toContain(PHONE);
      if (text.includes(REPLACEMENT)) {
        replacementsSeen += 1;
      }
    });
    expect(replacementsSeen).toBeGreaterThan(0);
    await page.evaluate(() => {
      window.location.hash = '#/side/script-ja/greet-ja/0';
    });
    await expect(main.getByText(REPLACEMENT).first()).toBeVisible();
  } finally {
    await opened.close();
  }
});
