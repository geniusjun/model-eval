import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../../../src/adapter/json-value.js';
import type { RpcResponse } from './support/driver.js';
import {
  callsOf,
  generateParams,
  inlineCase,
  isMessage,
  itRunsTheCases,
  message,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// The trial outcome of the TypeScript helper: data-model §Outcome Decision rows 1 to 9 with the
// row 3 and row 5 exceptions, `discardOn` as classes and as a function, `discardReason` built from
// `e.constructor.name` and `e.message` (from `String(e)` for a thrown value that is not an
// `Error`), `capturedRaw` and the "The target function raised <exception>." forms of A1, A2, A3
// and the Outcome row 9 message, A14 and A16 (helper-api §Messages), on the rows S-RESP-07,
// S-RESP-08, S-RESP-13, S-RESP-14, S-RESP-17, S-EXC-01, S-EXC-02 and §Side Calls of
// helper-scenarios.

const server = useMockApi();

/** The response of one trial of services/raising_targets.mjs's `target`. */
function raisingTarget(target: string, reply: JsonObject): Promise<RpcResponse<unknown>> {
  const scenarioCase = inlineCase({ service: { behaviour: 'none' }, script: [reply] });
  return withService(
    scenarioCase,
    server(),
    async (driver) => driver.generate(generateParams(scenarioCase, { target })).done,
    { service: 'raising_targets' },
  );
}

function adapterErrorMessage(response: RpcResponse<unknown>): string | undefined {
  return response.kind === 'error' ? response.error.message : undefined;
}

describe('003 the outcome decision of the TypeScript helper (data-model §Outcome Decision)', () => {
  itRunsTheCases('outcome.json', '003 FR-011 FR-012 FR-013 FR-014', server);

  it(
    '003 FR-011 a non-text return value without a model call is A14',
    async () => {
      const scenarioCase = inlineCase({
        service: { behaviour: 'returns', params: { steps: [], value: 'none' } },
        script: [],
      });
      const response = await withService(
        scenarioCase,
        server(),
        async (driver) => driver.generate(generateParams(scenarioCase)).done,
      );
      expect(adapterErrorMessage(response)).toBe(message('A14'));
    },
    TIMEOUT_MS,
  );

  it.each(['reply-call', 'discard-on'])(
    '003 FR-011 S-RESP-17 an option that throws is A16 with the calls (%s)',
    async (target) => {
      const response = await raisingTarget(target, { reply: { text: 'Hi.' } });
      const option = target.replace('-', '_');
      expect(adapterErrorMessage(response)).toBe(
        message('A16', { exception: `Error: ${option} is broken` }),
      );
      expect(callsOf(response).map((call) => [call.model, call.outcome])).toEqual([
        ['model-b', 'ok'],
      ]);
    },
    TIMEOUT_MS,
  );

  it.each(['reply-call', 'discard-on'])(
    '003 FR-011 S-RESP-17 after a captured 401 Outcome row 1 decides (%s)',
    async (target) => {
      const response = await raisingTarget(target, { error: { status: 401 } });
      expect(response.kind).toBe('result');
      if (response.kind === 'result') {
        expect(response.sent).toMatchObject({ error: { kind: 'config' } });
      }
      expect(callsOf(response).map((call) => [call.outcome, call.errorKind])).toEqual([
        ['failed', 'config'],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-011 S-RESP-17 A16 waits for an unfinished call',
    async () => {
      // replyCall throws; the call still running when the function returned is waited for and
      // recorded as it ended, without latencyMs (data-model §When a Call Ended).
      const response = await raisingTarget('reply-call-unfinished', {
        delayMs: 1000,
        reply: { text: 'Late.' },
      });
      expect(adapterErrorMessage(response)).toBe(
        message('A16', { exception: 'Error: reply_call is broken' }),
      );
      expect(callsOf(response).map((call) => [call.outcome, 'latencyMs' in call])).toEqual([
        ['ok', false],
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-011 a target function that throws its own AbortError without a cancel is the Outcome row 9 adapter error',
    async () => {
      // No tool `cancel` was sent, so it is an undeclared exception (Outcome row 9).
      const response = await raisingTarget('aborted', { reply: { text: 'Hi.' } });
      const text = adapterErrorMessage(response) ?? '';
      expect(isMessage('row9', 'exception', text), text).toBe(true);
      expect(text).toContain(
        'The target function raised DOMException: This operation was aborted.',
      );
      expect(response.kind === 'error' ? response.error.data : undefined).toMatchObject({
        capturedRaw: 'Hi.',
      });
    },
    TIMEOUT_MS,
  );

  it.each([
    [
      'an Error subclass: its class name and message',
      { class: 'EmptyReply', message: 'nothing to send' },
      'EmptyReply: nothing to send',
    ],
    ['a thrown string: String(e)', { value: 'nothing to send' }, 'nothing to send'],
    ['a thrown number: String(e)', { value: 42 }, '42'],
  ] as const)(
    '003 FR-013 discardReason of %s',
    async (_title, thrown, reason) => {
      const scenarioCase = inlineCase({
        service: {
          behaviour: 'steps',
          params: { steps: [{ call: {} }, { raise: { ...thrown } }] },
        },
        target: { discardOn: { when: {} } },
        script: [{ reply: { text: 'Hello.' } }],
      });
      const response = await withService(
        scenarioCase,
        server(),
        async (driver) => driver.generate(generateParams(scenarioCase)).done,
      );
      expect(response.kind === 'result' ? response.sent : response.error).toMatchObject({
        finalKind: 'discarded',
        discardReason: reason,
      });
    },
    TIMEOUT_MS,
  );
});
