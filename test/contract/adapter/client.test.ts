import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  startAdapter,
  type AdapterClient,
  type StartOptions,
} from '../../../src/adapter/client.js';
import type { LogParams } from '../../../src/adapter/protocol.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK = fileURLToPath(new URL('../../../dist/adapter/mock.js', import.meta.url));

const CLEAN_EXIT = { exitCode: 0, signal: null, forced: false };

/** A throwaway adapter: `onLine` runs for each request `m`; `send`, `init` and `rl` are in scope. */
function scripted(onLine: string, setup = ''): readonly string[] {
  const script = [
    "const rl = require('node:readline').createInterface({ input: process.stdin });",
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    "const init = { protocolVersion: '1', adapter: { name: 'scripted', version: '0' }, targets: [{ name: 'chat', inputSchema: {} }] };",
    setup,
    `rl.on('line', (line) => { const m = JSON.parse(line); ${onLine} });`,
  ].join('\n');
  return [process.execPath, '-e', script];
}

const ANSWER_INIT = "if (m.method === 'initialize') send({ id: m.id, result: init });";
const ANSWER_SHUTDOWN =
  "if (m.method === 'shutdown') { send({ id: m.id, result: null }); rl.close(); }";

function scenario(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/mock/${name}.yaml`, import.meta.url));
}

function options(name: string, overrides: Partial<StartOptions> = {}): StartOptions {
  return {
    launch: { command: [process.execPath, MOCK, scenario(name)], cwd: ROOT, env: {} },
    initialize: {
      client: { name: 'model-eval', version: '0.0.0-test' },
      variant: { id: 'next', model: 'model-b' },
      timeoutMs: 10_000,
      toolPaths: [ROOT],
    },
    concurrency: 4,
    ...overrides,
  };
}

async function started(
  name: string,
  overrides: Partial<StartOptions> = {},
): Promise<AdapterClient> {
  const result = await startAdapter(options(name, overrides));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.client;
}

describe('adapter client against the mock adapter', () => {
  it('001 FR-007 initializes, renders, generates and shuts down over stdio', async () => {
    const client = await started('basic');
    expect(client.info.adapter).toEqual({ name: 'mock-chat', version: '0.1.0' });
    expect(client.info.capabilities).toMatchObject({
      render: true,
      stages: true,
      maxConcurrency: 4,
    });

    const render = await client.render({
      target: 'chat',
      lang: 'ja',
      input: { user: 'hi' },
      caseId: 'greet-ja',
      repeat: 0,
      seed: 7,
    });
    expect(render.kind).toBe('result');
    if (render.kind !== 'result') {
      return;
    }
    expect(render.value.messages[0]).toEqual({
      role: 'system',
      content: '日本語だけで話す。絵文字を使わない。',
    });
    expect(render.value.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const generate = await client.generate({
      target: 'chat',
      lang: 'ko',
      input: { user: 'hi' },
      caseId: 'greet-ko',
      repeat: 0,
      seed: 235035669,
    });
    expect(generate).toMatchObject({
      kind: 'result',
      value: {
        raw: '안녕! greet-ko 오늘 어땠어?',
        finalKind: 'model',
        finishReason: 'stop',
        answers: 1,
        modelSnapshot: 'model-b-2026-10-01',
      },
    });

    const exit = await client.shutdown();
    expect(exit).toEqual({ exitCode: 0, signal: null, forced: false });
  });

  it('001 FR-007 matches responses that arrive in any order by id', async () => {
    const client = await started('slow', { concurrency: 8 });
    const requests = Array.from({ length: 16 }, (_unused, index) => ({
      target: 'chat',
      input: {},
      caseId: `case-${String(index)}`,
      repeat: index % 3,
      seed: 1000 + index * 7919,
    }));
    const results = await Promise.all(requests.map((request) => client.generate(request)));
    results.forEach((result, index) => {
      const request = requests[index];
      expect(result).toMatchObject({
        kind: 'result',
        value: { raw: `${request?.caseId ?? ''}#${String(request?.repeat)}` },
      });
    });
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
  });

  it('001 FR-007 never has more requests in flight than the concurrency limit', async () => {
    const logs: LogParams[] = [];
    const client = await started('slow', { concurrency: 3, onLog: (params) => logs.push(params) });
    expect(client.concurrency).toBe(3);
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        client.generate({
          target: 'chat',
          input: {},
          caseId: `c${String(index)}`,
          repeat: 0,
          seed: index * 104729,
        }),
      ),
    );
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
    const inflight = logs.map((log) => Number(log.message.replace('inflight ', '')));
    expect(inflight).toHaveLength(12);
    expect(Math.max(...inflight)).toBe(3);
  });

  it('001 FR-007 lowers the limit to the adapter maxConcurrency', async () => {
    const client = await started('basic', { concurrency: 16 });
    expect(client.concurrency).toBe(4);
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
  });

  it('001 FR-007 reports a different major protocolVersion as a configuration error and shuts the adapter down', async () => {
    const stderr: string[] = [];
    const result = await startAdapter({
      ...options('protocol-v2'),
      onStderr: (line) => stderr.push(line),
    });
    expect(stderr).toContain('mock: shutdown');
    const pid = Number(/^mock: started pid=(\d+)$/.exec(stderr[0] ?? '')?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'version-mismatch',
        message: 'the adapter speaks protocol 2; this tool speaks 1',
      },
    });
  });

  it('001 FR-007 reports an adapter that cannot start as a configuration error', async () => {
    const result = await startAdapter({
      ...options('basic'),
      launch: { command: ['model-eval-no-such-adapter'], cwd: ROOT, env: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('spawn-failed');
    }
  });

  it('001 FR-007 reports an adapter that exits before initialize as a configuration error', async () => {
    const result = await startAdapter({
      ...options('basic'),
      launch: { command: [process.execPath, '-e', 'process.exit(3)'], cwd: ROOT, env: {} },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: 'exited' } });
  });

  it('001 FR-007 reports non-protocol stdout during start as a configuration error', async () => {
    const result = await startAdapter({
      ...options('basic'),
      launch: {
        command: [process.execPath, '-e', 'console.log("debug: starting")'],
        cwd: ROOT,
        env: {},
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'protocol-violation',
        message: expect.stringContaining('stdout is reserved for the protocol') as unknown,
      },
    });
  });

  it('001 FR-007 passes adapter.env to the adapter and runs it in adapter.cwd', async () => {
    const script = [
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "rl.on('line', (line) => { const m = JSON.parse(line);",
      "  const result = m.method === 'initialize'",
      "    ? { protocolVersion: '1', adapter: { name: process.env.MOCK_NAME, version: process.cwd() }, targets: [{ name: 'chat', inputSchema: {} }] }",
      '    : null;',
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');",
      "  if (m.method === 'shutdown') rl.close(); });",
    ].join('\n');
    const result = await startAdapter({
      ...options('basic'),
      launch: {
        command: [process.execPath, '-e', script],
        cwd: ROOT,
        env: { MOCK_NAME: 'from-env' },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.info.adapter.name).toBe('from-env');
      expect(result.client.info.adapter.version).toBe(ROOT.replace(/\/$/, ''));
      await result.client.shutdown();
    }
  });

  it('001 FR-007 turns failure results and JSON-RPC errors into typed outcomes', async () => {
    const client = await started('outcomes');
    const outcomes = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        client.generate({
          target: 'chat',
          lang: 'en',
          input: {},
          caseId: `c${String(index)}`,
          repeat: 0,
          seed: (index * 2654435761) % 2 ** 32,
        }),
      ),
    );
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
    const kinds = new Set(
      outcomes.map((outcome) => {
        if (outcome.kind !== 'result') {
          return outcome.kind;
        }
        return 'error' in outcome.value ? outcome.value.error.kind : outcome.value.finalKind;
      }),
    );
    expect(kinds).toEqual(
      new Set([
        'rpc-error',
        'config',
        'transient',
        'permanent',
        'timeout',
        'model',
        'discarded',
        'fallback',
      ]),
    );
  });

  it('001 FR-007 leaves params out of a request that has none', async () => {
    const received: string[] = [];
    const client = await started('basic', {
      launch: {
        command: scripted(`process.stderr.write(line + '\\n'); ${ANSWER_INIT} ${ANSWER_SHUTDOWN}`),
        cwd: ROOT,
        env: {},
      },
      onStderr: (line) => received.push(line),
    });
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
    const shutdown = received
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((m) => m.method === 'shutdown');
    expect(shutdown).toBeDefined();
    expect(shutdown).not.toHaveProperty('params');
  });

  it('001 FR-007 treats a response to a request it never sent as a protocol violation', async () => {
    const client = await started('basic', {
      launch: {
        command: scripted(
          `${ANSWER_INIT} if (m.method === 'generate') send({ id: m.id + 1000, result: null });`,
        ),
        cwd: ROOT,
        env: {},
      },
    });
    const outcome = await client.generate({
      target: 'chat',
      input: {},
      caseId: 'c',
      repeat: 0,
      seed: 1,
    });
    expect(outcome).toMatchObject({
      kind: 'lost',
      message: expect.stringContaining('did not send') as unknown,
    });
    await client.shutdown();
  });

  it('001 FR-007 reports an initialize that never answers as a configuration error', async () => {
    const base = options('basic');
    const result = await startAdapter({
      ...base,
      launch: { command: scripted(''), cwd: ROOT, env: {} },
      initialize: { ...base.initialize, timeoutMs: 200 },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'initialize-failed',
        message: expect.stringContaining('no response to initialize') as unknown,
      },
    });
  });

  it('001 FR-007 signals an adapter at once when shutdown gets no answer in time', async () => {
    const base = options('basic');
    const client = await started('basic', {
      launch: { command: scripted(ANSWER_INIT), cwd: ROOT, env: {} },
      initialize: { ...base.initialize, timeoutMs: 300 },
    });
    expect(await client.shutdown()).toEqual({ exitCode: null, signal: 'SIGTERM', forced: true });
  });

  it('001 FR-007 kills an adapter that ignores SIGTERM after the grace period', async () => {
    const client = await started('basic', {
      launch: {
        command: scripted(
          `${ANSWER_INIT} if (m.method === 'shutdown') send({ id: m.id, result: null });`,
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ),
        cwd: ROOT,
        env: {},
      },
      shutdownGraceMs: 100,
    });
    expect(await client.shutdown()).toEqual({ exitCode: null, signal: 'SIGKILL', forced: true });
  });

  it('001 FR-007 passes on the last stderr line even without a final newline', async () => {
    const received: string[] = [];
    const client = await started('basic', {
      launch: {
        command: scripted(
          `${ANSWER_INIT} if (m.method === 'shutdown') { process.stderr.write('last words'); send({ id: m.id, result: null }); rl.close(); }`,
        ),
        cwd: ROOT,
        env: {},
      },
      onStderr: (line) => received.push(line),
    });
    expect(await client.shutdown()).toEqual(CLEAN_EXIT);
    expect(received).toContain('last words');
  });
});
