import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalJson } from '../../../src/adapter/canonical-json.js';
import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../../../src/adapter/json-value.js';
import { type RenderResult, renderResultSchema } from '../../../src/adapter/protocol.js';
import { renderFingerprint } from '../../../src/run/hashes.js';
import { AdapterDriver, apiEnv, type RpcResponse } from './support/driver.js';
import { ROOT } from './support/mock-api.js';
import { commit, git, reportVersion, repository, write } from './support/repositories.js';
import {
  type Api,
  APIS,
  type CaseData,
  readScenarios,
  runCase,
  type ScenarioCase,
} from './support/scenarios.js';
import { asObject, nodeCasesOf, sdkFor, TIMEOUT_MS, useMockApi } from './support/service-runs.js';

// Two-language parity (helper-scenarios §Two-Language Parity; spec FR-024, SC-003; User Story 3
// acceptance scenario 5): the same trials through the Python helper (services/parity.py and the
// Python scenario service) and the TypeScript helper (services/parity.mjs and the Node scenario
// service) give the same raw answers, shipped texts, fingerprints, `treeHash`, discard reasons
// and `retryAfterMs`, byte for byte, and those equal the vectors of
// test/fixtures/helper/parity/values.json. Both helpers' render fingerprints equal what the tool
// computes itself (renderFingerprint of src/run/hashes.ts) on `{messages, tools}`.

const server = useMockApi();
const API: Api = 'chat-completions';
const VALUES_FILE = path.join(ROOT, 'test/fixtures/helper/parity/values.json');

const valuesSchema = z.object({
  whitespace: z.array(z.object({ name: z.string(), text: z.string(), empty: z.boolean() })),
  canonicalJson: z.array(z.object({ name: z.string(), text: z.string(), canonical: z.string() })),
  notJson: z.array(z.object({ name: z.string(), text: z.string() })),
  discardReason: z.array(
    z.object({
      name: z.string(),
      exceptionName: z.string(),
      message: z.string(),
      discardReason: z.string(),
    }),
  ),
  retryAfter: z.object({
    nowMs: z.number(),
    cases: z.array(
      z.object({
        name: z.string(),
        headers: z.record(z.string(), z.string()),
        retryAfterMs: z.number().nullable(),
        nowMs: z.number().optional(),
      }),
    ),
  }),
});
const VALUES = valuesSchema.parse(JSON.parse(readFileSync(VALUES_FILE, 'utf8')));

type Language = 'python' | 'typescript';
const LANGUAGES: readonly Language[] = ['python', 'typescript'];

/** One trial of a target of the parity drivers, and the response as the adapter sent it. */
async function parityTrial(
  language: Language,
  target: string,
  input: JsonObject,
  script: readonly JsonValue[],
): Promise<RpcResponse<JsonValue>> {
  const mock = server();
  await mock.load(script);
  const driver = AdapterDriver.start({
    language,
    service: 'parity',
    env: { ...apiEnv(mock.url), MODEL_EVAL_SCENARIO: JSON.stringify({ api: API }) },
    ...(language === 'python' ? { pythonSdk: 'openai' as const } : { sdk: sdkFor(API) }),
  });
  try {
    const initialized = await driver.initialize({
      protocolVersion: '1',
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: 30_000,
      toolPaths: [],
    });
    if (initialized.kind === 'error') {
      throw new Error(`initialize failed: ${initialized.error.message}`);
    }
    const params = { target, input, caseId: 'case-1', lang: 'en', repeat: 0, seed: 1 };
    const response = await driver.generate(params).done;
    await driver.shutdown();
    return response.kind === 'error'
      ? response
      : { kind: 'result', result: response.sent, sent: response.sent };
  } finally {
    await driver.close();
  }
}

/** The response without the times, which are the only values allowed to differ. */
function comparable(response: RpcResponse<JsonValue>): JsonValue {
  const holder: JsonValue =
    response.kind === 'error'
      ? { adapterError: response.error.message, data: response.error.data ?? null }
      : response.result;
  return withoutTimes(holder);
}

function withoutTimes(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map(withoutTimes);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'latencyMs')
        .map(([key, item]) => [key, withoutTimes(item)]),
    );
  }
  return value;
}

/** The values of spec FR-024 a response carries, each as the adapter wrote it. */
function fr024Values(response: RpcResponse<JsonValue>): JsonObject {
  const result = response.kind === 'result' && isJsonObject(response.result) ? response.result : {};
  const error = isJsonObject(result.error) ? result.error : {};
  const calls = isJsonArray(result.calls) ? result.calls : [];
  return {
    raw: result.raw ?? null,
    final: result.final ?? null,
    discardReason: result.discardReason ?? null,
    fingerprint: result.fingerprint ?? null,
    retryAfterMs: error.retryAfterMs ?? null,
    callRetryAfterMs: calls.map((call) =>
      isJsonObject(call) ? (call.retryAfterMs ?? null) : null,
    ),
  };
}

/** Runs the trial through both helpers and holds them to each other, byte for byte. */
async function bothHelpers(
  target: string,
  input: JsonObject,
  script: readonly JsonValue[],
): Promise<JsonObject> {
  const [python, typescript] = [
    await parityTrial('python', target, input, script),
    await parityTrial('typescript', target, input, script),
  ];
  const values = fr024Values(python);
  expect(fr024Values(typescript)).toStrictEqual(values);
  expect(canonicalJson(comparable(typescript))).toBe(canonicalJson(comparable(python)));
  return values;
}

/** Header values an HTTP response can carry: SP to U+00FF and HTAB, no line ends. */
function sendable(headers: Readonly<Record<string, string>>): boolean {
  return Object.values(headers).every((value) => /^[\t -~\u0080-ÿ]*$/u.test(value));
}

const RATE_LIMIT = { type: 'rate_limit_error', message: 'slow down' };
const SENDABLE_RETRY = VALUES.retryAfter.cases.filter((vector) => sendable(vector.headers));

// Fixture rows of §Two-Language Parity, each run through both scenario services.

/** Whether the case runs on an asynchronous backend, the only one both languages have. */
function runsAsync(data: CaseData): boolean {
  const backends = data.backends;
  return !Array.isArray(backends) || backends.includes('async');
}

/**
 * Whether both helpers run the case: a row held for one language only (`languages` naming just
 * `python` or `typescript`) has no counterpart to compare with.
 */
function runsInBothLanguages(data: CaseData): boolean {
  const languages = data.languages;
  return (
    languages === undefined || (languages.includes('python') && languages.includes('typescript'))
  );
}

/** The Python side of the cases both helpers run, one per API. */
function pythonCasesOf(scenario: string, cases: readonly CaseData[]): ScenarioCase[] {
  return cases
    .filter(runsInBothLanguages)
    .filter(runsAsync)
    .flatMap((data) =>
      (data.apis ?? APIS).map((api) => ({
        scenario,
        name: data.name,
        data,
        api,
        language: 'python' as const,
      })),
    );
}

const FIXTURE_ROWS: readonly [string, string][] = [
  ['capture.json', 'S-PAR-07'],
  ['reading.json', 'S-PAR-07'],
  ['records.json', 'S-PAR-08'],
  ['messages.json', 'S-PAR-08'],
  ['model_call_error.json', 'S-PAR-11'],
];

const FIXTURE_PAIRS = FIXTURE_ROWS.flatMap(([file, scenario]) =>
  pythonCasesOf(scenario, readScenarios(file)[scenario] ?? []).flatMap((pythonCase) => {
    const [nodeCase] = nodeCasesOf(scenario, [{ ...pythonCase.data, apis: [pythonCase.api] }]);
    return nodeCase === undefined
      ? []
      : [[`${scenario} ${pythonCase.name} [${pythonCase.api}]`, pythonCase, nodeCase] as const];
  }),
);

const RENDER_PAIRS = Object.entries(readScenarios('render.json'))
  .flatMap(([scenario, cases]) =>
    pythonCasesOf(
      scenario,
      cases.filter((data) => data.request === 'render' && data.expect?.status === 'ok'),
    ),
  )
  .flatMap((pythonCase) => {
    const [nodeCase] = nodeCasesOf(pythonCase.scenario, [
      { ...pythonCase.data, apis: [pythonCase.api] },
    ]);
    return nodeCase === undefined
      ? []
      : [
          [
            `${pythonCase.scenario} ${pythonCase.name} [${pythonCase.api}]`,
            pythonCase,
            nodeCase,
          ] as const,
        ];
  });

const REGENERATION_PAIRS = pythonCasesOf(
  'S-ANS-04',
  (readScenarios('fingerprint.json')['S-ANS-04'] ?? []).filter(
    (data) => data.expect?.fingerprint === 'render',
  ),
).flatMap((pythonCase) => {
  const [nodeCase] = nodeCasesOf('S-ANS-04', [{ ...pythonCase.data, apis: [pythonCase.api] }]);
  return nodeCase === undefined
    ? []
    : [[`S-ANS-04 ${pythonCase.name} [${pythonCase.api}]`, pythonCase, nodeCase] as const];
});

function renderOf(response: RpcResponse<JsonValue>): RenderResult {
  if (response.kind === 'error') {
    throw new Error(`the render ended in an adapter error: ${response.error.message}`);
  }
  return renderResultSchema.parse(response.result);
}

/** What the tool hashes when the adapter gives no fingerprint: `messages` and `tools`. */
function withoutFingerprint(render: RenderResult): RenderResult {
  return {
    messages: render.messages,
    ...(render.tools === undefined ? {} : { tools: render.tools }),
  };
}

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function temporary(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'parity-version-'));
  folders.push(folder);
  return folder;
}

/** Both helpers' `service` for the folder, which must be equal and complete. */
async function bothVersions(
  serviceDir: string,
  toolPaths: readonly string[] = [],
): Promise<JsonObject> {
  const [python, typescript] = await Promise.all(
    LANGUAGES.map((language) => reportVersion({ language, serviceDir, toolPaths })),
  );
  expect(typescript).toStrictEqual(python);
  expect(Object.keys(python?.service ?? {}).sort()).toEqual(['dirty', 'treeHash', 'version']);
  return asObject(JSON.parse(JSON.stringify(python?.service ?? {})) as JsonValue);
}

describe('003 two-language parity of the helpers (helper-scenarios §Two-Language Parity)', () => {
  it.each(VALUES.whitespace.map((vector) => [vector.name, vector] as const))(
    '003 FR-024 SC-003 S-PAR-01 raw and shipped text: %s',
    async (_name, vector) => {
      const values = await bothHelpers('reply', {}, [{ reply: { text: vector.text } }]);
      expect(values.raw).toBe(vector.text);
      expect(values.final).toBe(vector.text);
    },
    TIMEOUT_MS,
  );

  it.each(VALUES.discardReason.map((vector) => [vector.name, vector] as const))(
    '003 FR-024 SC-003 S-PAR-02 discardReason: %s',
    async (_name, vector) => {
      const input = { exceptionName: vector.exceptionName, message: vector.message };
      const values = await bothHelpers('discard', input, [{ reply: { text: 'Hello.' } }]);
      expect(values.discardReason).toBe(vector.discardReason);
    },
    TIMEOUT_MS,
  );

  it.each(VALUES.canonicalJson.map((vector) => [vector.name, vector] as const))(
    '003 FR-024 SC-003 S-PAR-03 S-PAR-04 S-PAR-05 answerTool arguments read as canonical JSON: %s',
    async (_name, vector) => {
      const toolCalls = [{ name: 'reply', arguments: `{"text": ${vector.text}}` }];
      const values = await bothHelpers('answer-tool', {}, [{ reply: { toolCalls } }]);
      // A string value is the text itself; any other value its canonical JSON (data-model §Answer).
      const expected = vector.canonical.startsWith('"')
        ? z.string().parse(JSON.parse(vector.canonical))
        : vector.canonical;
      expect(values.raw).toBe(expected);
    },
    TIMEOUT_MS,
  );

  it.each(VALUES.notJson.map((vector) => [vector.name, vector] as const))(
    '003 FR-024 SC-003 S-PAR-06 answerTool arguments that are not JSON give an empty raw answer: %s',
    async (_name, vector) => {
      const toolCalls = [{ name: 'reply', arguments: vector.text }];
      const values = await bothHelpers('answer-tool', {}, [{ reply: { toolCalls } }]);
      expect(values.raw).toBe('');
    },
    TIMEOUT_MS,
  );

  it.each(SENDABLE_RETRY.map((vector) => [vector.name, vector] as const))(
    '003 FR-024 SC-003 S-PAR-09 S-PAR-10 S-PAR-12 retryAfterMs: %s',
    async (_name, vector) => {
      const input = { nowMs: vector.nowMs ?? VALUES.retryAfter.nowMs };
      const script = [{ status: 429, headers: vector.headers, error: RATE_LIMIT }];
      const values = await bothHelpers('retry', input, script);
      expect(values.retryAfterMs).toBe(vector.retryAfterMs);
      expect(values.callRetryAfterMs).toEqual([vector.retryAfterMs]);
    },
    TIMEOUT_MS,
  );

  it.each([
    ['-1 is not recorded', -1, null],
    ['NaN is not recorded', 'nan', null],
    ['1500 is recorded', 1500, 1500],
  ] as const)(
    '003 FR-024 SC-003 S-PAR-11 a ModelCallError retryAfterMs of %s',
    async (_name, retryAfter, expected) => {
      const values = await bothHelpers('throw-model-call-error', { retryAfter }, []);
      expect(values.retryAfterMs).toBe(expected);
    },
    TIMEOUT_MS,
  );

  it.each(FIXTURE_PAIRS)(
    '003 FR-024 SC-003 %s: the same result through both scenario services',
    async (_title, pythonCase, nodeCase) => {
      const python = await runCase(pythonCase, server());
      const typescript = await runCase(nodeCase, server());
      expect(fr024Values(typescript.response)).toStrictEqual(fr024Values(python.response));
      expect(canonicalJson(comparable(typescript.response))).toBe(
        canonicalJson(comparable(python.response)),
      );
    },
    TIMEOUT_MS,
  );

  it.each(RENDER_PAIRS)(
    '003 FR-022 FR-024 SC-003 %s: both render fingerprints equal renderFingerprint of messages and tools',
    async (_title, pythonCase, nodeCase) => {
      const python = renderOf((await runCase(pythonCase, server())).response);
      const typescript = renderOf((await runCase(nodeCase, server())).response);
      expect(typescript.fingerprint).toBe(python.fingerprint);
      expect(python.fingerprint).toBe(renderFingerprint(withoutFingerprint(python)));
      expect(withoutFingerprint(typescript)).toStrictEqual(withoutFingerprint(python));
    },
    TIMEOUT_MS,
  );

  it.each(REGENERATION_PAIRS)(
    '003 FR-022 FR-024 SC-003 %s: both generate fingerprints are the same',
    async (_title, pythonCase, nodeCase) => {
      const python = await runCase(pythonCase, server());
      const typescript = await runCase(nodeCase, server());
      expect(fr024Values(typescript.response).fingerprint).toBe(
        fr024Values(python.response).fingerprint,
      );
      expect(fr024Values(python.response).fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 FR-024 S-RV-08 S-PAR-13 both helpers report the same version, dirty and treeHash',
    async () => {
      const root = temporary();
      const origin = repository(path.join(root, 'origin'), { 'lib.py': 'VALUE = 1\n' });
      const service = repository(path.join(root, 'service'), {
        'app.py': "print('service')\n",
        'data/store.bin': Buffer.from([0x00, 0x01, 0xff, 0x0a]),
        '.gitignore': '*.log\n',
        'eval/rules/base.yaml': 'a\n',
      });
      symlinkSync('app.py', path.join(service, 'link'));
      git(service, 'submodule', 'add', '-q', origin, 'sub');
      commit(service, 'add link and submodule');
      repository(path.join(service, 'nested'), { 'notes.md': 'nested\n' });
      const toolPaths = [
        path.join(service, 'eval/rules/base.yaml'),
        path.join(service, 'eval/.model-eval'),
      ];

      const clean = await bothVersions(service, toolPaths);
      write(service, { 'eval/rules/base.yaml': 'b\n', 'debug.log': 'ignored\n' });
      expect(await bothVersions(service, toolPaths)).toStrictEqual(clean);

      write(service, { 'app.py': "print('edited')\n", 'extra.py': 'x = 1\n' });
      write(path.join(service, 'sub'), { 'lib.py': 'VALUE = 2\n' });
      const edited = await bothVersions(service, toolPaths);
      expect(edited.dirty).toBe(true);
      expect(edited.treeHash).not.toBe(clean.treeHash);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-003 FR-024 S-RV-13 file names with U+1F600 and U+FF01 give the same values',
    async () => {
      const service = repository(path.join(temporary(), 'service'), {
        '\u{1F600}.txt': 'grin\n',
        '！.txt': 'bang\n',
        'a.txt': 'a\n',
        '\u{1F600}/！.txt': 'nested names\n',
      });
      await bothVersions(service);
    },
    TIMEOUT_MS,
  );
});
