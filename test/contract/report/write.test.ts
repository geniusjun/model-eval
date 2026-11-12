import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { comparisonPage, listPage } from '../../../src/report/page-data.js';
import { renderReport } from '../../../src/report/markdown.js';
import {
  comparisonSchema,
  listPageSchema,
  pageDataSchema,
  type ListPage,
  type PageData,
} from '../../../src/report/schema.js';
import { PAGE_TEMPLATE, readPageTemplate } from '../../../src/report/template.js';
import { rewriteReport, writeComparison, writeIndex } from '../../../src/report/write.js';
import {
  FIXTURES,
  loadComparison,
  readFixture,
  readJsonFixture,
  temporaryDirectory,
} from './fixtures.js';

/** A page template with the data block of 002 page-data §Embedded Block. */
const TEMPLATE_FILE = path.join(FIXTURES, 'template.html');
const OPEN_TAG = '<script type="application/json" id="model-eval-data">';

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

/** A template path that does not exist, as in a source checkout without the viewer build. */
function missingTemplate(): string {
  return path.join(outputDirectory(), 'viewer', 'report.html');
}

/** The payload a written page carries in its data block. */
function pageData(file: string): PageData {
  const html = readFileSync(file, 'utf8');
  const start = html.indexOf(OPEN_TAG) + OPEN_TAG.length;
  return pageDataSchema.parse(JSON.parse(html.slice(start, html.indexOf('</script>', start))));
}

function temporaryNames(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) =>
    path.basename(name).startsWith('.tmp-'),
  );
}

describe('comparison writer', () => {
  it('001 FR-029 writes comparisons/<comparisonId>/ with comparison.json and report.md (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'en' });
    const folder = path.join(output, 'comparisons', comparison.comparisonId);
    expect(written).toEqual({
      dir: folder,
      comparison: path.join(folder, 'comparison.json'),
      report: path.join(folder, 'report.md'),
      templateFound: false,
    });
    expect(readdirSync(folder).sort()).toEqual(['comparison.json', 'report.md']);
    const saved = comparisonSchema.parse(JSON.parse(readFileSync(written.comparison, 'utf8')));
    expect(readFileSync(written.report, 'utf8')).toBe(renderReport(saved, 'en'));
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-031 writes the redacted comparison as it is, so no text is redacted twice', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('undecided-partial');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'ko' });
    expect(JSON.parse(readFileSync(written.comparison, 'utf8'))).toEqual(comparison);
    expect(readFileSync(written.report, 'utf8')).toBe(renderReport(comparison, 'ko'));
  });

  it('001 FR-029 replaces each file of an existing comparison folder (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('no-gate');
    const folder = path.join(output, 'comparisons', comparison.comparisonId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'comparison.json'), '{"old": true}');
    writeFileSync(path.join(folder, 'report.md'), 'old report');
    writeFileSync(path.join(folder, 'report.html'), 'kept');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'en' });
    const saved = comparisonSchema.parse(JSON.parse(readFileSync(written.comparison, 'utf8')));
    expect(saved.comparisonId).toBe(comparison.comparisonId);
    expect(readFileSync(written.report, 'utf8')).toBe(renderReport(saved, 'en'));
    expect(readFileSync(path.join(folder, 'report.html'), 'utf8')).toBe('kept');
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-029 points report.md to samples.review in comparison.json, or to the result page the folder holds', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'en' });
    expect(written.page).toBeUndefined();
    const report = readFileSync(written.report, 'utf8');
    expect(report).toContain('side by side in `samples.review` of `comparison.json`');
    expect(report).not.toContain('result page');

    writeFileSync(path.join(written.dir, 'report.html'), 'page');
    const rewritten = await rewriteReport({ outputDir: output, comparison, lang: 'en' });
    expect(rewritten.page).toBe(path.join(written.dir, 'report.html'));
    const withPage = readFileSync(rewritten.report, 'utf8');
    expect(withPage).toBe(renderReport(comparison, 'en', 'result-page'));
    expect(withPage).toContain('side by side on the result page');
    expect(withPage).not.toContain('samples.review');
  });

  it('001 FR-029 two writers of the same comparison never mix their writes (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const writes = await Promise.all(
      (['en', 'ko', 'en', 'ko'] as const).map((lang) =>
        writeComparison({ outputDir: output, comparison, lang }),
      ),
    );
    const report = readFileSync(writes[0]?.report ?? '', 'utf8');
    const saved = comparisonSchema.parse(
      JSON.parse(readFileSync(writes[0]?.comparison ?? '', 'utf8')),
    );
    expect([renderReport(saved, 'en'), renderReport(saved, 'ko')]).toContain(report);
    expect(readdirSync(path.join(output, 'comparisons'))).toEqual([comparison.comparisonId]);
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-031 with the page template, writes report.html with the comparison and the output index.html listing it', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({
      outputDir: output,
      comparison,
      lang: 'ko',
      templateFile: TEMPLATE_FILE,
    });
    const folder = path.join(output, 'comparisons', comparison.comparisonId);
    expect(written).toEqual({
      dir: folder,
      comparison: path.join(folder, 'comparison.json'),
      report: path.join(folder, 'report.md'),
      page: path.join(folder, 'report.html'),
      index: path.join(output, 'index.html'),
      templateFound: true,
    });
    expect(readdirSync(folder).sort()).toEqual(['comparison.json', 'report.html', 'report.md']);
    expect(pageData(path.join(folder, 'report.html'))).toEqual(comparisonPage(comparison, 'ko'));
    expect(pageData(path.join(output, 'index.html'))).toEqual(await listPage(output, 'ko'));
    expect(readFileSync(written.report, 'utf8')).toBe(
      renderReport(comparison, 'ko', 'result-page'),
    );
    // Everything outside the data block is the template as it is, its CSP included.
    const template = readFixture('template.html');
    const html = readFileSync(path.join(folder, 'report.html'), 'utf8');
    expect(html.startsWith(template.slice(0, template.indexOf(OPEN_TAG)))).toBe(true);
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-031 lists every saved comparison in index.html, newest first', async () => {
    const output = outputDirectory();
    for (const kind of ['no-gate', 'block', 'undecided-partial'] as const) {
      await writeComparison({
        outputDir: output,
        comparison: loadComparison(kind),
        lang: 'en',
        templateFile: TEMPLATE_FILE,
      });
    }
    const index = listPageSchema.parse(pageData(path.join(output, 'index.html')));
    expect(index.comparisons.map((entry) => entry.comparisonId)).toEqual([
      'cmp-c3185cc21556',
      'cmp-ff954570aec2',
      'cmp-89b170c0e72a',
    ]);
  });

  it('001 FR-031 report writes report.md, report.html and index.html again with the page template', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('no-gate');
    const first = await writeComparison({
      outputDir: output,
      comparison,
      lang: 'en',
      templateFile: missingTemplate(),
    });
    expect(first.page).toBeUndefined();
    const rewritten = await rewriteReport({
      outputDir: output,
      comparison,
      lang: 'ko',
      templateFile: TEMPLATE_FILE,
    });
    expect(rewritten.page).toBe(path.join(first.dir, 'report.html'));
    expect(rewritten.index).toBe(path.join(output, 'index.html'));
    expect(pageData(path.join(first.dir, 'report.html'))).toEqual(comparisonPage(comparison, 'ko'));
    expect(pageData(path.join(output, 'index.html'))).toEqual(await listPage(output, 'ko'));
    expect(readFileSync(rewritten.report, 'utf8')).toBe(
      renderReport(comparison, 'ko', 'result-page'),
    );
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-031 without the page template, writes no report.html and no index.html', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({
      outputDir: output,
      comparison,
      lang: 'en',
      templateFile: missingTemplate(),
    });
    expect(written.page).toBeUndefined();
    expect(written.index).toBeUndefined();
    expect(readdirSync(written.dir).sort()).toEqual(['comparison.json', 'report.md']);
    expect(readdirSync(output)).toEqual(['comparisons']);
    expect(readFileSync(written.report, 'utf8')).toBe(renderReport(comparison, 'en'));
  });
});

describe('index writer', () => {
  /** The list fixture cut to its first `count` comparisons, as a listing at some moment. */
  function listing(count: number): ListPage {
    const full = listPageSchema.parse(readJsonFixture('page-list.json'));
    return { ...full, comparisons: full.comparisons.slice(0, count) };
  }

  /** A listing step that returns the given listings in turn, then the last one again. */
  function listings(...pages: ListPage[]) {
    let call = 0;
    const list = () => {
      const page = pages[Math.min(call, pages.length - 1)] ?? listing(0);
      call += 1;
      return Promise.resolve(page);
    };
    return { list, calls: () => call };
  }

  it('001 FR-031 writes index.html once when the folders did not change meanwhile', async () => {
    const output = outputDirectory();
    const steps = listings(listing(2));
    const file = await writeIndex(output, readFixture('template.html'), 'en', steps.list);
    expect(pageData(file)).toEqual(listing(2));
    expect(steps.calls()).toBe(2);
  });

  it('001 FR-031 writes index.html again when another writer added a folder after its listing', async () => {
    const output = outputDirectory();
    // Listed with two comparisons; by the time the file is written, a third folder is there.
    const steps = listings(listing(2), listing(3));
    const file = await writeIndex(output, readFixture('template.html'), 'en', steps.list);
    expect(pageData(file)).toEqual(listing(3));
    expect(steps.calls()).toBe(3);
  });

  it('001 FR-031 stops after three writes while the folders keep changing', async () => {
    const output = outputDirectory();
    const steps = listings(listing(0), listing(1), listing(2), listing(3));
    const file = await writeIndex(output, readFixture('template.html'), 'en', steps.list);
    expect(pageData(file)).toEqual(listing(2));
    expect(steps.calls()).toBe(4);
    expect(temporaryNames(output)).toEqual([]);
  });
});

describe('page template', () => {
  it('001 FR-031 is dist/viewer/report.html next to the built report modules', () => {
    expect(path.basename(PAGE_TEMPLATE)).toBe('report.html');
    expect(path.basename(path.dirname(PAGE_TEMPLATE))).toBe('viewer');
    // From src/report/ in a source checkout, from dist/report/ in the package.
    expect(path.dirname(path.dirname(PAGE_TEMPLATE))).toBe(
      path.resolve(import.meta.dirname, '../../../src'),
    );
  });

  it('001 FR-031 reads the template, and reads nothing where there is none', async () => {
    expect(await readPageTemplate(TEMPLATE_FILE)).toBe(readFixture('template.html'));
    expect(await readPageTemplate(missingTemplate())).toBeUndefined();
  });
});
