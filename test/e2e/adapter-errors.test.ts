import { describe, expect, it } from 'vitest';

import { message } from '../../src/messages/index.js';
import { E2E, swapJson, useProjects, type JsonOutcome } from './support/commands.js';
import {
  attemptLines,
  comparisonOf,
  costLines,
  effectiveLines,
  readComparison,
  readRun,
  swapRunOf,
  type RunFiles,
  type SwapEnvelope,
} from './support/outputs.js';
import { greetCases, type CaseInput, type Project } from './support/project.js';
import { ANSWERED, NO_EMOJI } from './support/rules.js';

// User Story 3, acceptance scenarios 3 and 4, and adapter faults in a swap (FR-008, FR-009,
// FR-029).

const project = useProjects();

const STDOUT_RESERVED = 'stdout is reserved for the protocol';
const CASES = greetCases({ ko: 2, ja: 2 });

function errorsProject(
  scenario: string,
  options: { cases?: readonly CaseInput[]; adapterTimeoutMs?: number; mockState?: boolean } = {},
): Promise<Project> {
  return project({
    scenario,
    rules: [ANSWERED, NO_EMOJI],
    cases: options.cases ?? CASES,
    ...(options.adapterTimeoutMs === undefined
      ? {}
      : { adapterTimeoutMs: options.adapterTimeoutMs }),
    ...(options.mockState === undefined ? {} : { mockState: options.mockState }),
  });
}

async function candidateRun(
  errors: Project,
  outcome: JsonOutcome<SwapEnvelope>,
): Promise<RunFiles> {
  const { runs } = swapRunOf(outcome.envelope);
  return readRun(errors.outputDir, runs[1]);
}

describe('001 adapter errors', () => {
  it(
    '001 FR-008 US3 scenario 3: stdout contamination at the start is a configuration error that shows the line',
    async () => {
      const errors = await errorsProject('errors-start-noise');
      const { cli, envelope } = await swapJson(errors);
      expect(cli.code).toBe(4);
      expect(envelope.result).toBeNull();
      expect(cli.stderr).toContain(STDOUT_RESERVED);
      expect(cli.stderr).toContain('debug: loading the service config');
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 US3 scenario 3: stdout contamination during a run shows the line, abandons the trial with restart and restarts the adapter',
    async () => {
      const errors = await errorsProject('errors-noise');
      const outcome = await swapJson(errors);
      expect([0, 1, 2]).toContain(outcome.cli.code);
      expect(outcome.cli.stderr).toContain(STDOUT_RESERVED);
      expect(outcome.cli.stderr).toContain('debug: prompt for greet-ja-1 ready');
      const candidate = await candidateRun(errors, outcome);
      const noisy = attemptLines(candidate.lines).filter((line) => line.caseId === 'greet-ja-1');
      expect(noisy).toHaveLength(2);
      for (const line of noisy) {
        expect(line).toMatchObject({
          status: 'error',
          error: {
            kind: 'adapter',
            abandoned: 'restart',
            message: expect.stringContaining(STDOUT_RESERVED) as unknown,
          },
          costEstimated: true,
        });
      }
      const others = [...effectiveLines(candidate.lines).values()].filter(
        (line) => line.caseId !== 'greet-ja-1',
      );
      expect(others.every((line) => line.status === 'ok')).toBe(true);
      const sessions = (await errors.sessions()).filter((session) => session.variant === 'next');
      expect(sessions).toHaveLength(3);
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 US3 scenario 4: a result without the required fields is an adapter error, not a model failure',
    async () => {
      const errors = await errorsProject('errors-missing-fields');
      const outcome = await swapJson(errors);
      const candidate = await candidateRun(errors, outcome);
      const broken = attemptLines(candidate.lines).filter((line) => line.caseId === 'greet-ko-2');
      expect(broken).toHaveLength(2);
      for (const line of broken) {
        expect(line).toMatchObject({
          status: 'error',
          error: { kind: 'adapter', message: expect.stringContaining('raw') as unknown },
        });
        expect(line.status === 'error' ? line.error.abandoned : 'none').toBeUndefined();
      }
      const ops = comparisonOf(outcome.envelope).ops.candidate;
      expect(ops.rates.adapter.count).toBe(2);
      expect(ops.rates.rejection.count + ops.rates.timeout.count).toBe(0);
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 stops as partial with exit 3 when the adapter error rate passes run.maxAdapterErrorRate after 20 finished trials',
    async () => {
      const errors = await errorsProject('errors-rate', {
        cases: greetCases({ ko: 10, ja: 10 }),
      });
      const outcome = await swapJson(errors);
      expect(outcome.cli.code).toBe(3);
      const candidate = await candidateRun(errors, outcome);
      expect(candidate.manifest).toMatchObject({ status: 'partial', stopReason: 'adapter-errors' });
      const finished = [...effectiveLines(candidate.lines).values()];
      expect(finished.length).toBeGreaterThanOrEqual(20);
      expect(finished.length).toBeLessThan(40);
      const adapter = finished.filter(
        (line) => line.status === 'error' && line.error.kind === 'adapter',
      );
      expect(adapter.length / finished.length).toBeGreaterThan(0.05);
      expect(outcome.cli.stderr).not.toContain('LookupError');
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 stops as partial with exit 3 after three adapter crashes in a row',
    async () => {
      const errors = await errorsProject('errors-crashes');
      const outcome = await swapJson(errors);
      expect(outcome.cli.code).toBe(3);
      const candidate = await candidateRun(errors, outcome);
      expect(candidate.manifest).toMatchObject({ status: 'partial', stopReason: 'adapter-errors' });
      const sessions = (await errors.sessions()).filter((session) => session.variant === 'next');
      expect(sessions).toHaveLength(3);
      const sent = sessions.flatMap((session) =>
        session.requests.filter((request) => request.method === 'generate'),
      );
      const lines = attemptLines(candidate.lines);
      const lost = lines.filter((line) => line.status === 'error');
      // Requests in flight are lost with their process; those never sent wait for a resume.
      expect(lost).toHaveLength(sent.length);
      for (const line of lost) {
        expect(line).toMatchObject({ error: { kind: 'adapter', abandoned: 'restart' } });
      }
      for (const line of lines.filter((each) => each.status !== 'error')) {
        expect(line).toMatchObject({ status: 'stopped', costUsd: 0 });
      }
      expect(outcome.cli.stderr).toContain(
        message('en', 'human.adapter.crashed', {
          variant: 'next',
          count: 3,
          message: '"the adapter exited (code 1, signal null)"',
        }),
      );
      const human = await errors.run(['swap', '--from', 'current', '--to', 'next']);
      expect(human.stdout).toContain(
        message('en', 'human.stopped', {
          reason: message('en', 'human.stop.adapter-restarts', { count: 3 }),
        }),
      );
      expect(human.stdout).not.toContain(message('en', 'human.stop.adapter-errors'));
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 ends with exit 4 when a restarted adapter declares another adapter version',
    async () => {
      const errors = await errorsProject('errors-version', { mockState: true });
      const outcome = await swapJson(errors);
      expect(outcome.cli.code).toBe(4);
      const candidate = await candidateRun(errors, outcome);
      expect(candidate.manifest).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      expect(outcome.cli.stderr).toContain(
        message('en', 'human.adapter.restartChanged', {
          variant: 'next',
          fields: 'adapter-version',
        }),
      );
      expect(outcome.cli.stderr).not.toContain('git status --short');
      // A changed adapter is a configuration problem, not an adapter failure: no stderr tail.
      expect(outcome.cli.stderr).not.toContain('lines of adapter stderr');
      // greet-ja-2 waited for the restart and never reached an adapter, so a resume sends it.
      expect(attemptLines(candidate.lines).filter((line) => line.caseId === 'greet-ja-2')).toEqual([
        expect.objectContaining({ status: 'stopped', costUsd: 0 }),
      ]);
      const restarts = attemptLines(candidate.lines).filter(
        (line) => line.status === 'error' && line.error.abandoned === 'restart',
      );
      expect(restarts.map((line) => line.caseId)).toEqual(['greet-ko-2']);
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 ends with exit 4 when a restarted adapter does not start, attaching the stderr tail',
    async () => {
      const errors = await errorsProject('errors-restart-fails', { mockState: true });
      const outcome = await swapJson(errors);
      expect(outcome.cli.code).toBe(4);
      const candidate = await candidateRun(errors, outcome);
      expect(candidate.manifest).toMatchObject({ status: 'partial', stopReason: 'config-error' });
      expect(outcome.cli.stderr).toContain(
        message('en', 'human.adapter.restartFailed', {
          variant: 'next',
          kind: 'exited',
          message: '"the adapter exited (code 2, signal null)"',
        }),
      );
      expect(outcome.cli.stderr).toContain('next: the last ');
      expect(outcome.cli.stderr).toContain('  mock: exiting before initialize');
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 ends with exit 4 when a restarted adapter declares other service code, suggesting git status',
    async () => {
      const errors = await errorsProject('errors-service', { mockState: true });
      const outcome = await swapJson(errors);
      expect(outcome.cli.code).toBe(4);
      expect(outcome.cli.stderr).toContain(
        message('en', 'human.adapter.restartChanged', { variant: 'next', fields: 'service' }),
      );
      expect(outcome.cli.stderr).toContain('git status --short');
    },
    E2E.timeout,
  );

  it(
    '001 FR-008 FR-029 the comparison holds abandoned-trials and adapter-warnings, and the report says the adapter declares no post-processing',
    async () => {
      const errors = await errorsProject('errors-warnings', { adapterTimeoutMs: 2000 });
      const outcome = await swapJson(errors);
      const comparison = comparisonOf(outcome.envelope);
      const sentence =
        'the call that produced raw was not captured, so its cost may be counted twice';
      expect(comparison.warnings).toContainEqual({
        code: 'abandoned-trials',
        variants: ['next'],
        params: {
          trials: { next: { timeout: 2, restart: 0 } },
          timeoutMs: { next: 2000 },
          lateFailures: { next: {} },
        },
      });
      expect(comparison.warnings).toContainEqual({
        code: 'adapter-warnings',
        variants: ['next'],
        caseIds: ['greet-ja-2', 'greet-ko-1', 'greet-ko-2'],
        params: { sentence, trials: { next: 6 } },
      });
      expect(outcome.envelope.warnings).toEqual(comparison.warnings);

      const candidate = await candidateRun(errors, outcome);
      const late = costLines(candidate.lines).filter(
        (line) => 'caseId' in line && line.source === 'late',
      );
      expect(late).toHaveLength(2);

      // Both variants run the same adapter, which declares no post-processing.
      const { reportMarkdown } = await readComparison(errors.outputDir, comparison.comparisonId);
      const human = await errors.run(['swap', '--from', 'current', '--to', 'next']);
      for (const variant of ['current', 'next']) {
        const notice = message('en', 'report.noPostprocess', { variant });
        expect(reportMarkdown).toContain(notice);
        expect(human.stdout).toContain(notice);
      }
    },
    E2E.timeout,
  );
});
