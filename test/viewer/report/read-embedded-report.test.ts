import { readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DATA_PLACEHOLDER, fillTemplate } from '../../../src/report/page-data.js';
import { readEmbeddedReport } from '../../../viewer/src/report/readEmbeddedReport.js';
import { FIXTURES, loadComparisonPage, loadPage, readFixture } from '../fixtures.js';

const PAGE_FIXTURES = readdirSync(FIXTURES).filter((name) => /^page-.*\.json$/.test(name));

/** A document whose data block holds `text`, or no data block when `text` is null. */
function documentWith(text: string | null): Document {
  const page = document.implementation.createHTMLDocument('page');
  if (text !== null) {
    const block = page.createElement('script');
    block.type = 'application/json';
    block.id = 'model-eval-data';
    block.textContent = text;
    page.body.append(block);
  }
  return page;
}

describe('002 readEmbeddedReport', () => {
  it('002 FR-012 returns each page fixture filled into the template', () => {
    expect(PAGE_FIXTURES.length).toBeGreaterThan(0);
    for (const name of PAGE_FIXTURES) {
      const page = loadPage(name);
      const html = fillTemplate(readFixture('template.html'), page);
      const filled = new DOMParser().parseFromString(html, 'text/html');
      expect(readEmbeddedReport(filled), name).toEqual({ ok: true, page });
    }
  });

  it('002 FR-012 names the version of a payload with an unsupported schemaVersion', () => {
    const payload = { ...loadPage('page-comparison-block.json'), schemaVersion: '2' };
    expect(readEmbeddedReport(documentWith(JSON.stringify(payload)))).toEqual({
      ok: false,
      error: { foundVersion: '2' },
    });
  });

  it('002 FR-012 names version 1 for a payload that fails validation', () => {
    const { comparison: _dropped, ...payload } = loadComparisonPage('page-comparison-block.json');
    expect(readEmbeddedReport(documentWith(JSON.stringify(payload)))).toEqual({
      ok: false,
      error: { foundVersion: '1' },
    });
  });

  it('002 FR-012 finds no version in an unfilled placeholder or a missing block', () => {
    expect(readEmbeddedReport(documentWith(DATA_PLACEHOLDER))).toEqual({
      ok: false,
      error: { foundVersion: null },
    });
    expect(readEmbeddedReport(documentWith(null))).toEqual({
      ok: false,
      error: { foundVersion: null },
    });
  });

  it('002 FR-012 never throws, whatever the block holds', () => {
    for (const text of [
      '',
      'null',
      '[]',
      '"1"',
      '{"schemaVersion":2}',
      '{"schemaVersion":{}}',
      '{',
    ]) {
      const result = readEmbeddedReport(documentWith(text));
      expect(result.ok, text).toBe(false);
    }
    expect(readEmbeddedReport(documentWith('{"schemaVersion":2}'))).toEqual({
      ok: false,
      error: { foundVersion: '2' },
    });
  });
});
