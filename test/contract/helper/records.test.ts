import { describe, expect, it } from 'vitest';

import {
  answerOf,
  callRecords,
  callsOf,
  generateParams,
  inlineCase,
  itRunsTheCases,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// Call records of the TypeScript helper (data-model §Captured Call, §Usage Buckets, §Finish
// Reasons, §Call Outcome, §Derived Result Fields `calls`): per-call fields in send order, usage
// buckets with W9, finish reasons, the outcome of each failure shape and `retryAfterMs`. The rows
// are in test/fixtures/helper/scenarios/records.json.

const server = useMockApi();

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

describe('003 call records of the TypeScript helper (data-model §Captured Call)', () => {
  itRunsTheCases('records.json', '003 FR-007 FR-020', server);

  it(
    '003 FR-007 calls and the trial record latency',
    async () => {
      const scenarioCase = inlineCase({
        service: {
          behaviour: 'steps',
          params: { steps: [{ call: { model: 'model-a' } }, { call: {} }] },
        },
        script: [
          { delayMs: 300, reply: { text: 'Side.' } },
          { delayMs: 200, reply: { text: 'Answer.' } },
        ],
      });
      const result = await withService(scenarioCase, server(), async (driver) =>
        answerOf(await driver.generate(generateParams(scenarioCase)).done),
      );
      const calls = callRecords(result);
      expect(calls.map((call) => call.model)).toEqual(['model-a', 'model-b']);
      const latencies = calls.map((call) => call.latencyMs);
      expect(latencies.every(isNumber)).toBe(true);
      expect(latencies[0]).toBeGreaterThanOrEqual(300);
      expect(latencies[1]).toBeGreaterThanOrEqual(200);
      expect(result.latencyMs).toBeGreaterThanOrEqual(500);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-007 S-RESP-18 latency runs from send to the end of each call',
    async () => {
      // A received call, one dropped mid-body, and one still running when the function returns.
      const scenarioCase = inlineCase({
        service: {
          behaviour: 'steps',
          params: {
            steps: [
              { call: { user: 'First.' } },
              { call: { user: 'Second.' }, swallow: true },
              { background: { user: 'Third.' } },
              { sleep: 200 },
              { return: 'Done.' },
            ],
          },
        },
        script: [
          { match: { bodyIncludes: 'First.' }, delayMs: 300, reply: { text: 'One.' } },
          {
            match: { bodyIncludes: 'Second.' },
            delayMs: 200,
            reply: { text: 'A body cut short.' },
            drop: { chunks: 0, bytes: 5 },
          },
          { match: { bodyIncludes: 'Third.' }, delayMs: 1000, reply: { text: 'Late.' } },
        ],
      });
      const response = await withService(
        scenarioCase,
        server(),
        (driver) => driver.generate(generateParams(scenarioCase)).done,
      );
      const calls = callsOf(response);
      expect(calls.map((call) => call.outcome)).toEqual(['ok', 'unanswered', 'ok']);
      expect(calls[0]?.latencyMs).toBeGreaterThanOrEqual(300);
      expect(calls[1]?.latencyMs).toBeGreaterThanOrEqual(200);
      expect(calls[2]).not.toHaveProperty('latencyMs');
    },
    TIMEOUT_MS,
  );
});
