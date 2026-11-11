import { watch } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { stringify } from 'yaml';
import type { z } from 'zod';

import { generateParamsSchema, initializeParamsSchema } from '../../../src/adapter/protocol.js';
import type { caseSchema, configSchema, ruleSchema } from '../../../src/config/schema.js';
import { CLI_TIMEOUT_MS, MOCK_ADAPTER, runCli, type CliResult } from './cli.js';
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
  /** More `adapter.env` entries; they change the adapter's `launchHash`. */
  readonly adapterEnv?: Readonly<Record<string, string>>;
  /** Copies the scenario into the project, so a test can change what the adapter declares. */
  readonly ownScenario?: boolean;
}

/** The project files a test can rewrite between commands. */
export type ProjectChange = Partial<Pick<ProjectSpec, 'rules' | 'cases' | 'config' | 'adapterEnv'>>;

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
  /** The scenario file the mock adapter reads. */
  readonly scenario: string;
  run(args: readonly string[]): Promise<CliResult>;
  /** Rewrites the config, rule and case files, as a user editing them would. */
  write(change: ProjectChange): Promise<void>;
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
 * to `<log dir>/<pid>.jsonl`, so a test can see which requests the tool wrote to the adapter
 * without relying on what the tool records.
 *
 * The tool counts a request as in flight once written and learns of an adapter exit only when
 * this process ends, so requests it writes in between land in a pipe nobody reads. When the
 * adapter exits with stdin still open, a detached drain process (`--drain`) takes stdin over,
 * outside the adapter's process group the tool signals, and records the rest until the tool
 * closes it.
 */
const RECORDER = `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function record(log, entry) {
  appendFileSync(log, JSON.stringify({ at: Date.now(), ...entry }) + '\\n');
}

function readLines(rest, onLine, onEnd) {
  let buffer = rest;
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let newline = buffer.indexOf(10);
    while (newline !== -1) {
      onLine(buffer.subarray(0, newline).toString('utf8'));
      buffer = buffer.subarray(newline + 1);
      newline = buffer.indexOf(10);
    }
  });
  process.stdin.on('end', onEnd);
  return () => buffer;
}

if (process.argv[2] === '--drain') {
  const [log, rest] = process.argv.slice(3);
  readLines(
    Buffer.from(rest, 'base64'),
    (line) => record(log, { line }),
    () => record(log, { mark: 'drained' }),
  );
} else {
  const [logDir, command, ...args] = process.argv.slice(2);
  const log = path.join(logDir, String(process.pid) + '.jsonl');
  const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  let open = true;
  const unread = readLines(
    Buffer.alloc(0),
    (line) => {
      record(log, { line });
      child.stdin.write(line + '\\n');
    },
    () => {
      open = false;
      child.stdin.end();
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    if (open) {
      record(log, { mark: 'handoff' });
      const drainArgs = [fileURLToPath(import.meta.url), '--drain', log, unread().toString('base64')];
      spawn(process.execPath, drainArgs, { stdio: [0, 'ignore', 'ignore'], detached: true }).unref();
    }
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}
`;

const RECORDER_FILE = 'record-adapter.mjs';
const SCENARIO_FILE = 'scenario.yaml';
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
  const scenario =
    spec.ownScenario === true ? path.join(root, SCENARIO_FILE) : scenarioFile(spec.scenario);
  if (spec.ownScenario === true) {
    await copyFile(scenarioFile(spec.scenario), scenario);
  }
  const recorder = await recordAdapter(root, [process.execPath, MOCK_ADAPTER, scenario]);
  await mkdir(path.join(root, 'rules'));
  await mkdir(path.join(root, 'cases'));

  let current = spec;
  const writeFiles = async (): Promise<void> => {
    const env = {
      ...(current.mockState === true ? { MOCK_STATE_DIR: root } : {}),
      ...current.adapterEnv,
    };
    const config: ConfigInput = {
      version: 1,
      adapter: {
        command: recorder.command,
        ...(current.adapterTimeoutMs === undefined ? {} : { timeoutMs: current.adapterTimeoutMs }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      },
      variants: VARIANTS,
      pricing: PRICING,
      sampling: { repeats: 2 },
      ...current.config,
    };
    await writeFile(path.join(root, 'model-eval.config.yaml'), stringify(config));
    await writeFile(path.join(root, 'rules', 'rules.yaml'), stringify({ rules: current.rules }));
    await writeFile(path.join(root, 'cases', 'cases.yaml'), stringify({ cases: current.cases }));
  };
  await writeFiles();

  return {
    root,
    outputDir: path.join(root, '.model-eval'),
    scenario,
    run: (args) => runCli(args, root),
    write: async (change) => {
      current = { ...current, ...change };
      await writeFiles();
    },
    sessions: recorder.sessions,
    generateRequests: recorder.generateRequests,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

async function readSessions(dir: string): Promise<AdapterSession[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort();
  return Promise.all(
    files.map(async (name) => {
      const entries = await settledLog(path.join(dir, name));
      const requests = entries.flatMap((entry) => ('line' in entry ? [requestOf(entry)] : []));
      const initialize = requests.find((request) => request.method === 'initialize');
      const variant =
        initialize === undefined
          ? undefined
          : initializeParamsSchema.parse(initialize.params).variant.id;
      return { variant, requests };
    }),
  );
}

type RecorderEntry =
  | { readonly at: number; readonly line: string }
  | { readonly at: number; readonly mark: 'handoff' | 'drained' };

/** A log is complete once the drain process the recorder handed stdin to has read it all. */
function settledLog(file: string): Promise<RecorderEntry[]> {
  return new Promise((resolve, reject) => {
    const watcher = watch(file);
    let settled = false;
    const settle = (outcome: { entries: RecorderEntry[] } | { error: unknown }): void => {
      if (settled) {
        return;
      }
      settled = true;
      watcher.close();
      clearTimeout(timer);
      if ('entries' in outcome) {
        resolve(outcome.entries);
      } else {
        reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
      }
    };
    const timer = setTimeout(() => {
      settle({ error: new Error(`the recorder's drain process never finished ${file}`) });
    }, CLI_TIMEOUT_MS);
    const check = (): void => {
      readFile(file, 'utf8')
        .then((text) => {
          const entries = text
            .split('\n')
            .filter((line) => line !== '')
            .map(parseRecorderEntry);
          const marks = entries.flatMap((entry) => ('mark' in entry ? [entry.mark] : []));
          if (!marks.includes('handoff') || marks.includes('drained')) {
            settle({ entries });
          }
        })
        .catch((error: unknown) => {
          settle({ error });
        });
    };
    watcher.on('change', check);
    watcher.on('error', (error) => {
      settle({ error });
    });
    check();
  });
}

function parseRecorderEntry(text: string): RecorderEntry {
  const entry: unknown = JSON.parse(text);
  if (isRecord(entry) && typeof entry.at === 'number') {
    if (typeof entry.line === 'string') {
      return { at: entry.at, line: entry.line };
    }
    if (entry.mark === 'handoff' || entry.mark === 'drained') {
      return { at: entry.at, mark: entry.mark };
    }
  }
  throw new Error(`unexpected recorder line: ${text}`);
}

function requestOf(entry: { readonly at: number; readonly line: string }): RecordedRequest {
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
