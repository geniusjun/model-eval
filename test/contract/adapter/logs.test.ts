import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AdapterLog, STDERR_TAIL_LINES, StderrTail } from '../../../src/adapter/logs.js';
import { message } from '../../../src/messages/index.js';
import { createRedactor } from '../../../src/report/redact.js';
import { RUN_FILES } from '../../../src/run/writer.js';
import type { CliResult } from '../../e2e/support/cli.js';
import { greetCases, createProject, type Project } from '../../e2e/support/project.js';
import { ANSWERED } from '../../e2e/support/rules.js';

// Adapter stderr and `log` notifications (adapter-protocol §Transport 3, §`log`; FR-008, FR-031).

const PHONE = '010-1234-5678';
const REDACT = [{ pattern: '\\b01[0-9]-?\\d{3,4}-?\\d{4}\\b', replace: '<phone>' }];
const AT = new Date('2026-11-05T10:15:00.000Z');
const LOG_LINE = z.object({ at: z.string(), level: z.string(), message: z.string() });

describe('adapter.log and grouped logs', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'model-eval-logs-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('001 FR-031 writes every log notification to adapter.log redacted, also those received before the file opened', async () => {
    const log = new AdapterLog(createRedactor(REDACT), () => AT);
    log.record({ level: 'info', message: `started for ${PHONE}` });
    const file = path.join(dir, 'adapter.log');
    await log.open(file);
    log.record({ level: 'warn', message: `cache miss\nfor ${PHONE}` });
    await log.close();
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
    expect(lines.map((line) => LOG_LINE.parse(JSON.parse(line)))).toEqual([
      { at: AT.toISOString(), level: 'info', message: 'started for <phone>' },
      { at: AT.toISOString(), level: 'warn', message: 'cache miss\nfor <phone>' },
    ]);
    expect(await readFile(file, 'utf8')).not.toContain(PHONE);
  });

  it('001 FR-008 groups warn and error logs by redacted message with counts, errors first', () => {
    const log = new AdapterLog(createRedactor(REDACT), () => AT);
    for (const text of [`miss ${PHONE}`, 'miss 011-555-1234', 'miss 011-555-1234']) {
      log.record({ level: 'warn', message: text });
    }
    log.record({ level: 'error', message: 'write failed' });
    log.record({ level: 'debug', message: 'detail' });
    log.record({ level: 'info', message: 'started' });
    log.record({ level: 'warn', message: 'another' });
    // A group keeps its first message as written; output redacts it once, into the group's key.
    expect(log.groups()).toEqual([
      { level: 'error', message: 'write failed', count: 1 },
      { level: 'warn', message: `miss ${PHONE}`, count: 3 },
      { level: 'warn', message: 'another', count: 1 },
    ]);
  });

  it('001 FR-031 leaves group messages to be redacted once, where they are shown', () => {
    const doubling = createRedactor([{ pattern: 'x', replace: 'xx' }]);
    const log = new AdapterLog(doubling, () => AT);
    log.record({ level: 'warn', message: 'x' });
    const [group] = log.groups();
    expect(doubling.text(group?.message ?? '')).toBe('xx');
  });

  it('001 FR-008 keeps the last 50 stderr lines for failure reports', () => {
    const tail = new StderrTail();
    for (let line = 1; line <= 120; line += 1) {
      tail.push(`line ${String(line)}`);
    }
    expect(STDERR_TAIL_LINES).toBe(50);
    expect(tail.lines()).toHaveLength(50);
    expect(tail.lines()[0]).toBe('line 71');
    expect(tail.lines().at(-1)).toBe('line 120');
  });
});

describe('adapter stderr and logs in runs', () => {
  const projects: Project[] = [];
  const cases = greetCases({ ko: 2, ja: 2 });
  let quiet: CliResult;
  let verbose: CliResult;
  let crashed: CliResult;
  let logged: Project;

  beforeAll(async () => {
    logged = await createProject({
      scenario: 'logs-run',
      rules: [ANSWERED],
      cases,
      config: { redact: REDACT },
    });
    const crashing = await createProject({
      scenario: 'logs-crash',
      rules: [ANSWERED],
      cases,
      config: { redact: REDACT },
    });
    projects.push(logged, crashing);
    quiet = await logged.run(['run', '--variant', 'next']);
    verbose = await logged.run(['run', '--variant', 'next', '--verbose']);
    crashed = await crashing.run(['run', '--variant', 'next']);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(projects.map((project) => project.dispose()));
  });

  it('001 FR-031 shows adapter stderr only with --verbose, redacted', () => {
    expect(verbose.code).toBe(0);
    expect(verbose.stderr).toContain('mock: handling greet-ko-1 for <phone>');
    expect(quiet.stderr).not.toContain('mock: handling');
    for (const result of [quiet, verbose]) {
      expect(result.stdout + result.stderr).not.toContain(PHONE);
    }
  });

  it('001 FR-008 shows warn and error logs grouped with counts at the end of a run, without --verbose', () => {
    expect(quiet.code).toBe(0);
    const trials = cases.length * 2;
    expect(quiet.stderr).toContain(message('en', 'human.adapter.logs', { variant: 'next' }));
    expect(quiet.stderr).toContain(
      message('en', 'human.adapter.logGroup', {
        level: 'error',
        count: trials,
        message: 'background write failed',
      }),
    );
    expect(quiet.stderr).toContain(
      message('en', 'human.adapter.logGroup', {
        level: 'warn',
        count: trials,
        message: 'cache miss for <phone>',
      }),
    );
    expect(quiet.stderr).not.toContain('prompt built for');
  });

  it('001 FR-031 writes log notifications to the run adapter.log, redacted', async () => {
    const runs = await readdir(path.join(logged.outputDir, 'runs'));
    expect(runs).toHaveLength(2);
    for (const runId of runs) {
      const text = await readFile(
        path.join(logged.outputDir, 'runs', runId, RUN_FILES.adapterLog),
        'utf8',
      );
      expect(text).not.toContain(PHONE);
      const levels = text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => LOG_LINE.parse(JSON.parse(line)).level);
      expect(levels.filter((level) => level === 'debug')).toHaveLength(cases.length * 2);
      expect(text).toContain('prompt built for <phone>');
    }
  });

  it('001 FR-008 attaches the last stderr lines, redacted, to the report of a run the adapter stopped', () => {
    expect(crashed.code).toBe(3);
    expect(crashed.stderr).toContain(
      message('en', 'human.adapter.stderrTail.other', { variant: 'next', count: 9 }),
    );
    expect(crashed.stderr).toContain('  mock: handling greet-ko-1 for <phone>');
    expect(crashed.stdout + crashed.stderr).not.toContain(PHONE);
  });
});
