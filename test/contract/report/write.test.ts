import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRedactor } from '../../../src/report/redact.js';
import { renderReport } from '../../../src/report/markdown.js';
import { comparisonPage, serializePageData } from '../../../src/report/page-data.js';
import { comparisonSchema } from '../../../src/report/schema.js';
import { writeComparison } from '../../../src/report/write.js';
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

const SECRETS = ['429 rate limited', 'regenerated after a filter', 'AnswerCut'];

const redactor = createRedactor([
  ...SECRETS.map((pattern) => ({ pattern, replace: '[redacted]' })),
  // A rule that would also match identifiers, which are written as they are (FR-031).
  { pattern: 'greet', replace: '[name]' },
]);

function temporaryNames(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((name) =>
    path.basename(name).startsWith('.tmp-'),
  );
}

describe('comparison writer', () => {
  it('001 FR-029 writes comparisons/<comparisonId>/ with comparison.json and report.md (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'en', redactor });
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

  it('001 FR-031 redacts comparison.json and report.md and keeps identifiers as they are', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'ko', redactor });
    for (const file of [written.comparison, written.report]) {
      const text = readFileSync(file, 'utf8');
      for (const secret of SECRETS) {
        expect(text, file).not.toContain(secret);
      }
      expect(text, file).toContain('[redacted]');
      expect(text, file).toContain('greet-ja');
      expect(text, file).not.toContain('[name]');
    }
    const saved = comparisonSchema.parse(JSON.parse(readFileSync(written.comparison, 'utf8')));
    expect(saved.samples.texts.map((text) => text.caseId)).toEqual(
      comparison.samples.texts.map((text) => text.caseId),
    );
  });

  it('001 FR-031 a page payload built from the written comparison is redacted', async () => {
    const output = outputDirectory();
    const written = await writeComparison({
      outputDir: output,
      comparison: loadComparison('undecided-partial'),
      lang: 'en',
      redactor,
    });
    const saved = comparisonSchema.parse(JSON.parse(readFileSync(written.comparison, 'utf8')));
    const payload = serializePageData(comparisonPage(saved, 'en'));
    for (const secret of SECRETS) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('[redacted]');
  });

  it('001 FR-029 replaces each file of an existing comparison folder (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('no-gate');
    const folder = path.join(output, 'comparisons', comparison.comparisonId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'comparison.json'), '{"old": true}');
    writeFileSync(path.join(folder, 'report.md'), 'old report');
    writeFileSync(path.join(folder, 'report.html'), 'kept');
    const written = await writeComparison({ outputDir: output, comparison, lang: 'en', redactor });
    const saved = comparisonSchema.parse(JSON.parse(readFileSync(written.comparison, 'utf8')));
    expect(saved.comparisonId).toBe(comparison.comparisonId);
    expect(readFileSync(written.report, 'utf8')).toBe(renderReport(saved, 'en'));
    expect(readFileSync(path.join(folder, 'report.html'), 'utf8')).toBe('kept');
    expect(temporaryNames(output)).toEqual([]);
  });

  it('001 FR-029 two writers of the same comparison never mix their writes (D6)', async () => {
    const output = outputDirectory();
    const comparison = loadComparison('block');
    const writes = await Promise.all(
      (['en', 'ko', 'en', 'ko'] as const).map((lang) =>
        writeComparison({ outputDir: output, comparison, lang, redactor }),
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
