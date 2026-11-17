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
  pytestRequirements,
  pytestTestNames,
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

describe('spec coverage check on pytest tests', () => {
  it('checks 003 now that its status is In Progress', async () => {
    const report = await checkSpecCoverage(ROOT);
    expect(report.features.map((feature) => feature.id)).toContain('003');
  });

  it('takes test functions at module level and in Test classes, async ones included', () => {
    const source = [
      'import pytest',
      '',
      'def test_009_FR_001_module_level():',
      '    def test_009_FR_002_nested_function():',
      '        pass',
      '',
      'async def test_009_FR_003_async(server):',
      '    await server.stop()',
      '',
      'def helper_009_FR_004():',
      '    pass',
      '',
      'class TestGroup:',
      '    def test_009_FR_005_method(self):',
      '        pass',
      '',
      '    async def test_009_FR_006_async_method(self):',
      '        pass',
      '',
      '    class TestInner:',
      '        def test_009_FR_007_inner_class(self):',
      '            pass',
      '',
      'class Helpers:',
      '    def test_009_FR_008_not_a_test_class(self):',
      '        pass',
      '',
      'def testing_009_FR_009_not_named_test_underscore():',
      '    pass',
    ].join('\n');
    expect(pytestTestNames(source)).toEqual([
      'test_009_FR_001_module_level',
      'test_009_FR_003_async',
      'test_009_FR_005_method',
      'test_009_FR_006_async_method',
      'test_009_FR_007_inner_class',
    ]);
  });

  it('ignores text inside strings, comments and bracketed continuation lines', () => {
    const source = [
      'DOC = """',
      'def test_009_FR_001_inside_a_string():',
      '"""',
      '# def test_009_FR_002_commented_out():',
      'CASES = [',
      "    'def test_009_FR_003_in_a_list',",
      ']',
      'def test_009_FR_004_real(',
      '    tmp_path,',
      '):',
      "    text = 'a \\' def test_009_FR_005_escaped'",
    ].join('\n');
    expect(pytestTestNames(source)).toEqual(['test_009_FR_004_real']);
  });

  it('leaves out tests skipped or marked xfail on the function or the class, and keeps skipif', () => {
    const source = [
      'import sys',
      'import pytest',
      '',
      '@pytest.mark.skip(reason="not yet")',
      'def test_009_FR_001_skipped():',
      '    pass',
      '',
      '@pytest.mark.xfail',
      'def test_009_FR_002_xfail():',
      '    pass',
      '',
      '@pytest.mark.skipif(',
      '    sys.version_info < (3, 11),',
      '    reason="needs asyncio.TaskGroup",',
      ')',
      'def test_009_FR_003_skipif():',
      '    pass',
      '',
      '@pytest.mark.parametrize("api", ["chat", "responses"])',
      '@pytest.mark.skip',
      'def test_009_FR_004_skipped_below_another_mark(api):',
      '    pass',
      '',
      '@pytest.mark.skip',
      'class TestSkipped:',
      '    def test_009_FR_005_in_a_skipped_class(self):',
      '        pass',
      '',
      '@pytest.mark.xfail(strict=True)',
      'class TestExpectedToFail:',
      '    def test_009_FR_006_in_an_xfail_class(self):',
      '        pass',
    ].join('\n');
    expect(pytestTestNames(source)).toEqual(['test_009_FR_003_skipif']);
  });

  it('leaves out every test of a module whose pytestmark is or contains pytest.mark.skip', () => {
    const tests = ['def test_009_FR_001_a():', '    pass'];
    const skipped = ['pytestmark = pytest.mark.skip(reason="x")', ...tests];
    const listed = [
      ...tests,
      'pytestmark = [',
      '    pytest.mark.skipif(sys.platform == "win32", reason="posix"),',
      '    pytest.mark.skip,',
      ']',
    ];
    const skipifOnly = ['pytestmark = [pytest.mark.skipif(True, reason="x")]', ...tests];
    expect(pytestTestNames(skipped.join('\n'))).toEqual([]);
    expect(pytestTestNames(listed.join('\n'))).toEqual([]);
    expect(pytestTestNames(skipifOnly.join('\n'))).toEqual(['test_009_FR_001_a']);
  });

  it('counts a pytest name for every FR and SC ID that follows the feature number', () => {
    expect(pytestRequirements('test_003_FR_009_FR_010_x')).toEqual(['003 FR-009', '003 FR-010']);
    expect(pytestRequirements('test_003_SC_002_FR_005_capture')).toEqual([
      '003 SC-002',
      '003 FR-005',
    ]);
    expect(pytestRequirements('test_003_FR_0091_too_long')).toEqual([]);
    expect(pytestRequirements('test_capture_without_ids')).toEqual([]);
  });

  it('reads tests in adapters/python/tests and its subfolders, and only there', async () => {
    const spec = SPEC.replace(
      '- **SC-001**',
      '- **FR-003**: System MUST do a third thing.\n- **SC-001**',
    );
    const root = await mkdtemp(path.join(tmpdir(), 'spec-coverage-'));
    try {
      const tests = path.join(root, 'adapters', 'python', 'tests');
      await mkdir(path.join(root, 'specs', '009-example'), { recursive: true });
      await mkdir(path.join(tests, 'nested'), { recursive: true });
      await writeFile(path.join(root, 'specs', '009-example', 'spec.md'), spec);
      await writeFile(path.join(tests, 'test_one.py'), 'def test_009_FR_001_a():\n    pass\n');
      await writeFile(
        path.join(tests, 'nested', 'test_two.py'),
        'class TestTwo:\n    async def test_009_FR_002_SC_001_b(self):\n        pass\n',
      );
      // Neither a module whose name does not start with test_ nor one outside the tests folder.
      await writeFile(path.join(tests, 'helpers.py'), 'def test_009_FR_003_not_a_test_file():\n');
      await writeFile(
        path.join(root, 'adapters', 'python', 'test_outside.py'),
        'def test_009_FR_003_outside_the_tests_folder():\n    pass\n',
      );
      const report = await checkSpecCoverage(root);
      expect(report.features[0]?.missing).toEqual({
        requirements: ['FR-003'],
        successCriteria: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
