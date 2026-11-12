import { existsSync } from 'node:fs';
import { appendFile, cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { CliResult } from './support/cli.js';
import {
  compareJson,
  E2E,
  gradeJson,
  reportJson,
  runJson,
  swapJson,
  useProjects,
  type JsonOutcome,
} from './support/commands.js';
import {
  cellKeyOf,
  comparisonOf,
  readComparison,
  readPage,
  type WrittenPage,
  readGradeSet,
  readRun,
  resultOf,
  startedRunOf,
  swapRunOf,
  type CompareEnvelope,
  type GradeEnvelope,
  type ReportEnvelope,
  type SwapEnvelope,
} from './support/outputs.js';
import { comparisonPage, listPage } from '../../src/report/page-data.js';
import type { Cell, Comparison, ListPage } from '../../src/report/schema.js';
import { greetCases, type Project, type RuleInput } from './support/project.js';
import { ANSWERED, NO_EMOJI, SCRIPT_JA } from './support/rules.js';

// User Story 4, acceptance scenario 1 and its independent test: `grade`, `compare` and `report`
// work on saved runs with the current rules and call no model.

const project = useProjects();

const CASES = greetCases({ ko: 3, ja: 3 });
const GATED = { gate: { severities: ['blocking' as const] } };

/** The candidate of `swap-script-ja` adds " 안녕" to every Japanese answer. */
function greetingRule(regex: string): RuleInput {
  return {
    id: 'no-greeting',
    title: 'Does not open with a greeting',
    severity: 'major',
    scope: 'global',
    check: { type: 'pattern', regex, mode: 'forbid' },
  };
}

/** A comparison ID no comparison of these runs has. */
const COPIED_ID = 'cmp-0123456789ab';

const RULES = [ANSWERED, SCRIPT_JA, NO_EMOJI, greetingRule('안녕')];
const EDITED_RULES = [ANSWERED, SCRIPT_JA, NO_EMOJI, greetingRule('さようなら')];

function verdicts(cells: readonly Cell[]): Map<string, Cell['verdict']> {
  return new Map(cells.map((cell) => [cellKeyOf(cell), cell.verdict]));
}

describe('001 US4 re-grading saved runs with an edited rule', () => {
  let saved: Project;
  let swap: JsonOutcome<SwapEnvelope>;
  let runIds: readonly [string, string];
  let sameRules: JsonOutcome<GradeEnvelope>;
  let edited: JsonOutcome<GradeEnvelope>;
  let editedAgain: CliResult;
  let compared: JsonOutcome<CompareEnvelope>;
  let comparedHuman: CliResult;
  let comparedKorean: CliResult;
  let writtenReport: string;
  let reported: JsonOutcome<ReportEnvelope>;
  let rewrittenReport: string;
  let reportedHuman: CliResult;
  let requestsAfterSwap: number;
  let redactedAgain: JsonOutcome<CompareEnvelope>;
  let gradedKorean: CliResult;
  let reportedKorean: CliResult;
  /** report.html and index.html as the Korean report wrote them, with the listing just after. */
  let koreanPage: WrittenPage;
  let koreanIndex: WrittenPage;
  let listingAfterKorean: ListPage;
  let copiedFolder: JsonOutcome<ReportEnvelope>;
  let reportAfterCopy: string;
  let requestsAtEnd: number;

  beforeAll(async () => {
    saved = await project({
      scenario: 'swap-script-ja',
      rules: RULES,
      cases: CASES,
      config: GATED,
    });
    swap = await swapJson(saved);
    runIds = swapRunOf(swap.envelope).runs;
    requestsAfterSwap = (await saved.generateRequests()).length;

    sameRules = await gradeJson(saved, runIds[1]);
    await saved.write({ rules: EDITED_RULES });
    edited = await gradeJson(saved, runIds[1]);
    editedAgain = await saved.run(['grade', runIds[1]]);
    compared = await compareJson(saved, runIds);
    const { comparisonId } = resultOf(compared.envelope).comparison;
    const report = path.join(saved.outputDir, 'comparisons', comparisonId, 'report.md');
    writtenReport = await readFile(report, 'utf8');
    comparedHuman = await saved.run(['compare', ...runIds]);
    // The same comparison again, its report written in Korean this time.
    comparedKorean = await saved.run(['compare', ...runIds, '--lang', 'ko']);

    await rm(report);
    reported = await reportJson(saved, comparisonId);
    rewrittenReport = await readFile(report, 'utf8');
    reportedHuman = await saved.run(['report', comparisonId]);
    gradedKorean = await saved.run(['grade', runIds[1], '--lang', 'ko']);
    const folder = path.dirname(report);
    await rm(path.join(folder, 'report.html'));
    await rm(path.join(saved.outputDir, 'index.html'));
    reportedKorean = await saved.run(['report', comparisonId, '--lang', 'ko']);
    koreanPage = await readPage(path.join(folder, 'report.html'));
    koreanIndex = await readPage(path.join(saved.outputDir, 'index.html'));
    listingAfterKorean = await listPage(saved.outputDir, 'ko');
    // A comparison folder copied under another ID still holds the original comparisonId.
    await cp(path.dirname(report), path.join(saved.outputDir, 'comparisons', COPIED_ID), {
      recursive: true,
    });
    copiedFolder = await reportJson(saved, COPIED_ID);
    reportAfterCopy = await readFile(report, 'utf8');
    await saved.write({ config: { ...GATED, redact: [{ pattern: '안', replace: '[hangul]' }] } });
    redactedAgain = await compareJson(saved, runIds);
    requestsAtEnd = (await saved.generateRequests()).length;
  }, E2E.timeout);

  it('001 FR-019 independent test: only the cells of the edited rule change verdict, and no model is called', () => {
    const before = verdicts(comparisonOf(swap.envelope).cells);
    const after = verdicts(resultOf(compared.envelope).comparison.cells);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...after].filter(([key, verdict]) => before.get(key) !== verdict);
    expect(changed.map(([key]) => key).sort()).toEqual([
      'no-greeting/ja/final',
      'no-greeting/ja/raw',
    ]);
    expect(before.get('no-greeting/ja/raw')).toBe('regressed');
    expect(after.get('no-greeting/ja/raw')).not.toBe('regressed');
    expect(requestsAtEnd).toBe(requestsAfterSwap);
  });

  it('001 FR-019 grade reuses the grade set of unchanged rules and writes a new one after the edit, without a generate request', async () => {
    const swapGradeSet = comparisonOf(swap.envelope).candidate.gradeSetId;
    expect(sameRules.cli.code).toBe(0);
    expect(resultOf(sameRules.envelope)).toEqual({
      runId: runIds[1],
      gradeSetId: swapGradeSet,
      reused: true,
    });
    expect(edited.cli.code).toBe(0);
    const graded = resultOf(edited.envelope);
    expect(graded).toMatchObject({ runId: runIds[1], reused: false });
    expect(graded.gradeSetId).not.toBe(swapGradeSet);
    const run = await readRun(saved.outputDir, runIds[1]);
    const before = await readGradeSet(run.dir, swapGradeSet);
    const after = await readGradeSet(run.dir, graded.gradeSetId);
    expect(after.header.rulesHash).not.toBe(before.header.rulesHash);
    expect(after.header.trialsFingerprint).toBe(before.header.trialsFingerprint);
    const greeting = after.grades.filter((grade) => grade.ruleId === 'no-greeting');
    expect(greeting.length).toBeGreaterThan(0);
    expect(new Set(greeting.map((grade) => grade.outcome))).toEqual(new Set(['pass']));
    expect(edited.envelope.warnings).toEqual([]);
  });

  it('001 FR-019 scenario 1: compare re-grades both runs with the current rules before comparing', async () => {
    expect(compared.cli.code).toBe(1);
    const result = resultOf(compared.envelope);
    const { comparison } = result;
    const fromSwap = comparisonOf(swap.envelope);
    expect(comparison.baseline.runId).toBe(runIds[0]);
    expect(comparison.candidate.runId).toBe(runIds[1]);
    expect(comparison.candidate.gradeSetId).toBe(resultOf(edited.envelope).gradeSetId);
    expect(comparison.baseline.gradeSetId).not.toBe(fromSwap.baseline.gradeSetId);
    expect(comparison.comparisonId).not.toBe(fromSwap.comparisonId);
    const baseline = await readRun(saved.outputDir, runIds[0]);
    expect(
      existsSync(path.join(baseline.dir, 'grades', `${comparison.baseline.gradeSetId}.jsonl`)),
    ).toBe(true);
    expect(result.gate).toEqual(comparison.gate);
    expect(comparison.gate.outcome).toBe('block');
    expect(compared.envelope.warnings).toEqual(comparison.warnings);
    const files = await readComparison(saved.outputDir, comparison.comparisonId);
    expect({ ...files.comparison, createdAt: comparison.createdAt }).toEqual(comparison);
  });

  it('001 FR-029 report rewrites report.md from the saved comparison, in the language asked', async () => {
    const { comparisonId, createdAt } = resultOf(compared.envelope).comparison;
    expect(reported.cli.code).toBe(0);
    expect(resultOf(reported.envelope)).toEqual({ comparisonId });
    expect(reported.envelope.warnings).toEqual([]);
    // The Korean compare saved the same comparison again under its own createdAt.
    const files = await readComparison(saved.outputDir, comparisonId);
    expect(rewrittenReport).toBe(writtenReport.replace(createdAt, files.comparison.createdAt));
  });

  it('001 FR-031 report writes report.html and the output index.html again, in the language asked', async () => {
    const { comparisonId } = resultOf(compared.envelope).comparison;
    const files = await readComparison(saved.outputDir, comparisonId);
    // Both files were removed just before `report --lang ko`, so these are its writes.
    expect(koreanPage.data).toEqual(comparisonPage(files.comparison, 'ko'));
    expect(koreanPage.data.lang).toBe('ko');
    expect(koreanIndex.data).toEqual(listingAfterKorean);
    expect(koreanIndex.data.lang).toBe('ko');
  });

  it('001 FR-029 report refuses a folder whose comparison has another comparisonId and writes nothing', () => {
    const { comparisonId } = resultOf(compared.envelope).comparison;
    expect(copiedFolder.cli.code).toBe(4);
    expect(copiedFolder.envelope.result).toBeNull();
    expect(copiedFolder.cli.stderr).toContain(COPIED_ID);
    expect(copiedFolder.cli.stderr).toContain(comparisonId);
    // The Korean report written just before is untouched.
    expect(reportAfterCopy).toContain('model-eval 보고서');
  });

  it('001 FR-031 a changed redact rule shows in the evidence of the reused grade sets', () => {
    const before = resultOf(compared.envelope).comparison;
    const after = resultOf(redactedAgain.envelope).comparison;
    expect(after.baseline.gradeSetId).toBe(before.baseline.gradeSetId);
    expect(after.candidate.gradeSetId).toBe(before.candidate.gradeSetId);
    expect(after.comparisonId).not.toBe(before.comparisonId);
    const evidence = (comparison: Comparison) =>
      comparison.samples.failing.flatMap((cell) => cell.keys.flatMap((key) => key.evidence ?? []));
    expect(evidence(before).join('')).toContain('안');
    expect(evidence(after)).toHaveLength(evidence(before).length);
    expect(evidence(after).join('')).not.toContain('안');
    expect(evidence(after).join('')).toContain('[hangul]');
  });

  it('001 FR-034 human output of grade, compare and report', () => {
    const graded = resultOf(edited.envelope);
    expect(editedAgain.code).toBe(0);
    expect(editedAgain.stdout).toContain(runIds[1]);
    expect(editedAgain.stdout).toContain(graded.gradeSetId);
    expect(editedAgain.stdout).toContain('reused');

    const { comparisonId } = resultOf(compared.envelope).comparison;
    const reportPath = path.join('.model-eval', 'comparisons', comparisonId, 'report.md');
    expect(comparedHuman.code).toBe(1);
    expect(comparedHuman.stdout).toContain('model-eval compare');
    expect(comparedHuman.stdout).toContain(`${runIds[0]} → ${runIds[1]}`);
    expect(comparedHuman.stdout).toMatch(/Gate, \d+ cells: .*BLOCK/u);
    // compare writes the result page too, so the report line aligns under its label.
    expect(comparedHuman.stdout).toContain(`Result page  ${reportPath.replace(/md$/u, 'html')}`);
    expect(comparedHuman.stdout).toContain(`Report       ${reportPath}`);
    expect(comparedKorean.code).toBe(1);
    expect(comparedKorean.stdout).toContain('게이트, 게이트 셀');

    expect(reportedHuman.code).toBe(0);
    expect(reportedHuman.stdout).toContain(comparisonId);
    // report names the result page it wrote above the report, as compare does.
    expect(reportedHuman.stdout).toContain(`Result page  ${reportPath.replace(/md$/u, 'html')}`);
    expect(reportedHuman.stdout).toContain(`Report       ${reportPath}`);
    expect(gradedKorean.code).toBe(0);
    expect(gradedKorean.stdout).toContain(`채점 세트 ${graded.gradeSetId} · 재사용`);
    expect(reportedKorean.code).toBe(0);
    expect(reportedKorean.stdout).toContain(`결과 페이지  ${reportPath.replace(/md$/u, 'html')}`);
    expect(reportedKorean.stdout).toContain(`보고서       ${reportPath}`);
    for (const result of [
      editedAgain,
      comparedHuman,
      reportedHuman,
      gradedKorean,
      reportedKorean,
    ]) {
      expect(result.stdout.trimStart().startsWith('{')).toBe(false);
    }
  });
});

describe('001 US4 refusals of the re-grading commands', () => {
  let saved: Project;
  let runId: string;

  beforeAll(async () => {
    saved = await project({
      scenario: 'swap-clean',
      rules: [ANSWERED],
      cases: greetCases({ ko: 3 }),
    });
    runId = startedRunOf((await runJson(saved, 'current')).envelope).runId;
  }, E2E.timeout);

  it('001 FR-030 an unknown run, a malformed ID and missing arguments exit 4 without a result', async () => {
    const unknown = await gradeJson(saved, '20990101-000000-current-0000');
    expect(unknown.cli.code).toBe(4);
    expect(unknown.envelope.result).toBeNull();
    expect(unknown.cli.stderr).toContain('20990101-000000-current-0000');
    const malformed = await compareJson(saved, ['../runs', runId]);
    expect(malformed.cli.code).toBe(4);
    expect(malformed.envelope.result).toBeNull();
    const missing = await saved.run(['compare', runId, '--json']);
    expect(missing.code).toBe(4);
    const extra = await saved.run(['grade', runId, runId, '--json']);
    expect(extra.code).toBe(4);
    const noComparison = await reportJson(saved, 'cmp-000000000000');
    expect(noComparison.cli.code).toBe(4);
    expect(noComparison.envelope.result).toBeNull();
  });

  it('001 D6 a grade set file that cannot be read is graded and written again', async () => {
    const run = await readRun(saved.outputDir, runId);
    const { gradeSetId } = resultOf((await gradeJson(saved, runId)).envelope);
    const file = path.join(run.dir, 'grades', `${gradeSetId}.jsonl`);
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.slice(0, -10));
    const graded = await gradeJson(saved, runId);
    expect(graded.cli.code).toBe(0);
    expect(resultOf(graded.envelope)).toEqual({ runId, gradeSetId, reused: false });
    expect(await readFile(file, 'utf8')).toBe(text);
    await writeFile(file, '{broken\n');
    const compared = await compareJson(saved, [runId, runId]);
    expect(compared.cli.code).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('001 FR-013 grade ignores a cut last line of trials.jsonl and ends on a broken middle line with its number', async () => {
    const run = await readRun(saved.outputDir, runId);
    const trials = path.join(run.dir, 'trials.jsonl');
    const graded = await gradeJson(saved, runId);
    expect(graded.cli.code).toBe(0);
    expect(resultOf(graded.envelope).reused).toBe(true);
    try {
      await appendFile(trials, '{"caseId":"greet-ko-1","repeat":');
      const cut = await gradeJson(saved, runId);
      expect(cut.cli.code).toBe(0);
      expect(resultOf(cut.envelope)).toEqual(resultOf(graded.envelope));

      const [first = '', ...rest] = run.trialsText.split('\n');
      await writeFile(trials, [first, '{broken', ...rest].join('\n'));
      const broken = await gradeJson(saved, runId);
      expect(broken.cli.code).toBe(4);
      expect(broken.envelope.result).toBeNull();
      expect(broken.cli.stderr).toContain('trials.jsonl:2');
      const compared = await compareJson(saved, [runId, runId]);
      expect(compared.cli.code).toBe(4);
    } finally {
      await writeFile(trials, run.trialsText);
    }
  });
});
