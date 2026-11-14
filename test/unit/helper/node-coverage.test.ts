import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readScenarios, runsInNode } from '../../contract/helper/support/scenarios.js';

// Every scenario row of test/fixtures/helper/scenarios/ runs in the TypeScript helper's contract
// tests at least once, so a filter that leaves a row out (a backend Node does not have, `sdks` that
// names only Python requirements files) cannot drop it unnoticed. A row is left out only when each
// of its cases is marked `languages: ["python"]`.

const SCENARIOS = fileURLToPath(new URL('../../fixtures/helper/scenarios/', import.meta.url));
const fixtureFiles = readdirSync(SCENARIOS)
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('scenario rows in the TypeScript helper tests', () => {
  it('003 SC-002 has fixture files to check', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)(
    '003 SC-002 every row of %s that is not Python-only runs in Node',
    (file) => {
      const missing = Object.entries(readScenarios(file)).flatMap(([scenario, cases]) => {
        const pythonOnly = cases.every(
          (data) => data.languages?.every((language) => language === 'python') ?? false,
        );
        const runs = cases.some((data) => runsInNode(data, `${file} ${scenario} ${data.name}`));
        return pythonOnly || runs ? [] : [scenario];
      });
      expect(missing).toEqual([]);
    },
  );

  it('003 SC-002 a case with no API and Node SDK alias pair is an error, not a case left out', () => {
    const data = { name: 'probe', service: { behaviour: 'reply' }, sdks: ['openai-2'], expect: {} };
    expect(() => runsInNode(data)).toThrow(/no API of the case has a Node SDK alias/);
    expect(() => runsInNode({ ...data, sdks: ['openai-7'], apis: ['messages'] })).toThrow(
      /no API of the case has a Node SDK alias/,
    );
    expect(runsInNode({ ...data, sdks: ['openai-2', 'openai-7'] })).toBe(true);
    expect(runsInNode({ ...data, languages: ['python'] })).toBe(false);
  });
});
