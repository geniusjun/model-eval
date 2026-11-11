import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderReport } from '../../../src/report/markdown.js';
import { comparisonSchema } from '../../../src/report/schema.js';
import { rewriteReport, writeComparison } from '../../../src/report/write.js';
import { loadComparison, temporaryDirectory } from './fixtures.js';

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
});
