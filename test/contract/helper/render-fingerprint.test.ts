import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isJsonArray, isJsonObject, type JsonValue } from '../../../src/adapter/json-value.js';
import { type RenderResult, renderResultSchema } from '../../../src/adapter/protocol.js';
import { renderFingerprint } from '../../../src/run/hashes.js';
import type { RpcResponse } from './support/driver.js';
import { MockApi } from './support/mock-api.js';
import {
  APIS,
  type CaseData,
  caseTitle,
  readScenarios,
  runCase,
  type ScenarioCase,
} from './support/scenarios.js';

// The Python helper's render and generate fingerprints are the ones the tool computes itself
// (renderFingerprint of src/run/hashes.ts), so a run compares them byte for byte (FR-021, FR-022).

const TIMEOUT_MS = 60_000;

/** The Python cases of a fixture file, for every API they apply to. */
function pythonCases(fileName: string): ScenarioCase[] {
  return Object.entries(readScenarios(fileName)).flatMap(([scenario, cases]) =>
    cases
      .filter((data) => data.languages?.includes('python') ?? true)
      .flatMap((data) =>
        (data.apis ?? APIS).map((api) => ({
          scenario,
          name: data.name,
          data,
          api,
          language: 'python' as const,
        })),
      ),
  );
}

function expected(data: CaseData, name: string): JsonValue | undefined {
  return data.expect?.[name];
}

/** The cases whose `render` request ends in a render result. */
const renderCases = pythonCases('render.json').filter(
  ({ data }) => data.request === 'render' && expected(data, 'status') === 'ok',
);
/** S-ANS-04: the generate fingerprint is expected to equal the render fingerprint. */
const regenerationCases = pythonCases('fingerprint.json').filter(
  ({ scenario, data }) => scenario === 'S-ANS-04' && expected(data, 'fingerprint') === 'render',
);

function renderTools(data: CaseData): JsonValue | undefined {
  const render = expected(data, 'render');
  return isJsonObject(render) ? render.tools : undefined;
}

let mock: MockApi | undefined;

beforeAll(async () => {
  mock = await MockApi.start();
});

afterAll(async () => {
  await mock?.stop();
});

function server(): MockApi {
  if (mock === undefined) {
    throw new Error('the mock API server did not start');
  }
  return mock;
}

function resultOf(response: RpcResponse<JsonValue>, what: string): JsonValue {
  if (response.kind === 'error') {
    throw new Error(`${what} ended in an adapter error: ${response.error.message}`);
  }
  return response.result;
}

/** The case's render result, from a `render` request. */
async function renderOf(scenarioCase: ScenarioCase): Promise<RenderResult> {
  const data: CaseData = { ...scenarioCase.data, request: 'render', expect: { status: 'ok' } };
  const outcome = await runCase({ ...scenarioCase, data }, server());
  return renderResultSchema.parse(resultOf(outcome.response, 'render'));
}

/** What the tool hashes when the adapter gives no fingerprint: `messages` and `tools`. */
function withoutFingerprint(render: RenderResult): RenderResult {
  return {
    messages: render.messages,
    ...(render.tools === undefined ? {} : { tools: render.tools }),
  };
}

describe('003 render fingerprints of the Python helper (helper-api §Render Mode)', () => {
  it('003 FR-021 the render cases include renders with tools and without them', () => {
    const tools = renderCases.map(({ data }) => renderTools(data));
    expect(tools.some((value) => isJsonArray(value))).toBe(true);
    expect(tools.some((value) => value === undefined || value === null)).toBe(true);
  });

  it.each(renderCases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const))(
    '003 FR-021 %s: the render fingerprint equals renderFingerprint of its messages and tools',
    async (_title, scenarioCase) => {
      const render = await renderOf(scenarioCase);
      expect(render.fingerprint).toBeDefined();
      expect(render.fingerprint).toBe(renderFingerprint(withoutFingerprint(render)));
    },
    TIMEOUT_MS,
  );

  it.each(
    regenerationCases.map((scenarioCase) => [caseTitle(scenarioCase), scenarioCase] as const),
  )(
    '003 FR-022 %s: the generate fingerprint equals renderFingerprint of the render',
    async (_title, scenarioCase) => {
      const render = await renderOf(scenarioCase);
      const outcome = await runCase(scenarioCase, server());
      const result = resultOf(outcome.response, 'generate');
      const fingerprint = isJsonObject(result) ? result.fingerprint : undefined;
      expect(fingerprint).toBe(renderFingerprint(withoutFingerprint(render)));
    },
    TIMEOUT_MS,
  );
});
