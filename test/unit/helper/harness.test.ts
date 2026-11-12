import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdapterDriver,
  apiEnv,
  ProtocolViolation,
  requireLoopback,
  requirePythonSdk,
} from '../../contract/helper/support/driver.js';
import type { ReceivedRequest } from '../../contract/helper/support/mock-api.js';
import { isJsonObject, type JsonValue } from '../../../src/adapter/json-value.js';
import {
  type CaseData,
  checkExpect,
  expectationOf,
  type MockControl,
  type Outcome,
  runCase,
  type ScenarioCase,
} from '../../contract/helper/support/scenarios.js';

// The safeguards of the helper contract harness, which no later test takes the failure path of.

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'helper-harness-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});

describe('helper contract harness', () => {
  it('003 SC-002 an adapter gets the mock base URLs, dummy keys, no proxy and no real token', () => {
    const parent = {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy.invalid:3128',
      https_proxy: 'http://proxy.invalid:3128',
      ALL_PROXY: 'socks5://proxy.invalid:1080',
      NO_PROXY: 'internal.invalid',
      ANTHROPIC_AUTH_TOKEN: 'real-token',
      OPENAI_ORG_ID: 'org-real',
      OPENAI_PROJECT_ID: 'proj-real',
      OPENAI_API_KEY: 'real-key',
      ANTHROPIC_API_KEY: 'real-key',
      OPENAI_BASE_URL: 'https://api.example.invalid/v1',
      UNSET: undefined,
    };
    expect(apiEnv('http://127.0.0.1:9', parent)).toEqual({
      PATH: '/usr/bin',
      NO_PROXY: '*',
      no_proxy: '*',
      OPENAI_API_KEY: 'test-openai-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
  });

  it.each([
    'http://0.0.0.0:9',
    'https://api.example.invalid',
    'http://127.0.0.1.example.invalid/v1',
    'http://10.0.0.1:9',
    'http://[::2]:9',
    '',
  ])('003 SC-002 refuses the base URL %j, which leaves the machine', (url) => {
    expect(() => {
      requireLoopback({ ...apiEnv('http://127.0.0.1:9', {}), ANTHROPIC_BASE_URL: url });
    }).toThrow(/ANTHROPIC_BASE_URL must be a loopback address/);
  });

  it.each(['http://127.0.0.1:9', 'http://127.5.6.7:9', 'http://[::1]:9', 'http://localhost:9'])(
    '003 SC-002 accepts the loopback base URL %s',
    (url) => {
      expect(() => {
        requireLoopback(apiEnv(url, {}));
      }).not.toThrow();
    },
  );

  it('003 SC-002 starts no adapter whose base URL leaves the machine', async () => {
    const service = path.join(folder, 'service.mjs');
    const marker = path.join(folder, 'started');
    await writeFile(
      service,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`,
    );
    const env = {
      ...apiEnv('http://127.0.0.1:9', {}),
      OPENAI_BASE_URL: 'https://api.example.invalid',
    };
    expect(() =>
      AdapterDriver.start({ language: 'typescript', service, sdk: 'openai-7', env }),
    ).toThrow(/OPENAI_BASE_URL must be a loopback address/);
    await expect(access(marker)).rejects.toThrow();
  });

  it('003 SC-002 a non-JSON stdout line raises a protocol violation', async () => {
    const service = path.join(folder, 'noisy.mjs');
    await writeFile(
      service,
      [
        "import { createInterface } from 'node:readline';",
        'const lines = createInterface({ input: process.stdin });',
        "lines.once('line', (line) => {",
        '  const { id } = JSON.parse(line);',
        "  process.stdout.write('not a protocol message\\n');",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: null }) + '\\n');",
        '});',
      ].join('\n'),
    );
    const driver = AdapterDriver.start({
      language: 'typescript',
      service,
      sdk: 'openai-7',
      env: apiEnv('http://127.0.0.1:9', { PATH: process.env.PATH }),
    });
    await expect(driver.shutdown()).rejects.toThrow(ProtocolViolation);
    await expect(driver.close()).rejects.toThrow(/not a protocol message/);
  });

  it('003 SC-002 an adapter that exits at import fails its requests at once with its stderr', async () => {
    const service = path.join(folder, 'crashing-service.mjs');
    await writeFile(service, "throw new Error('the helper API is missing');\n");
    const driver = AdapterDriver.start({
      language: 'typescript',
      service,
      sdk: 'openai-7',
      env: apiEnv('http://127.0.0.1:9', { PATH: process.env.PATH }),
    });
    const started = Date.now();
    const failure = /the adapter exited with 1:[\s\S]*the helper API is missing/;
    await expect(driver.initialize({})).rejects.toThrow(failure);
    await expect(driver.initialize({})).rejects.toThrow(failure);
    expect(Date.now() - started).toBeLessThan(5000);
    await driver.close();
  });

  it('003 SC-002 a response written just before the adapter exits is delivered', async () => {
    const service = path.join(folder, 'answer-then-exit.mjs');
    await writeFile(
      service,
      [
        "import { createInterface } from 'node:readline';",
        'const lines = createInterface({ input: process.stdin });',
        "lines.once('line', (line) => {",
        '  const { id } = JSON.parse(line);',
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: null }) + '\\n');",
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    const driver = AdapterDriver.start({
      language: 'typescript',
      service,
      sdk: 'openai-7',
      env: apiEnv('http://127.0.0.1:9', { PATH: process.env.PATH }),
    });
    await expect(driver.shutdown()).resolves.toBeUndefined();
    await driver.close();
  });

  it('003 SC-002 a missing Python SDK fails with the way to build the environment', async () => {
    const python = path.join(folder, 'python-without-sdks');
    await writeFile(python, '#!/bin/sh\nexit 0\n');
    await chmod(python, 0o755);
    vi.stubEnv('MODEL_EVAL_PYTHON', python);
    expect(() => {
      requirePythonSdk('anthropic');
    }).toThrow(
      `The Python at MODEL_EVAL_PYTHON (${python}) has no anthropic SDK. Point MODEL_EVAL_PYTHON at the interpreter of an environment built from one file of adapters/python/tests/requirements/, for example: uv venv adapters/python/.venv && uv pip install --python adapters/python/.venv/bin/python -r adapters/python/tests/requirements/anthropic-2.txt`,
    );
  });

  it('003 SC-002 an installed Python SDK passes the check', async () => {
    const python = path.join(folder, 'python-with-sdks');
    await writeFile(python, '#!/bin/sh\necho 1.17.0\n');
    await chmod(python, 0o755);
    vi.stubEnv('MODEL_EVAL_PYTHON', python);
    expect(() => {
      requirePythonSdk('openai');
    }).not.toThrow();
  });

  describe('trials', () => {
    // The stand-in of adapters/python/tests/services/harness_trials.py. With `params.trials` N it
    // holds every generate until N arrived, so a harness that awaited one response before sending
    // the next request would get raw "alone" instead of "together". Without it, each generate is
    // answered after `params.delayMs` with raw "answered-before-<k>", k being the responses sent
    // before it arrived: 0, 1, 2 for requests sent one after another, all 0 for requests at once.
    // With `params.requestAfterMs` it POSTs to the mock server that long after answering, and
    // `shutdown` exits at once, so that request is lost unless the harness waits for it.
    const heldService = [
      "import { createInterface } from 'node:readline';",
      'const { params } = JSON.parse(process.env.MODEL_EVAL_SCENARIO).service;',
      'const held = [];',
      'let answered = 0;',
      'const send = (id, result) =>',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      'const answer = ({ id, params: { caseId } }, raw) => {',
      '  answered += 1;',
      "  send(id, { raw: params.raw?.[caseId] ?? raw, finalKind: 'model', final: caseId,",
      "    latencyMs: 1, finishReason: 'stop' });",
      '  if (params.requestAfterMs !== undefined) {',
      '    setTimeout(() => {',
      "      void fetch(`${process.env.MODEL_EVAL_MOCK_URL}/v1/background`, { method: 'POST', body: '{}' });",
      '    }, params.requestAfterMs);',
      '  }',
      '};',
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      '  const message = JSON.parse(line);',
      "  if (message.method === 'initialize') {",
      "    send(message.id, { protocolVersion: '1', adapter: { name: 'held', version: '0.0.1' },",
      "      targets: [{ name: 'chat', inputSchema: true }] });",
      "  } else if (message.method === 'generate' && params.trials === undefined) {",
      '    const before = answered;',
      '    setTimeout(() => answer(message, `answered-before-${before}`), params.delayMs ?? 0);',
      "  } else if (message.method === 'generate') {",
      '    held.push(message);',
      '    setTimeout(() => {',
      '      const index = held.indexOf(message);',
      "      if (index >= 0) answer(held.splice(index, 1)[0], 'alone');",
      '    }, 3000);',
      '    if (held.length >= params.trials) {',
      "      for (const request of held.splice(0)) answer(request, 'together');",
      '    }',
      "  } else if (message.method === 'shutdown') {",
      '    send(message.id, null);',
      '    process.exit(0);',
      '  }',
      '});',
    ].join('\n');
    const mock: MockControl = {
      url: 'http://127.0.0.1:9',
      load: () => Promise.resolve(),
      log: () => Promise.resolve([]),
      tlsUrl: () => Promise.resolve('https://127.0.0.1:9'),
    };

    function stubCase(data: CaseData): ScenarioCase {
      return {
        scenario: 'S-RESP-10',
        name: data.name,
        data,
        api: 'chat-completions',
        language: 'typescript',
        sdk: 'openai-7',
      };
    }

    function trialsCase(raw: Record<string, string> = {}): ScenarioCase {
      return stubCase({
        name: 'three trials at once',
        service: { behaviour: 'harness-trials', params: { trials: 3, raw } },
        trials: 3,
        expect: { status: 'ok', raw: 'together' },
      });
    }

    function inARowCase(...raws: string[]): ScenarioCase {
      return stubCase({
        name: 'three trials in a row',
        service: { behaviour: 'harness-trials', params: { delayMs: 200 } },
        trialsInARow: 3,
        expectPerTrial: raws.map((raw) => ({ status: 'ok', raw })),
      });
    }

    async function heldServicePath(): Promise<string> {
      const service = path.join(folder, 'held-service.mjs');
      await writeFile(service, heldService);
      return service;
    }

    function finals(outcome: Outcome): (JsonValue | undefined)[] {
      return outcome.responses.map((response) =>
        response.kind === 'result' && isJsonObject(response.sent) ? response.sent.final : undefined,
      );
    }

    it('003 SC-002 trials are all sent before any response is awaited', async () => {
      const scenarioCase = trialsCase();
      const outcome = await runCase(scenarioCase, mock, await heldServicePath());
      expect(finals(outcome)).toEqual(['case-1', 'case-2', 'case-3']);
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
    });

    it('003 SC-002 every trial is held to expect and one mismatch fails the case', async () => {
      const scenarioCase = trialsCase({ 'case-2': 'different' });
      const outcome = await runCase(scenarioCase, mock, await heldServicePath());
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([
        'trial 2: raw: expected "together", got "different"',
      ]);
    });

    it('003 SC-002 trials in a row are sent one after another', async () => {
      const scenarioCase = inARowCase(
        'answered-before-0',
        'answered-before-1',
        'answered-before-2',
      );
      const outcome = await runCase(scenarioCase, mock, await heldServicePath());
      expect(finals(outcome)).toEqual(['case-1', 'case-2', 'case-3']);
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([]);
    });

    describe('shutdownAfterRequests', () => {
      let server: Server | undefined;
      const received: ReceivedRequest[] = [];

      afterEach(async () => {
        received.length = 0;
        await new Promise((resolve) => server?.close(resolve));
      });

      async function recordingMock(): Promise<MockControl> {
        server = createServer((request, response) => {
          received.push({
            method: request.method ?? '',
            path: request.url ?? '',
            api: null,
            model: null,
            stream: false,
            headers: {},
            scripted: false,
            servedEncoding: null,
          });
          request.resume();
          response.end('{}');
        });
        await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        return {
          ...mock,
          url: `http://127.0.0.1:${String(port)}`,
          log: () => Promise.resolve([...received]),
        };
      }

      function backgroundCase(wait: number | undefined): ScenarioCase {
        return stubCase({
          name: 'a request 300 ms after the result',
          service: { behaviour: 'harness-trials', params: { requestAfterMs: 300 } },
          ...(wait === undefined ? {} : { shutdownAfterRequests: wait }),
          expect: { status: 'ok' },
        });
      }

      it('003 SC-002 shutdown waits for the requests the case names', async () => {
        const outcome = await runCase(
          backgroundCase(1),
          await recordingMock(),
          await heldServicePath(),
        );
        expect(outcome.requests.map((request) => request.path)).toEqual(['/v1/background']);
      });

      it('003 SC-002 without the wait, shutdown comes before late background requests', async () => {
        const outcome = await runCase(
          backgroundCase(undefined),
          await recordingMock(),
          await heldServicePath(),
        );
        expect(outcome.requests).toEqual([]);
      });
    });

    it('003 SC-002 a null in expected requests is the JSON null', () => {
      const request: ReceivedRequest = {
        method: 'POST',
        path: '/v1/chat/completions',
        api: 'chat-completions',
        model: null,
        stream: false,
        headers: {},
        scripted: true,
        servedEncoding: 'identity',
      };
      const outcomeOf = (model: string | null): Outcome => {
        const response = { kind: 'result' as const, result: {}, sent: {} };
        return {
          response,
          responses: [response],
          exchange: { calls: [], logs: [], stderr: [], violations: [] },
          requests: [{ ...request, model }],
          renderFingerprint: undefined,
        };
      };
      const expected = { requests: [{ model: null }] };
      expect(checkExpect(expected, outcomeOf(null))).toEqual([]);
      expect(checkExpect(expected, outcomeOf('model-b'))).toEqual([
        'requests[0].model: expected null, got "model-b"',
      ]);
    });

    it('003 SC-002 a wrong first trial fails a case with one expect per trial', async () => {
      const scenarioCase = inARowCase(
        'answered-before-5',
        'answered-before-1',
        'answered-before-2',
      );
      const outcome = await runCase(scenarioCase, mock, await heldServicePath());
      expect(checkExpect(expectationOf(scenarioCase.data), outcome)).toEqual([
        'trial 1: raw: expected "answered-before-5", got "answered-before-0"',
      ]);
    });
  });
});
