import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  comparisonPage,
  fillTemplate,
  listPage,
  serializePageData,
} from '../../../src/report/page-data.js';
import { pageDataSchema } from '../../../src/report/schema.js';
import {
  COMPARISON_FIXTURES,
  loadComparison,
  readFixture,
  readJsonFixture,
  temporaryDirectory,
} from './fixtures.js';

const OPEN_TAG = '<script type="application/json" id="model-eval-data">';
const PLACEHOLDER = '__MODEL_EVAL_DATA__';

const directories: string[] = [];

function outputDirectory(): string {
  const directory = temporaryDirectory();
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The text between the data block's opening tag and the first `</script>` after it. */
function dataBlock(page: string): string {
  const start = page.indexOf(OPEN_TAG) + OPEN_TAG.length;
  return page.slice(start, page.indexOf('</script>', start));
}

describe('page payloads', () => {
  it('001 FR-031 a comparison payload is the page fixture of its comparison', () => {
    for (const kind of COMPARISON_FIXTURES) {
      const expected = pageDataSchema.parse(readJsonFixture(`page-comparison-${kind}.json`));
      expect(comparisonPage(loadComparison(kind), expected.lang), kind).toEqual(expected);
    }
  });

  it('001 FR-031 writes every < as \\u003c and keeps the JSON value', () => {
    const page = comparisonPage(loadComparison('block'), 'en');
    const serialized = serializePageData(page);
    expect(serialized).not.toContain('<');
    expect(serialized).toContain('\\u003c/script>\\u003c!--');
    expect(JSON.parse(serialized)).toEqual(page);
  });

  it('001 FR-031 fills the template with a replacer function, so $& and $1 stay literal', () => {
    const template = readFixture('template.html');
    const page = comparisonPage(loadComparison('block'), 'en');
    const filled = fillTemplate(template, page);
    const [before, after] = template.split(PLACEHOLDER);
    expect(filled.startsWith(before ?? '')).toBe(true);
    expect(filled.endsWith(after ?? '')).toBe(true);
    expect(filled.slice((before ?? '').length, filled.length - (after ?? '').length)).toBe(
      serializePageData(page),
    );
    const block = dataBlock(filled);
    expect(block).toBe(serializePageData(page));
    expect(block).toContain('$&');
    expect(block).toContain('$1');
    expect(block).not.toContain(PLACEHOLDER);
    expect(pageDataSchema.parse(JSON.parse(block))).toEqual(page);
  });

  it('001 FR-031 leaves the template and its CSP untouched outside the data block', () => {
    const template = readFixture('template.html');
    const filled = fillTemplate(template, comparisonPage(loadComparison('no-gate'), 'ko'));
    const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(template)?.[0];
    expect(csp).toBeDefined();
    expect(filled).toContain(csp);
    expect(filled.split('<script')).toHaveLength(template.split('<script').length);
    expect(filled.split('</script>')).toHaveLength(template.split('</script>').length);
  });

  it('001 FR-031 refuses a template without exactly one data placeholder', () => {
    const page = comparisonPage(loadComparison('block'), 'en');
    expect(() => fillTemplate('<html></html>', page)).toThrow(PLACEHOLDER);
    expect(() => fillTemplate(`${PLACEHOLDER}${PLACEHOLDER}`, page)).toThrow(PLACEHOLDER);
  });

  it('001 FR-031 lists the comparison folders newest first and skips .tmp- names (D6)', async () => {
    const output = outputDirectory();
    const comparisons = path.join(output, 'comparisons');
    for (const kind of COMPARISON_FIXTURES) {
      const comparison = loadComparison(kind);
      const folder = path.join(comparisons, comparison.comparisonId);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'comparison.json'), JSON.stringify(comparison));
    }
    const leftover = path.join(comparisons, '.tmp-4242-0a1b2c3d4e5f');
    mkdirSync(leftover);
    writeFileSync(path.join(leftover, 'comparison.json'), '{"cut');
    writeFileSync(path.join(comparisons, '.tmp-4242-ffff-comparison.json'), '{');
    expect(await listPage(output, 'en')).toEqual(
      pageDataSchema.parse(readJsonFixture('page-list.json')),
    );
  });

  it('001 FR-031 skips folders without a readable comparison instead of failing the list', async () => {
    const output = outputDirectory();
    const comparisons = path.join(output, 'comparisons');
    const comparison = loadComparison('block');
    const save = (name: string, text: string) => {
      mkdirSync(path.join(comparisons, name), { recursive: true });
      writeFileSync(path.join(comparisons, name, 'comparison.json'), text);
    };
    save(comparison.comparisonId, JSON.stringify(comparison));
    save('cmp-000000000001', '{"cut');
    save('cmp-000000000002', JSON.stringify({ ...comparison, schemaVersion: '0', cells: 'old' }));
    mkdirSync(path.join(comparisons, 'cmp-000000000003'));
    writeFileSync(path.join(comparisons, 'cmp-000000000004'), 'not a folder');
    const page = await listPage(output, 'en');
    expect(page.comparisons.map((entry) => entry.comparisonId)).toEqual([comparison.comparisonId]);
  });

  it('001 FR-031 names each entry by its folder and breaks ties in code-unit order', async () => {
    const output = outputDirectory();
    const comparisons = path.join(output, 'comparisons');
    const comparison = loadComparison('no-gate');
    for (const name of ['cmp-a', 'cmp-B']) {
      mkdirSync(path.join(comparisons, name), { recursive: true });
      writeFileSync(path.join(comparisons, name, 'comparison.json'), JSON.stringify(comparison));
    }
    const page = await listPage(output, 'en');
    expect(page.comparisons.map(({ comparisonId, href }) => [comparisonId, href])).toEqual([
      ['cmp-B', 'comparisons/cmp-B/report.html'],
      ['cmp-a', 'comparisons/cmp-a/report.html'],
    ]);
  });

  it('001 FR-031 lists nothing before the first comparison', async () => {
    expect(await listPage(outputDirectory(), 'ko')).toEqual({
      schemaVersion: '1',
      kind: 'list',
      lang: 'ko',
      comparisons: [],
    });
  });
});
