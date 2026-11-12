import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  carriedRequirements,
  checkSpecCoverage,
  findMissing,
  isChecked,
  parseFeature,
  testTitles,
} from '../../scripts/check-spec-coverage.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The coverage check enforces constitution IX and is not a requirement of a feature, so these
// names carry no FR ID: one would count as covering that requirement.

const SPEC = `# Feature Specification: Example

**Status**: In Progress

- **FR-001**: System MUST do one thing.
- **FR-002**: System MUST do another, which mentions FR-009 in passing.
- **SC-001**: One outcome.
`;

describe('spec coverage check', () => {
  it('checks 001 and exactly the specs whose status line is In Progress or Implemented', async () => {
    const specs = path.join(ROOT, 'specs');
    // A folder without spec.md is reported by the script, not checked.
    const folders = (await readdir(specs))
      .filter((name) => /^\d{3}-/.test(name) && existsSync(path.join(specs, name, 'spec.md')))
      .sort();
    const statuses = await Promise.all(
      folders.map(async (name) => {
        const text = await readFile(path.join(specs, name, 'spec.md'), 'utf8');
        return { name, status: /^\*\*Status\*\*: (.+)$/m.exec(text)?.[1] };
      }),
    );
    const expected = statuses
      .filter(({ status }) => status === 'In Progress' || status === 'Implemented')
      .map(({ name }) => name);
    const report = await checkSpecCoverage(ROOT);
    expect(report.features.map((feature) => feature.name)).toEqual(expected);
    expect(report.features.map((feature) => feature.id)).toContain('001');
  });

  it('leaves out a draft spec', () => {
    const draft = SPEC.replace('**Status**: In Progress', '**Status**: Draft');
    expect(isChecked(parseFeature('009-example', SPEC))).toBe(true);
    expect(isChecked(parseFeature('009-example', draft))).toBe(false);
  });

  it('reports a spec folder without spec.md instead of failing to read it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spec-coverage-'));
    try {
      await mkdir(path.join(root, 'specs', '009-example'), { recursive: true });
      await mkdir(path.join(root, 'specs', '010-started'));
      await writeFile(path.join(root, 'specs', '009-example', 'spec.md'), SPEC);
      const report = await checkSpecCoverage(root);
      expect(report.withoutSpec).toEqual(['010-started']);
      expect(report.features.map((feature) => feature.name)).toEqual(['009-example']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads test names from .test.tsx files as well as .test.ts files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spec-coverage-'));
    try {
      await mkdir(path.join(root, 'specs', '009-example'), { recursive: true });
      await mkdir(path.join(root, 'test', 'viewer'), { recursive: true });
      await writeFile(path.join(root, 'specs', '009-example', 'spec.md'), SPEC);
      await writeFile(
        path.join(root, 'test', 'viewer', 'page.test.tsx'),
        'it(\'009 FR-001 renders\', () => { render(<Page title="a" />); });\n',
      );
      await writeFile(
        path.join(root, 'test', 'example.test.ts'),
        "it('009 FR-002 runs', () => {});\n",
      );
      const report = await checkSpecCoverage(root);
      expect(report.features[0]?.missing.requirements).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads the status and the defined FR and SC IDs of a spec, not IDs it only mentions', () => {
    expect(parseFeature('009-example', SPEC)).toEqual({
      id: '009',
      name: '009-example',
      status: 'In Progress',
      requirements: ['FR-001', 'FR-002'],
      successCriteria: ['SC-001'],
    });
  });

  it('takes test names from it, test and describe calls, leaving out skipped and todo blocks', () => {
    const source = [
      "describe('009 FR-001 group', () => {",
      '  it(',
      "    '009 FR-002 SC-001 on the next line',",
      '    () => {},',
      '  );',
      "  it.each([1, 2])('009 FR-003 case %s', () => {});",
      '  test(`009 FR-004 ${String(1)} template`, () => {});',
      "  it.todo('009 FR-005 not written yet');",
      "  helper('009 FR-006 not a test');",
      "  it.skipIf(process.platform === 'win32')('009 FR-007 runs elsewhere', () => {});",
      '});',
      "describe.skip('009 FR-008 skipped group', () => {",
      "  it('009 FR-009 inside a skipped group', () => {});",
      '});',
      "it.skip('009 FR-010 skipped', () => {});",
    ].join('\n');
    expect(testTitles(source, 'example.test.ts')).toEqual([
      '009 FR-001 group',
      '009 FR-002 SC-001 on the next line',
      '009 FR-003 case %s',
      '009 FR-004 ${…} template',
      '009 FR-007 runs elsewhere',
    ]);
  });

  it('reads every ID that follows a feature number in a test name', () => {
    expect(carriedRequirements('001 FR-019 FR-032 exports the API')).toEqual([
      '001 FR-019',
      '001 FR-032',
    ]);
    expect(carriedRequirements('002 SC-004, FR-010 and 001 FR-001')).toEqual([
      '002 SC-004',
      '002 FR-010',
      '001 FR-001',
    ]);
    expect(carriedRequirements('mentions FR-001 without a feature')).toEqual([]);
  });

  it('fails with the FR IDs no test name carries and only lists the SC IDs', () => {
    expect(
      findMissing(parseFeature('009-example', SPEC), new Set(['009 FR-001', '001 FR-002'])),
    ).toEqual({
      requirements: ['FR-002'],
      successCriteria: ['SC-001'],
    });
  });
});
