import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../src/adapter/canonical-json.js';
import type { JsonValue } from '../../../src/adapter/json-types.js';
import {
  APIS,
  type CaseData,
  providerOf,
  readScenarios,
  runsInNode,
} from '../../contract/helper/support/scenarios.js';

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

// A row that names Node SDK aliases in `sdks` names every alias package.json installs for each
// provider it names, or belongs to a scene split into rows by `sdks` (one expectation per group of
// SDK releases) whose rows together do. An alias added for a new major version then cannot fall
// outside a row, or between the rows of a split scene, and leave the scene untested on it.

const PACKAGE = fileURLToPath(new URL('../../../package.json', import.meta.url));
const SDK_SPEC = /^npm:(?:openai|@anthropic-ai\/sdk)@/;

/** The Node SDK aliases package.json installs: devDependencies that alias an SDK package. */
function packageAliases(): string[] {
  const manifest = JSON.parse(readFileSync(PACKAGE, 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  return Object.entries(manifest.devDependencies ?? {})
    .filter(([, spec]) => SDK_SPEC.test(spec))
    .map(([name]) => name)
    .sort();
}

/** The rows' scene: everything but the name, the `sdks` and the expectation. */
function sceneOf(data: CaseData): string {
  const { name: _name, sdks: _sdks, expect: _expect, ...scene } = data;
  return canonicalJson(scene as JsonValue);
}

/**
 * The aliases left out, as `<scenario> <api>: <aliases>`. Each TypeScript row with Node aliases in
 * `sdks` is checked, for every API whose provider it names an alias of, against the aliases it
 * names; the rows of one scenario with the same scene form a split scene when there are two or
 * more of them, and are checked against the aliases they name together.
 */
function uncoveredAliases(
  scenarios: Readonly<Record<string, readonly CaseData[]>>,
  aliases: readonly string[],
): string[] {
  return Object.entries(scenarios).flatMap(([scenario, cases]) => {
    const rows = cases.filter(
      (data) =>
        (data.languages?.includes('typescript') ?? true) &&
        (data.sdks ?? []).some((sdk) => aliases.includes(sdk)),
    );
    const groups = new Map<string, CaseData[]>();
    for (const data of rows) {
      const key = sceneOf(data);
      groups.set(key, [...(groups.get(key) ?? []), data]);
    }
    const found = new Set<string>();
    for (const group of groups.values()) {
      const named = new Set(group.flatMap((data) => data.sdks ?? []));
      for (const data of group) {
        const covered = group.length >= 2 ? named : new Set(data.sdks ?? []);
        for (const api of data.apis ?? APIS) {
          const provider = aliases.filter((alias) => alias.startsWith(providerOf(api)));
          if (!provider.some((alias) => (data.sdks ?? []).includes(alias))) {
            continue;
          }
          const missing = provider.filter((alias) => !covered.has(alias));
          if (missing.length > 0) {
            found.add(`${scenario} ${api}: ${missing.join(', ')}`);
          }
        }
      }
    }
    return [...found];
  });
}

describe('Node SDK aliases named in sdks', () => {
  const aliases = packageAliases();

  it('003 SC-002 package.json installs Node SDK aliases', () => {
    expect(aliases.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)(
    '003 SC-002 every row of %s that names Node aliases names all of its provider, alone or with the rows of its split scene',
    (file) => {
      expect(uncoveredAliases(readScenarios(file), aliases)).toEqual([]);
    },
  );

  it('003 SC-002 an alias no row of a split scene names is reported', () => {
    const scene = { service: { behaviour: 'reply' }, apis: ['chat-completions' as const] };
    const rows = [
      { ...scene, name: 'old', sdks: ['openai-5'], expect: { status: 'failed' } },
      { ...scene, name: 'new', sdks: ['openai-7'], expect: { status: 'ok' } },
    ] as CaseData[];
    expect(uncoveredAliases({ 'S-X-01': rows }, ['openai-5', 'openai-7', 'openai-8'])).toEqual([
      'S-X-01 chat-completions: openai-8',
    ]);
    expect(uncoveredAliases({ 'S-X-01': rows }, ['openai-5', 'openai-7'])).toEqual([]);
  });

  it('003 SC-002 a single row that lists Node aliases and leaves one out is reported', () => {
    const row = {
      name: 'listed',
      service: { behaviour: 'reply' },
      sdks: ['openai-2', 'openai-5', 'openai-7'],
      expect: { status: 'ok' },
    } as CaseData;
    expect(uncoveredAliases({ 'S-X-02': [row] }, ['openai-5', 'openai-7', 'openai-8'])).toEqual([
      'S-X-02 chat-completions: openai-8',
      'S-X-02 responses: openai-8',
    ]);
    expect(uncoveredAliases({ 'S-X-02': [row] }, ['openai-5', 'openai-7'])).toEqual([]);
    const anthropic = ['anthropic-sdk-0', 'anthropic-sdk-1'];
    expect(uncoveredAliases({ 'S-X-02': [row] }, ['openai-5', 'openai-7', ...anthropic])).toEqual(
      [],
    );
  });
});
