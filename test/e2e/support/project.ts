import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { stringify } from 'yaml';
import type { z } from 'zod';

import { generateParamsSchema, initializeParamsSchema } from '../../../src/adapter/protocol.js';
import type { caseSchema, configSchema, ruleSchema } from '../../../src/config/schema.js';
import { MOCK_ADAPTER, runCli, type CliResult } from './cli.js';
import { scenarioFile } from './mock.js';

export type ConfigInput = z.input<typeof configSchema>;
export type RuleInput = z.input<typeof ruleSchema>;
export type CaseInput = z.input<typeof caseSchema>;

/** Everything of the config except the adapter, which always runs the mock behind a recorder. */
export type ConfigOverrides = Partial<Omit<ConfigInput, 'version' | 'adapter'>>;

export interface ProjectSpec {
  /** A scenario file of `test/fixtures/mock/`, without `.yaml`. */
  readonly scenario: string;
  readonly rules: readonly RuleInput[];
  readonly cases: readonly CaseInput[];
  readonly config?: ConfigOverrides;
  /** `adapter.timeoutMs`, for tests of an adapter that does not answer. */
  readonly adapterTimeoutMs?: number;
  /** Lets the mock tell a restarted process from the first one (`MOCK_STATE_DIR`). */
  readonly mockState?: boolean;
}

export interface RecordedRequest {
  readonly at: number;
  readonly method: string;
  readonly params: unknown;
}

/** The requests one adapter process received, with the variant it was initialised for. */
export interface AdapterSession {
  readonly variant: string | undefined;
  readonly requests: readonly RecordedRequest[];
}

export interface GenerateRequest {
  readonly variant: string | undefined;
  readonly at: number;
  readonly caseId: string;
  readonly repeat: number;
  readonly seed: number;
}

export interface Project {
  readonly root: string;
  readonly outputDir: string;
  run(args: readonly string[]): Promise<CliResult>;
  sessions(): Promise<AdapterSession[]>;
  generateRequests(): Promise<GenerateRequest[]>;
  dispose(): Promise<void>;
}

export const MODEL_A = 'model-a';
export const MODEL_B = 'model-b';

const VARIANTS: ConfigInput['variants'] = [
  { id: 'current', model: MODEL_A },
  { id: 'next', model: MODEL_B },
];

const PRICING: ConfigInput['pricing'] = {
  [MODEL_A]: { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 },
  [MODEL_B]: { input: 1, cachedInput: 0.1, cacheWrite: 1, output: 2 },
};

/**
 * Forwards stdin to the real adapter and appends every request line, with the time it arrived,
 * to `<log dir>/<pid>.jsonl`, so a test can see which requests reached the adapter without
 * relying on what the tool writes.
 */
const RECORDER = `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const [logDir, command, ...args] = process.argv.slice(2);
const log = path.join(logDir, String(process.pid) + '.jsonl');
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
createInterface({ input: process.stdin })
  .on('line', (line) => {
    appendFileSync(log, JSON.stringify({ at: Date.now(), line }) + '\\n');
    child.stdin.write(line + '\\n');
  })
  .on('close', () => child.stdin.end());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 1 : 128)));
`;

const RECORDER_FILE = 'record-adapter.mjs';
const REQUESTS_DIR = 'requests';

/** Cases `greet-<lang>-<n>`, numbered from 1, for a target whose input is `{user}`. */
export function greetCases(perLanguage: Readonly<Record<string, number>>): CaseInput[] {
  return Object.entries(perLanguage).flatMap(([lang, count]) =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `greet-${lang}-${String(index + 1)}`,
      target: 'chat',
      lang,
      provenance: 'synthetic' as const,
      input: { user: `hello ${String(index + 1)}` },
    })),
  );
}

export interface RecordedAdapter {
  /** An `adapter.command` that runs the given command behind the recorder. */
  readonly command: string[];
  readonly sessions: () => Promise<AdapterSession[]>;
  readonly generateRequests: () => Promise<GenerateRequest[]>;
}

/** Writes the recorder into `root` and puts it in front of an adapter command. */
export async function recordAdapter(
  root: string,
  command: readonly string[],
): Promise<RecordedAdapter> {
  const requestsDir = path.join(root, REQUESTS_DIR);
  await mkdir(requestsDir);
  await writeFile(path.join(root, RECORDER_FILE), RECORDER);
  const sessions = (): Promise<AdapterSession[]> => readSessions(requestsDir);
  return {
    command: [process.execPath, path.join(root, RECORDER_FILE), requestsDir, ...command],
    sessions,
    generateRequests: async () => (await sessions()).flatMap(generateRequestsOf),
  };
}

export async function createProject(spec: ProjectSpec): Promise<Project> {
  const root = await mkdtemp(path.join(tmpdir(), 'model-eval-e2e-'));
  const recorder = await recordAdapter(root, [
    process.execPath,
    MOCK_ADAPTER,
    scenarioFile(spec.scenario),
  ]);
  await mkdir(path.join(root, 'rules'));
  await mkdir(path.join(root, 'cases'));

  const config: ConfigInput = {
    version: 1,
    adapter: {
      command: recorder.command,
      ...(spec.adapterTimeoutMs === undefined ? {} : { timeoutMs: spec.adapterTimeoutMs }),
      ...(spec.mockState === true ? { env: { MOCK_STATE_DIR: root } } : {}),
    },
    variants: VARIANTS,
    pricing: PRICING,
    sampling: { repeats: 2 },
    ...spec.config,
  };
  await writeFile(path.join(root, 'model-eval.config.yaml'), stringify(config));
  await writeFile(path.join(root, 'rules', 'rules.yaml'), stringify({ rules: spec.rules }));
  await writeFile(path.join(root, 'cases', 'cases.yaml'), stringify({ cases: spec.cases }));

  return {
    root,
    outputDir: path.join(root, '.model-eval'),
    run: (args) => runCli(args, root),
    sessions: recorder.sessions,
    generateRequests: recorder.generateRequests,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

async function readSessions(dir: string): Promise<AdapterSession[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  return Promise.all(
    files.map(async (name) => {
      const text = await readFile(path.join(dir, name), 'utf8');
      const requests = text
        .split('\n')
        .filter((line) => line !== '')
        .map(parseRecordedLine);
      const initialize = requests.find((request) => request.method === 'initialize');
      const variant =
        initialize === undefined
          ? undefined
          : initializeParamsSchema.parse(initialize.params).variant.id;
      return { variant, requests };
    }),
  );
}

function parseRecordedLine(text: string): RecordedRequest {
  const entry: unknown = JSON.parse(text);
  if (!isRecord(entry) || typeof entry.at !== 'number' || typeof entry.line !== 'string') {
    throw new Error(`unexpected recorder line: ${text}`);
  }
  const message: unknown = JSON.parse(entry.line);
  if (!isRecord(message) || typeof message.method !== 'string') {
    throw new Error(`the tool sent a line without a method: ${entry.line}`);
  }
  return { at: entry.at, method: message.method, params: message.params };
}

function generateRequestsOf(session: AdapterSession): GenerateRequest[] {
  return session.requests
    .filter((request) => request.method === 'generate')
    .map((request) => {
      const params = generateParamsSchema.parse(request.params);
      return {
        variant: session.variant,
        at: request.at,
        caseId: params.caseId,
        repeat: params.repeat,
        seed: params.seed,
      };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
