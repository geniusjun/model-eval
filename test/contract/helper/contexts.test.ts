import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { JsonValue } from '../../../src/adapter/json-value.js';
import type { RpcResponse } from './support/driver.js';
import {
  checkExpect,
  expectationOf,
  initializeParams,
  nodeCases,
  type Outcome,
  type ScenarioCase,
  trialParams,
} from './support/scenarios.js';
import { itRunsTheCases, startService, TIMEOUT_MS, useMockApi } from './support/service-runs.js';

// Trial contexts on the TypeScript helper (`AsyncLocalStorage`): helper-scenarios §Contexts and
// S-RESP-10, per data-model §Outside the Trial Context and §After the Function Returned: requests
// without a context, unfinished calls waited for until `timeoutMs` minus the time spent minus 5 s,
// requests after the result as `calls` notifications, and log warning L2 for an unhandled promise
// rejection of background work. The Node services wait one `setImmediate` before a check that
// reads what earlier work left, as the Python ones yield to the event loop once.

const server = useMockApi();
/** data-model §Unfinished Calls: the wait keeps 5 s of the tool's time limit. */
const WAIT_KEPT_MS = 5000;

function firstCase(scenario: string): ScenarioCase {
  const found = nodeCases('contexts.json').find(
    (scenarioCase) => scenarioCase.scenario === scenario,
  );
  if (found === undefined) {
    throw new Error(`${scenario} has no Node case`);
  }
  return found;
}

describe('003 trial contexts of the TypeScript helper (data-model §Outside the Trial Context)', () => {
  itRunsTheCases('contexts.json', '003 FR-006 FR-008 FR-015', server);

  it(
    '003 FR-008 the wait for unfinished calls ends 5 s before the tool time limit',
    async () => {
      const scenarioCase = firstCase('S-CTX-07');
      const mock = server();
      const driver = await startService(scenarioCase, mock);
      try {
        const initialize = initializeParams(scenarioCase.data);
        expect((await driver.initialize(initialize)).kind).toBe('result');
        const sent = performance.now();
        const response = await driver.generate(trialParams(scenarioCase.data)).done;
        const elapsed = performance.now() - sent;
        await driver.shutdown();
        const sentJson: RpcResponse<JsonValue> =
          response.kind === 'error'
            ? response
            : { kind: 'result', result: response.sent, sent: response.sent };
        const outcome: Outcome = {
          response: sentJson,
          responses: [sentJson],
          exchange: driver.exchange,
          requests: await mock.log(),
          renderFingerprint: undefined,
        };
        expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
        const limitMs = Number(initialize.timeoutMs);
        expect(elapsed).toBeGreaterThanOrEqual(limitMs - WAIT_KEPT_MS - 300);
        expect(elapsed).toBeLessThanOrEqual(limitMs - WAIT_KEPT_MS + 1000);
      } finally {
        await driver.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-008 background requests are reported before the shutdown response',
    async () => {
      const scenarioCase = firstCase('S-CTX-23');
      const mock = server();
      const driver = await startService(scenarioCase, mock);
      try {
        expect((await driver.initialize(initializeParams(scenarioCase.data))).kind).toBe('result');
        await driver.generate(trialParams(scenarioCase.data)).done;
        expect(driver.exchange.calls, 'a call was reported before it ended').toEqual([]);
        const wanted = Number(scenarioCase.data.shutdownAfterRequests);
        while ((await mock.log()).length < wanted) {
          await sleep(10);
        }
        await driver.shutdown();
        expect(
          driver.exchange.calls,
          'the background call was not reported before the shutdown response',
        ).toHaveLength(1);
      } finally {
        await driver.close();
      }
    },
    TIMEOUT_MS,
  );
});
