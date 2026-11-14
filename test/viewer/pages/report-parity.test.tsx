import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { message } from '../../../src/messages/index.js';
import { renderReport } from '../../../src/report/markdown.js';
import type { Cell, ComparisonPage } from '../../../src/report/schema.js';
import { ReportPage } from '../../../viewer/src/pages/ReportPage.js';
import { formatHash } from '../../../viewer/src/utils/hash.js';
import { COMPARISON_FIXTURES, loadComparisonPage } from '../fixtures.js';

// report.md quotes every string it does not compute itself (model output, messages, rule texts,
// IDs from the files) in a code span or block. Each such content must be somewhere on the page,
// so nobody needs the Markdown report to see it, except in the reproduction section: runs,
// versions, statistics settings, the settings used and the commands stay in report.md, and the
// page names only the comparison and when it was written (FR-007, FR-016). Numbers and IDs are
// checked field by field by the tests of each region.

afterEach(() => {
  window.location.hash = '';
});

const FENCE_LINE = /^(`{3,})/;
const BACKTICKS = /`+/g;

/** The content of each fenced code block, and the lines outside any block. */
function splitBlocks(markdown: string): { blocks: string[]; lines: string[] } {
  const blocks: string[] = [];
  const lines: string[] = [];
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of markdown.split('\n')) {
    if (fence === null) {
      const opening = FENCE_LINE.exec(line);
      if (opening?.[1] === undefined) {
        lines.push(line);
      } else {
        fence = opening[1];
        body = [];
      }
    } else if (line === fence) {
      blocks.push(body.join('\n'));
      fence = null;
    } else {
      body.push(line);
    }
  }
  return { blocks, lines };
}

/** One padding space on each side is part of the fence when both sides have one. */
function unpad(content: string): string {
  const padded = content.length > 2 && content.startsWith(' ') && content.endsWith(' ');
  return padded && content.trim() !== '' ? content.slice(1, -1) : content;
}

/** The content of each code span of a line: a run of backticks up to the next run as long. */
function spans(line: string): string[] {
  const runs = [...line.matchAll(BACKTICKS)].map((match) => ({
    start: match.index,
    length: match[0].length,
  }));
  const found: string[] = [];
  let index = 0;
  while (index < runs.length) {
    const opening = runs[index];
    if (opening === undefined) {
      break;
    }
    const closingAt = runs.findIndex((run, at) => at > index && run.length === opening.length);
    const closing = runs[closingAt];
    if (closing === undefined) {
      index += 1;
      continue;
    }
    found.push(unpad(line.slice(opening.start + opening.length, closing.start)));
    index = closingAt + 1;
  }
  return found;
}

/** The report without its reproduction section, which runs from its heading to the next one. */
function withoutReproduction(markdown: string): string {
  const heading = `## ${message('en', 'report.section.reproduction')}`;
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThan(0);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return [...lines.slice(0, start), ...(next === -1 ? [] : lines.slice(next))].join('\n');
}

/** Every quoted string of the report: code span and code block contents. */
function quotedStrings(markdown: string): string[] {
  const { blocks, lines } = splitBlocks(markdown);
  return [...blocks, ...lines.flatMap(spans)];
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** The page text with no detail open, then with each cell detail opened in turn. */
function pageTexts(page: ComparisonPage): string[] {
  const texts: string[] = [];
  const renderText = () => {
    const { container, unmount } = render(<ReportPage page={page} />);
    const text = collapse(container.textContent);
    unmount();
    return text;
  };
  texts.push(renderText());
  for (const cell of page.comparison.cells) {
    window.location.hash = formatHash({ view: cellView(cell), lang: null });
    const { container, unmount } = render(<ReportPage page={page} />);
    // The detail of this cell is open, so its failing examples and anchors are in the text.
    expect(
      screen.getByRole('heading', { name: `${cell.ruleId} (${cell.lang}, ${cell.surface})` }),
    ).toBeDefined();
    texts.push(collapse(container.textContent));
    unmount();
  }
  window.location.hash = '';
  return texts;
}

function cellView(cell: Cell) {
  return { kind: 'cell', ruleId: cell.ruleId, lang: cell.lang, surface: cell.surface } as const;
}

describe('002 report parity', () => {
  it.each(COMPARISON_FIXTURES)(
    '002 FR-016 shows every quoted string of report.md outside its reproduction section for the %s comparison',
    (kind) => {
      const page: ComparisonPage = {
        ...loadComparisonPage(`page-comparison-${kind}.json`),
        lang: 'en',
      };
      const quoted = quotedStrings(
        withoutReproduction(renderReport(page.comparison, 'en', 'result-page')),
      );
      expect(quoted.length).toBeGreaterThan(0);
      const texts = pageTexts(page);
      const missing = quoted.filter(
        (content) => !texts.some((text) => text.includes(collapse(content))),
      );
      expect(missing).toEqual([]);
    },
  );
});
