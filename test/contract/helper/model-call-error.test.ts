import { describe, expect, it } from 'vitest';

import type { RpcResponse } from './support/driver.js';
import {
  generateParams,
  inlineCase,
  itRunsTheCases,
  message,
  resultOf,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// A thrown `ModelCallError` (helper-api §`ModelCallError`, §The `call` Check): every row of
// helper-scenarios §`ModelCallError` on the TypeScript helper, per data-model §Matching Reported
// Failures, with A12, A13, W10, `retryAfterMs` from the matched call or the thrown value and a
// `retryAfterMs` of -1 or NaN that is not recorded (S-PAR-11). Only a `ModelCallError` the target
// function throws itself is a reported failure: inside an `AggregateError` it is part of the
// service's own exception (services/grouped_failure.mjs).

const server = useMockApi();
const AGGREGATE = 'AggregateError: check failed';

/** The response of one trial of services/grouped_failure.mjs's `target`. */
function groupedFailure(target: string): Promise<RpcResponse<unknown>> {
  const scenarioCase = inlineCase({
    service: { behaviour: 'none' },
    script: [{ reply: { text: 'Hello.' } }],
  });
  return withService(
    scenarioCase,
    server(),
    async (driver) => driver.generate(generateParams(scenarioCase, { target })).done,
    { service: 'grouped_failure' },
  );
}

describe('003 ModelCallError on the TypeScript helper (helper-scenarios §ModelCallError)', () => {
  itRunsTheCases('model_call_error.json', '003 FR-017 FR-018 FR-020', server);

  it(
    '003 FR-011 a ModelCallError in an AggregateError is a service exception that discardOn takes',
    async () => {
      const result = resultOf(await groupedFailure('discarded'));
      expect([result.finalKind, result.raw]).toEqual(['discarded', 'Hello.']);
      expect(result.discardReason).toBe(AGGREGATE);
      expect(result).not.toHaveProperty('error');
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-011 an AggregateError outside discardOn is the Outcome row 9 adapter error',
    async () => {
      const response = await groupedFailure('raised');
      expect(response.kind === 'error' ? response.error.message : undefined).toBe(
        message('row9', { exception: AGGREGATE }),
      );
      expect(response.kind === 'error' ? response.error.data : undefined).toMatchObject({
        capturedRaw: 'Hello.',
      });
    },
    TIMEOUT_MS,
  );
});
