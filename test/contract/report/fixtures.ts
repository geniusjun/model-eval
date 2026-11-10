import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparisonSchema, type Comparison } from '../../../src/report/schema.js';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/contracts/', import.meta.url));

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

export function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), 'model-eval-report-'));
}
