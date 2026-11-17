import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { JsonObject } from '../../../src/adapter/json-value.js';
import { CLI, type CliResult } from '../../e2e/support/cli.js';
import { parseLintEnvelope } from '../../e2e/support/outputs.js';
import { apiEnv, PYTHON_SERVICES, requirePythonSdk } from './support/driver.js';
import { MockApi, PYTHON_DIR, pythonInterpreter, ROOT } from './support/mock-api.js';

// The tool's side of render mode with the Python helper (spec User Story 2 acceptance scenarios
// 2, 4 and 5, User Story 1 acceptance scenario 8): `lint --render` checks anchors against the
// request the helper rendered and reports A11 as `render-failed`, and a run whose render fails
// stops at its start. The scenario service runs as the adapter, against the mock API server.

const TIMEOUT_MS = 60_000;
const ANCHOR = 'Never use emoji';
const CLASSIFY_SYSTEM = 'Classify the request: answer or refuse.';
const ANSWER_SYSTEM = `Answer the user. ${ANCHOR}.`;

const messagesSchema = z.object({ messages: z.record(z.string(), z.object({ text: z.string() })) });
const A11 = messagesSchema.parse(
  JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/helper/messages.json'), 'utf8')),
).messages.A11?.text;

const RULES = {
  rules: [
    {
      id: 'no-emoji',
      title: 'No emoji',
      severity: 'major',
      scope: 'global',
      check: { type: 'emoji' },
      anchors: [{ lang: 'en', quote: ANCHOR }],
    },
  ],
};
const CASES = {
  cases: [
    { id: 'greet-en', target: 'chat', lang: 'en', provenance: 'synthetic', input: { user: 'hi' } },
  ],
};

/** The classification before the answer of S-ANS-25, the answer system holding the anchor. */
const CLASSIFY_THEN_ANSWER = {
  behaviour: 'flow',
  params: {
    steps: [
      { call: { system: CLASSIFY_SYSTEM, maxTokens: 16, onError: 'swallow' } },
      { call: { name: 'answer', system: ANSWER_SYSTEM, maxTokens: 64 } },
    ],
    result: { callText: 'answer' },
  },
};

let mock: MockApi | undefined;
const folders: string[] = [];

beforeAll(async () => {
  requirePythonSdk('openai');
  mock = await MockApi.start();
});

afterAll(async () => {
  await mock?.stop();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

function server(): MockApi {
  if (mock === undefined) {
    throw new Error('the mock API server did not start');
  }
  return mock;
}

/** A project whose adapter is the Python scenario service with this behaviour and target. */
async function project(service: JsonObject, target: JsonObject): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'render-lint-'));
  folders.push(root);
  const scenario = {
    scenario: 'S-RV-00',
    service,
    target: { render: true, languages: ['en'], ...target },
    adapter: {},
    api: 'chat-completions',
    backend: 'async',
  };
  const config = {
    version: 1,
    adapter: {
      command: [pythonInterpreter(), path.join(PYTHON_SERVICES, 'scenario.py')],
      cwd: '.',
      env: {
        MODEL_EVAL_SCENARIO: JSON.stringify(scenario),
        PYTHONPATH: [PYTHON_DIR, PYTHON_SERVICES].join(path.delimiter),
      },
      timeoutMs: 30_000,
    },
    files: { rules: 'rules/*.yaml', cases: 'cases/*.yaml' },
    variants: [
      { id: 'current', model: 'model-a' },
      { id: 'next', model: 'model-b' },
    ],
    pricing: {
      'model-a': { input: 0.1, output: 0.5 },
      'model-b': { input: 0.2, output: 1.2 },
      'model-x': { input: 0.1, output: 0.5 },
    },
  };
  // YAML reads JSON text as it is.
  await mkdir(path.join(root, 'rules'));
  await mkdir(path.join(root, 'cases'));
  await writeFile(path.join(root, 'model-eval.config.yaml'), JSON.stringify(config, null, 2));
  await writeFile(path.join(root, 'rules/rules.yaml'), JSON.stringify(RULES, null, 2));
  await writeFile(path.join(root, 'cases/cases.yaml'), JSON.stringify(CASES, null, 2));
  return root;
}

/** Runs the built CLI in the project with the mock server's base URLs and dummy keys. */
function cli(root: string, args: readonly string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...apiEnv(server().url), NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env, stdio: 'pipe' });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/** `lint --render --json` in the project; the mock server must receive no request. */
async function lintRender(root: string): Promise<ReturnType<typeof parseLintEnvelope>> {
  await server().reset();
  const result = await cli(root, ['lint', '--render', '--json']);
  expect(await server().log(), 'requests during lint --render').toEqual([]);
  try {
    return parseLintEnvelope(result.stdout);
  } catch (error) {
    throw new Error(`lint --render exited ${String(result.code)}:\n${result.stderr}`, {
      cause: error,
    });
  }
}

describe('003 lint --render with the Python helper (helper-api §Render Mode)', () => {
  it(
    '003 FR-021 S-ANS-25 without reply_call lint checks anchors against the classification request: anchor-missing',
    async () => {
      const envelope = await lintRender(await project(CLASSIFY_THEN_ANSWER, {}));
      expect(envelope.exit.code).toBe(0);
      expect(envelope.result?.errors).toEqual([]);
      expect(envelope.warnings).toEqual([
        expect.objectContaining({ code: 'anchor-missing', ruleId: 'no-emoji', lang: 'en' }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-ANS-25 with reply_call selecting the answer call lint finds the anchor in the answer request',
    async () => {
      const replyCall = { replyCall: { not: { systemIncludes: 'Classify' } } };
      const envelope = await lintRender(await project(CLASSIFY_THEN_ANSWER, replyCall));
      expect(envelope.exit.code).toBe(0);
      expect(envelope.result?.errors).toEqual([]);
      expect(envelope.warnings).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 S-RV-03 a case on a path that calls no model: lint reports render-failed with A11',
    async () => {
      const noModel = { behaviour: 'flow', params: { steps: [], result: { text: 'Hello.' } } };
      const envelope = await lintRender(await project(noModel, {}));
      expect(envelope.exit.code).toBe(1);
      expect(envelope.result?.errors).toEqual([
        expect.objectContaining({
          code: 'render-failed',
          params: { detail: A11 },
          caseIds: ['greet-en'],
          variants: ['current', 'next'],
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-021 every request to another model (User Story 1 acceptance scenario 8): lint reports render-failed and a run stops at its start',
    async () => {
      const otherModel = {
        behaviour: 'flow',
        params: {
          steps: [{ call: { model: 'model-x', system: ANSWER_SYSTEM, onError: 'swallow' } }],
          result: { text: 'Hello.' },
        },
      };
      const root = await project(otherModel, {});
      const envelope = await lintRender(root);
      expect(envelope.exit.code).toBe(1);
      expect(envelope.result?.errors).toEqual([
        expect.objectContaining({ code: 'render-failed', params: { detail: A11 } }),
      ]);
      await server().reset();
      const run = await cli(root, ['run', '--variant', 'next']);
      expect(run.code, run.stderr).toBe(4);
      expect(await server().log(), 'requests of a run that stopped at its start').toEqual([]);
    },
    TIMEOUT_MS,
  );
});
