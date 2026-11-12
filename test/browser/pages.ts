import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import { DATA_PLACEHOLDER, fillTemplate } from '../../src/report/page-data.js';
import {
  comparisonPageSchema,
  pageDataSchema,
  type ComparisonPage,
  type PageData,
} from '../../src/report/schema.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const TEMPLATE = path.join(ROOT, 'dist/viewer/report.html');
export const FIXTURES = path.join(ROOT, 'test/fixtures/contracts');

/** The variable through which `global-setup.ts` passes the example page's path to the tests. */
export const EXAMPLE_PAGE_ENV = 'MODEL_EVAL_EXAMPLE_PAGE';

declare global {
  interface Window {
    /** Filled by the init script of `openFile`, which runs before the page's own script. */
    __modelEvalCspViolations?: string[];
  }
}

export function readTemplate(): Promise<string> {
  return readFile(TEMPLATE, 'utf8');
}

export async function readPageFixture(name: string): Promise<PageData> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return pageDataSchema.parse(JSON.parse(text));
}

export async function readComparisonPageFixture(name: string): Promise<ComparisonPage> {
  const text = await readFile(path.join(FIXTURES, name), 'utf8');
  return comparisonPageSchema.parse(JSON.parse(text));
}

/** The built template filled with a payload, as the writer of feature 001 fills it. */
export async function pageHtml(payload: PageData): Promise<string> {
  return fillTemplate(await readTemplate(), payload);
}

/**
 * The built template with `text` in its data block, for data the writer never produces: an
 * unknown schema version or a payload that fails validation. Every `<` is escaped as the
 * writer escapes it.
 */
export async function pageHtmlWithData(text: string): Promise<string> {
  const data = text.replaceAll('<', '\\u003c');
  return (await readTemplate()).replace(DATA_PLACEHOLDER, () => data);
}

export interface OpenedPage {
  readonly page: Page;
  readonly context: BrowserContext;
  /** The folder that holds the page files of this test. */
  readonly folder: string;
  /** Every request URL since the page's own navigation, in order. */
  readonly requests: readonly string[];
  readonly dialogs: readonly string[];
  /** Requests to anything but a `file://` URL of the page files of this test. */
  outsideRequests(): string[];
  /** The `securitypolicyviolation` events the page saw, as `<directive> <blocked URI>`. */
  cspViolations(): Promise<string[]>;
  close(): Promise<void>;
}

/** Opens `file` of `folder` over `file://` in a new offline context and records what it does. */
export async function openFile(
  browser: Browser,
  folder: string,
  file: string,
): Promise<OpenedPage> {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const requests: string[] = [];
  const dialogs: string[] = [];
  const folderUrl = `${pathToFileURL(folder).href}/`;
  page.on('request', (request) => {
    requests.push(request.url());
  });
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.__modelEvalCspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto(pathToFileURL(path.join(folder, file)).href);
  return {
    page,
    context,
    folder,
    requests,
    dialogs,
    outsideRequests: () => requests.filter((url) => !url.startsWith(folderUrl)),
    cspViolations: () => page.evaluate(() => window.__modelEvalCspViolations ?? []),
    close: () => context.close(),
  };
}

/** Writes `html` alone into a new temporary folder as `report.html` and opens it. */
export async function openHtml(browser: Browser, html: string): Promise<OpenedPage> {
  const folder = await mkdtemp(path.join(tmpdir(), 'model-eval-page-'));
  await writeFile(path.join(folder, 'report.html'), html);
  const opened = await openFile(browser, folder, 'report.html');
  return {
    ...opened,
    close: async () => {
      await opened.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

/** The example page of `global-setup.ts`. */
export function examplePagePath(): string {
  const file = process.env[EXAMPLE_PAGE_ENV];
  if (file === undefined) {
    throw new Error(
      `${EXAMPLE_PAGE_ENV} is not set; run the browser tests through playwright.config.ts`,
    );
  }
  return file;
}
