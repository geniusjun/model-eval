import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../../../src/adapter/json-value.js';
import type { AdapterDriver } from './support/driver.js';
import type { MockApi } from './support/mock-api.js';
import type { ScenarioCase } from './support/scenarios.js';
import {
  callsOf,
  generateParams,
  inlineCase,
  isMessage,
  itRunsTheCases,
  message,
  resultOf,
  sdkFor,
  startService,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// `cancel` on the TypeScript helper (helper-api §Cancel; data-model §Call Outcome): the trial's
// `fetch` calls in flight are aborted and recorded `unanswered` and unclassified, the response is
// sent as soon as the function has ended, later captured requests of the trial fail before they
// are sent and are reported nowhere, and background work that hit a blocked request is logged as
// L3. Fixture rows: S-RESP-11, S-COST-09.

const server = useMockApi();

async function waitForRequests(mock: MockApi, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while ((await mock.log()).length < count) {
    if (Date.now() > deadline) {
      throw new Error(`the mock server never received ${String(count)} requests`);
    }
    await sleep(10);
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await sleep(50);
  }
}

function stepsCase(steps: JsonObject[], script: JsonObject[]): ScenarioCase {
  return inlineCase({ service: { behaviour: 'steps', params: { steps } }, script });
}

/** Sends the trial, cancels it once the mock server received `requests`, and waits for it. */
async function cancelAfter(
  driver: AdapterDriver,
  scenarioCase: ScenarioCase,
  requests: number,
  target?: string,
): Promise<{ response: Awaited<ReturnType<AdapterDriver['generate']>['done']>; afterMs: number }> {
  const sent = driver.generate(
    generateParams(scenarioCase, target === undefined ? {} : { target }),
  );
  await waitForRequests(server(), requests);
  driver.cancel(sent.id);
  const cancelled = performance.now();
  const response = await sent.done;
  return { response, afterMs: performance.now() - cancelled };
}

/**
 * The `<exception>` of the SDK's error for a request that never arrived: its class name and the
 * SDK's own default message.
 */
async function blockedRequestError(scenarioCase: ScenarioCase): Promise<string> {
  const sdk = (await import(scenarioCase.sdk ?? sdkFor(scenarioCase.api))) as {
    APIConnectionError: new (options: { cause?: Error }) => Error;
  };
  const error = new sdk.APIConnectionError({ cause: new Error('blocked') });
  return `${error.constructor.name}: ${error.message}`.trim();
}

describe('003 cancel on the TypeScript helper (helper-api §Cancel)', () => {
  itRunsTheCases('cancel.json', '003 FR-023', server);

  it(
    '003 FR-023 only an integer id names the trial to cancel: true and "1" cancel nothing, 1.0 names trial 1',
    async () => {
      // No `initialize`, so the first trial has the request id 1, the id `true` would equal in
      // a language where a bool is an integer.
      const scenarioCase = stepsCase(
        [{ call: {} }],
        [
          { delayMs: 1000, reply: { text: 'Kept.' } },
          { delayMs: 1000, reply: { text: 'Kept.' } },
        ],
      );
      const mock = server();
      const driver = await startService(scenarioCase, mock);
      try {
        const first = driver.generate(generateParams(scenarioCase));
        expect(first.id).toBe(1);
        await waitForRequests(mock, 1);
        driver.writeLine('{"jsonrpc":"2.0","method":"cancel","params":{"id":true}}');
        driver.writeLine('{"jsonrpc":"2.0","method":"cancel","params":{"id":"1"}}');
        const kept = await first.done;
        const second = driver.generate(generateParams(scenarioCase));
        await waitForRequests(mock, 2);
        driver.writeLine(
          `{"jsonrpc":"2.0","method":"cancel","params":{"id":${String(second.id)}.0}}`,
        );
        const cancelled = await second.done;
        expect(kept.kind === 'result' ? resultOf(kept).error : undefined).not.toEqual({
          kind: 'timeout',
          message: message('F2'),
        });
        expect(resultOf(cancelled).error).toEqual({ kind: 'timeout', message: message('F2') });
        await driver.shutdown();
      } finally {
        await driver.close();
      }
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-023 cancel aborts the trial fetch calls and the response follows at once',
    async () => {
      const scenarioCase = stepsCase(
        [{ call: {} }, { print: 'the target went on after the cut' }],
        [{ delayMs: 5000, reply: { text: 'Too late.' } }],
      );
      const { response, afterMs, stderr } = await withService(
        scenarioCase,
        server(),
        async (driver) => {
          const cancelled = await cancelAfter(driver, scenarioCase, 1);
          await sleep(500);
          return { ...cancelled, stderr: driver.stderr() };
        },
      );
      expect(afterMs).toBeLessThan(2000);
      expect(resultOf(response).error).toEqual({ kind: 'timeout', message: message('F2') });
      expect(callsOf(response).map((call) => [call.outcome, call.errorKind ?? null])).toEqual([
        ['unanswered', null],
      ]);
      expect(stderr).not.toContain('went on after the cut');
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-023 background work hitting a blocked request logs L3',
    async () => {
      const scenarioCase = stepsCase(
        // The background request starts 2.5 s after the call, well after the cancel that follows
        // the call's arrival at the mock server.
        [{ background: { user: 'Remember this.' }, delay: 2500 }, { call: {} }],
        [{ delayMs: 5000, reply: { text: 'Too late.' } }],
      );
      const sentence = message('L3', { exception: await blockedRequestError(scenarioCase) });
      const { warnings, notified } = await withService(scenarioCase, server(), async (driver) => {
        await cancelAfter(driver, scenarioCase, 1);
        await waitUntil(() => driver.exchange.logs.some((log) => log.message === sentence));
        return {
          warnings: driver.exchange.logs
            .filter((log) => log.level === 'warn')
            .map((log) => log.message),
          notified: driver.exchange.calls,
        };
      });
      expect(warnings).toEqual([sentence]);
      expect(await server().log()).toHaveLength(1);
      expect(notified).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-023 cancel while waiting for unfinished calls blocks later requests',
    async () => {
      // The function has returned and the helper waits for a slow background call when the tool
      // cancels. The cancel cuts that call, so its background work gets an exception instead of
      // the mock server's answer (6 s), and a request the context makes afterwards is not sent and
      // not reported. Both are logged as L3 (helper-api §Cancel: a request cut on `cancel` or
      // blocked after it), none as L2.
      const scenarioCase = stepsCase(
        [
          { call: {} },
          { background: { user: 'Slow note.' } },
          { background: { user: 'Late note.' }, delay: 4500 },
          { sleep: 200 },
        ],
        [
          { match: { bodyIncludes: 'Slow note' }, delayMs: 6000, reply: { text: 'Ok.' } },
          { match: { bodyIncludes: 'Late note' }, reply: { text: 'Never sent.' } },
          { reply: { text: 'Hello.' } },
        ],
      );
      const sentence = message('L3', { exception: await blockedRequestError(scenarioCase) });
      const { response, notified, warnings } = await withService(
        scenarioCase,
        server(),
        async (driver) => {
          const sent = driver.generate(generateParams(scenarioCase));
          await waitForRequests(server(), 2);
          // The function returns 0.2 s after starting, so 2 s later the trial is waiting for the slow
          // call (6 s), and the late request (4.5 s) has not started yet.
          await sleep(2200);
          driver.cancel(sent.id);
          const done = await sent.done;
          // Two L3 lines: the cut slow call and the blocked late request. A slow call left running
          // would end with the mock server's answer and log nothing.
          await waitUntil(
            () =>
              driver.exchange.logs.filter((log) => isMessage('L3', 'exception', log.message))
                .length >= 2,
            10_000,
          );
          return {
            response: done,
            notified: driver.exchange.calls,
            warnings: driver.exchange.logs
              .filter((log) => log.level === 'warn')
              .map((log) => log.message),
          };
        },
      );
      expect(resultOf(response).error).toEqual({ kind: 'timeout', message: message('F2') });
      expect(callsOf(response).map((call) => call.outcome)).toEqual(['ok', 'unanswered']);
      expect(callsOf(response)[1]).not.toHaveProperty('errorKind');
      const l3 = warnings.filter((warning) => isMessage('L3', 'exception', warning));
      expect(l3).toHaveLength(2);
      expect(l3).toContain(sentence);
      expect(warnings.filter((warning) => isMessage('L2', 'exception', warning))).toEqual([]);
      expect(await server().log()).toHaveLength(2);
      expect(notified).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-023 a cancelled trial with a throwing replyCall still reports config',
    async () => {
      // Outcome row 1 is decided from the calls without replyCall, so a captured 401 makes the
      // cancel result `config` even though replyCall throws.
      const scenarioCase = inlineCase({
        service: { behaviour: 'none' },
        script: [
          { status: 401, error: { message: 'invalid key' } },
          { delayMs: 5000, reply: { text: 'Too late.' } },
        ],
      });
      const { response } = await withService(
        scenarioCase,
        server(),
        (driver) => cancelAfter(driver, scenarioCase, 2, 'reply-call-cancelled'),
        { service: 'raising_targets' },
      );
      expect(resultOf(response).error).toMatchObject({ kind: 'config' });
      expect(callsOf(response).map((call) => [call.outcome, call.errorKind ?? null])).toEqual([
        ['failed', 'config'],
        ['unanswered', null],
      ]);
    },
    TIMEOUT_MS,
  );
});
