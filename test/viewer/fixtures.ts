import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  comparisonPageSchema,
  comparisonSchema,
  pageDataSchema,
  type Comparison,
  type ComparisonPage,
  type PageData,
} from '../../src/report/schema.js';

// The committed fixtures of test/fixtures/contracts (001 T023). The viewer project runs in
// jsdom, where Vite turns `new URL(…, import.meta.url)` into a page URL, so paths start from
// `import.meta.dirname`.

export const FIXTURES = path.join(import.meta.dirname, '../fixtures/contracts');

export const COMPARISON_FIXTURES = ['block', 'undecided-partial', 'no-gate'] as const;
export type ComparisonFixture = (typeof COMPARISON_FIXTURES)[number];

export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function readJsonFixture(name: string): unknown {
  return JSON.parse(readFixture(name));
}

/** A fresh, validated copy of a comparison fixture that a test may change. */
export function loadComparison(kind: ComparisonFixture): Comparison {
  return comparisonSchema.parse(readJsonFixture(`comparison-${kind}.json`));
}

export function loadPage(name: string): PageData {
  return pageDataSchema.parse(readJsonFixture(name));
}

export function loadComparisonPage(name: string): ComparisonPage {
  return comparisonPageSchema.parse(readJsonFixture(name));
}
