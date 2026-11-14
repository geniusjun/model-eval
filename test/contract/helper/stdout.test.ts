import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { startAdapter } from '../../../src/adapter/client.js';
import type { JsonObject } from '../../../src/adapter/json-value.js';
import { NODE_SERVICES } from './support/driver.js';
import type { ScenarioCase } from './support/scenarios.js';
import {
  answerOf,
  generateParams,
  inlineCase,
  itRunsTheCases,
  serviceEnv,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// stdout protection on the TypeScript helper (helper-api §stdout Protection; User Story 3
// acceptance scenarios 3 and 4): `process.stdout.write` and `console` output go to stderr and the
// protocol stays intact, also while the service module is imported; Node cannot move descriptor 1,
// so output written to it directly, by a native module or a child process, reaches the tool, whose
// client (src/adapter/client.ts) reports it as stdout contamination. The driver fails a test on
// any stdout line that is not a protocol message.

const server = useMockApi();
const SERVICE = 'stdout_steps';

function stdoutCase(steps: readonly JsonObject[], times = 1): ScenarioCase {
  return inlineCase({
    service: { behaviour: 'stdout', params: { steps: [...steps] } },
    script: [{ times, reply: { text: 'Hello.' } }],
  });
}

describe('003 stdout protection of the TypeScript helper (helper-api §stdout Protection)', () => {
  itRunsTheCases('stdout.json', '003 FR-002', server);

  it(
    '003 FR-002 process.stdout.write and console output go to stderr (acceptance scenario 3)',
    async () => {
      const scenarioCase = stdoutCase([
        { write: 'from process.stdout.write\n' },
        { console: 'from console' },
        { call: {} },
      ]);
      const { result, stderr } = await withService(
        scenarioCase,
        server(),
        async (driver) => ({
          result: answerOf(await driver.generate(generateParams(scenarioCase)).done),
          stderr: () => driver.stderr(),
        }),
        { service: SERVICE },
      );
      expect(result.raw).toBe('Hello.');
      for (const text of [
        'from process.stdout.write',
        'from console (log)',
        'from console (info)',
        'from console (debug)',
      ]) {
        expect(stderr()).toContain(text);
      }
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-002 output while the service module is imported after the helper goes to stderr',
    async () => {
      const scenarioCase = stdoutCase([{ call: {} }]);
      const { result, stderr } = await withService(
        scenarioCase,
        server(),
        async (driver) => ({
          result: answerOf(await driver.generate(generateParams(scenarioCase)).done),
          stderr: () => driver.stderr(),
        }),
        { service: SERVICE },
      );
      expect(result.raw).toBe('Hello.');
      expect(stderr()).toContain('written to process.stdout while the service module is imported');
      expect(stderr()).toContain('logged while the service module is imported');
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-002 protocol lines stay intact around long unterminated output of concurrent trials',
    async () => {
      const long = 'x'.repeat(200_000);
      const scenarioCase = stdoutCase(
        [{ write: long }, { call: {} }, { write: long }, { return: 'done' }],
        4,
      );
      const results = await withService(
        scenarioCase,
        server(),
        async (driver) => {
          const sent = [1, 2, 3, 4].map(
            (index) =>
              driver.generate(generateParams(scenarioCase, { caseId: `case-${String(index)}` }))
                .done,
          );
          return (await Promise.all(sent)).map((response) => answerOf(response));
        },
        { service: SERVICE },
      );
      expect(results.map((result) => result.final)).toEqual(['done', 'done', 'done', 'done']);
      expect(results.map((result) => result.raw)).toEqual(['Hello.', 'Hello.', 'Hello.', 'Hello.']);
    },
    TIMEOUT_MS,
  );

  it.each([
    ['fs.writeSync(1, …)', { fd: 'from descriptor 1\n' }, 'from descriptor 1'],
    [
      'a child process sharing descriptor 1',
      { child: 'from a child process' },
      'from a child process',
    ],
  ] as const)(
    '003 FR-002 output written by %s is reported by the tool as stdout contamination (acceptance scenario 4)',
    async (_how, step, line) => {
      const scenarioCase = stdoutCase([step, { call: {} }]);
      const mock = server();
      await mock.load(scenarioCase.data.script ?? []);
      const started = await startAdapter({
        launch: {
          command: [process.execPath, path.join(NODE_SERVICES, `${SERVICE}.mjs`)],
          cwd: NODE_SERVICES,
          env: { ...serviceEnv(scenarioCase, mock), MODEL_EVAL_SDK: String(scenarioCase.sdk) },
        },
        initialize: {
          client: { name: 'model-eval', version: '0.0.0-test' },
          variant: { id: 'next', model: 'model-b' },
          timeoutMs: 30_000,
          toolPaths: [],
        },
        concurrency: 1,
      });
      if (!started.ok) {
        throw new Error(`the stdout service did not start: ${started.error.message}`);
      }
      const { client } = started;
      const outcome = await client.generate({
        target: 'chat',
        caseId: 'case-1',
        lang: 'en',
        input: {},
        repeat: 0,
        seed: 1,
      });
      const ended = await client.shutdown();
      expect(outcome.kind).toBe('lost');
      if (outcome.kind === 'lost') {
        expect(outcome.message).toContain('stdout is reserved for the protocol');
        expect(outcome.message).toContain(line);
      }
      expect(ended.violation ?? '').toContain(line);
    },
    TIMEOUT_MS,
  );
});
