import { describe, expect, it } from 'vitest';

import {
  inlineCase,
  itRunsTheCases,
  nodeApis,
  resultOf,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';
import { trialParams } from './support/scenarios.js';

// Answer calls on the TypeScript helper: data-model §Call Branches, §Answers and §Raw Cannot Be
// Determined on the rows of helper-scenarios §Answer Calls and S-RESP-03, S-RESP-04, S-RESP-06,
// S-RESP-12 (A6) and S-RESP-16; the four causes of adapter error A3; warnings W1, W2 and W3.

const server = useMockApi();

describe('003 answer calls on the TypeScript helper (data-model §Answers)', () => {
  itRunsTheCases(
    'answer_calls.json',
    '003 FR-009 FR-010 FR-012 FR-014 FR-015 FR-016 FR-020',
    server,
  );

  it.runIf(nodeApis().includes('messages'))(
    '003 FR-012 an empty Anthropic system text block is an empty line',
    async () => {
      // helper-api §Render Mode: each text block gives one line, an empty text an empty one, so
      // the system that branches and answers compare keeps it (data-model §System Prompt).
      const body = {
        system: [
          { type: 'text', text: 'A' },
          { type: 'text', text: '' },
          { type: 'text', text: 'B' },
        ],
        messages: [{ role: 'user', content: 'Say hello.' }],
        max_tokens: 64,
      };
      const scenarioCase = inlineCase(
        {
          service: { behaviour: 'bodies', params: { requests: [body] } },
          target: { render: true },
          request: 'render',
        },
        'messages',
      );
      const render = await withService(scenarioCase, server(), async (driver) =>
        resultOf(await driver.render(trialParams(scenarioCase.data))),
      );
      expect(render.messages).toEqual([
        { role: 'system', content: 'A\n\nB' },
        { role: 'user', content: 'Say hello.' },
      ]);
    },
    TIMEOUT_MS,
  );
});
