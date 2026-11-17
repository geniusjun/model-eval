import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonObject } from '../../../src/adapter/json-value.js';
import type { RpcResponse } from './support/driver.js';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { reportVersion, repository } from './support/repositories.js';
import { nodeCases, runCase, type ScenarioCase } from './support/scenarios.js';
import {
  generateParams,
  inlineCase,
  itRunsTheCases,
  message,
  TIMEOUT_MS,
  useMockApi,
  withService,
} from './support/service-runs.js';

// Messages on the TypeScript helper (helper-api §Messages): every adapter error, trial warning and
// log warning equals its sentence in test/fixtures/helper/messages.json with the placeholders
// filled, in English whatever the trial's `lang`; a warning never changes the outcome (spec
// FR-020). Fixture rows: test/fixtures/helper/scenarios/messages.json.

const server = useMockApi();
const OUTCOME_FIELDS = ['finalKind', 'raw', 'answers', 'finishReason', 'discardReason'];

/**
 * Each case with a warning "attached", and the case of the same row, API and SDK whose name says
 * the warning's condition is absent.
 */
function warningPairs(): [ScenarioCase, ScenarioCase][] {
  const cases = nodeCases('messages.json');
  return cases.flatMap((withWarning): [ScenarioCase, ScenarioCase][] => {
    if (!withWarning.name.includes(' attached')) {
      return [];
    }
    const message = withWarning.name.split(' attached')[0] ?? '';
    return cases
      .filter(
        (without) =>
          without.scenario === withWarning.scenario &&
          without.name.startsWith(`${message} condition absent`) &&
          without.api === withWarning.api &&
          without.sdk === withWarning.sdk,
      )
      .map((without) => [withWarning, without]);
  });
}

function resultFields(response: RpcResponse<unknown>): JsonObject {
  if (response.kind === 'error') {
    return {};
  }
  return isJsonObject(response.sent) ? response.sent : {};
}

function outcome(response: RpcResponse<unknown>): JsonObject {
  const result = resultFields(response);
  const kind = isJsonObject(result.error) ? result.error.kind : undefined;
  return {
    status: response.kind === 'error' ? 'adapter-error' : (kind ?? null),
    ...Object.fromEntries(OUTCOME_FIELDS.map((name) => [name, result[name] ?? null])),
  };
}

const PAIRS = warningPairs();

describe('003 messages of the TypeScript helper (helper-api §Messages)', () => {
  itRunsTheCases('messages.json', '003 FR-020', server);

  it('003 FR-020 the fixture pairs every attached warning with a case without its condition', () => {
    expect(PAIRS.length).toBeGreaterThan(0);
  });

  it.each(
    PAIRS.map(
      ([withWarning, without]) =>
        [
          `${withWarning.name} [${String(withWarning.sdk)} ${withWarning.api}]`,
          withWarning,
          without,
        ] as const,
    ),
  )(
    '003 FR-020 a warning does not change the outcome: %s',
    async (_title, withWarning, without) => {
      const warned = (await runCase(withWarning, server())).response;
      const plain = (await runCase(without, server())).response;
      expect(resultFields(warned).warnings).not.toEqual([]);
      expect(resultFields(warned).warnings).toBeDefined();
      expect(resultFields(plain).warnings ?? []).toEqual([]);
      expect(outcome(warned)).toEqual(outcome(plain));
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-020 A10 when two trials are in progress, in English whatever the lang',
    async () => {
      const scenarioCase = inlineCase({
        service: {
          behaviour: 'steps',
          params: { steps: [{ sleep: 300 }, { thread: {} }, { sleep: 300 }] },
        },
        script: [{ times: 2, reply: { text: 'Hello.' } }],
      });
      const responses = await withService(scenarioCase, server(), async (driver) => {
        const sent = ['one', 'two'].map(
          (caseId) => driver.generate(generateParams(scenarioCase, { caseId, lang: 'ko' })).done,
        );
        return Promise.all(sent);
      });
      expect(
        responses.map((response) => (response.kind === 'error' ? response.error.message : null)),
      ).toEqual([message('A10'), message('A10')]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-020 L1 equals its sentence',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'messages-l1-'));
      try {
        const service = repository(path.join(root, 'service'), { 'secret.txt': 'secret\n' });
        chmodSync(path.join(service, 'secret.txt'), 0);
        const reported = await reportVersion({ language: 'typescript', serviceDir: service });
        chmodSync(path.join(service, 'secret.txt'), 0o644);
        expect(reported.warnings).toEqual([message('L1', { reason: 'read secret.txt: EACCES' })]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
