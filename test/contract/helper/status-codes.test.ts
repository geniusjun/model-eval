import { describe, expect, it } from 'vitest';

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

// Error kinds from HTTP status codes and error objects on the TypeScript helper: every row of
// helper-scenarios §Status Codes, per helper-api §Error Classification and data-model §Call
// Outcome, including User Story 1 acceptance scenarios 6 (a rate limit left after the SDK's
// retries is `transient`) and 7 (an authentication failure is `config`).

const server = useMockApi();

describe('003 status codes on the TypeScript helper (helper-api §Error Classification)', () => {
  itRunsTheCases('status_codes.json', '003 FR-007 FR-017', server);

  it(
    '003 FR-017 S-STAT-15 a body that is not a JSON object names itself',
    async () => {
      const scenarioCase = inlineCase({
        service: {
          behaviour: 'flow',
          params: { steps: [{ call: { onError: 'swallow' } }], result: { text: 'x' } },
        },
        script: [
          { sse: { chunks: [{ text: '[]' }] }, headers: { 'content-type': 'application/json' } },
        ],
      });
      const result = await withService(scenarioCase, server(), async (driver) =>
        resultOf(await driver.generate(generateParams(scenarioCase)).done),
      );
      expect(result.error).toEqual({ kind: 'config', message: message('F1') });
    },
    TIMEOUT_MS,
  );
});
