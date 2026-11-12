import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import type { z } from 'zod';

import type { JsonValue } from '../../../../src/adapter/json-value.js';
import {
  adapterMessageSchema,
  callsParamsSchema,
  type CallsParams,
  generateResultSchema,
  initializeResultSchema,
  type LogParams,
  logParamsSchema,
  renderResultSchema,
  type RpcError,
  rpcErrorDataSchema,
  shutdownResultSchema,
} from '../../../../src/adapter/protocol.js';
import { PYTHON_DIR, pythonInterpreter, ROOT } from './mock-api.js';

export const NODE_SERVICES = path.join(ROOT, 'test/contract/helper/services');
export const PYTHON_SERVICES = path.join(PYTHON_DIR, 'tests/services');
export const ROOT_CA = path.join(ROOT, 'test/fixtures/helper/tls/root-ca.pem');

export const OPENAI_API_KEY = 'test-openai-key';
export const ANTHROPIC_API_KEY = 'test-anthropic-key';
const BASE_URL_VARIABLES = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'] as const;
const REQUEST_TIMEOUT_MS = 30_000;

/** Inherited settings that could send a request past the mock server or with real credentials. */
const REMOVED_VARIABLES: ReadonlySet<string> = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
]);

/**
 * The environment of an adapter process: the parent's (this process's by default) without proxies
 * and real credentials, with the mock server's base URLs and dummy keys.
 */
export function apiEnv(
  baseUrl: string,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !REMOVED_VARIABLES.has(name.toUpperCase())) {
      env[name] = value;
    }
  }
  return {
    ...env,
    OPENAI_BASE_URL: `${baseUrl}/v1`,
    ANTHROPIC_BASE_URL: baseUrl,
    OPENAI_API_KEY,
    ANTHROPIC_API_KEY,
    NO_PROXY: '*',
    no_proxy: '*',
  };
}

export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  if (bare === 'localhost') {
    return true;
  }
  if (isIP(bare) === 4) {
    return bare.startsWith('127.');
  }
  return isIP(bare) === 6 && bare === '::1';
}

/** Refuses to start an adapter whose model API base URL leaves the machine. */
export function requireLoopback(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of BASE_URL_VARIABLES) {
    const value = env[name] ?? '';
    const host = URL.canParse(value) ? new URL(value).hostname : '';
    if (!isLoopback(host)) {
      throw new Error(`${name} must be a loopback address, not ${JSON.stringify(value)}`);
    }
  }
}

/** The provider of an SDK, which is also the name of its Python distribution. */
export type Provider = 'openai' | 'anthropic';
const pythonSdkVersions = new Map<string, string | null>();

/** The installed version of a Python SDK in the interpreter of `MODEL_EVAL_PYTHON`, or null. */
export function pythonSdkVersion(sdk: Provider): string | null {
  const python = pythonInterpreter();
  const key = `${python}\0${sdk}`;
  if (!pythonSdkVersions.has(key)) {
    const script = [
      'import importlib.metadata as m',
      `try: print(m.version(${JSON.stringify(sdk)}))`,
      'except m.PackageNotFoundError: pass',
    ].join('\n');
    const version = execFileSync(python, ['-c', script], { encoding: 'utf8' }).trim();
    pythonSdkVersions.set(key, version === '' ? null : version);
  }
  return pythonSdkVersions.get(key) ?? null;
}

/** Fails with the way to build the environment when the Python SDK a case needs is missing. */
export function requirePythonSdk(sdk: Provider): void {
  if (pythonSdkVersion(sdk) === null) {
    const venv = 'adapters/python/.venv';
    throw new Error(
      [
        `The Python at MODEL_EVAL_PYTHON (${pythonInterpreter()}) has no ${sdk} SDK.`,
        'Point MODEL_EVAL_PYTHON at the interpreter of an environment built from one file of',
        'adapters/python/tests/requirements/, for example:',
        `uv venv ${venv} && uv pip install --python ${venv}/bin/python`,
        `-r adapters/python/tests/requirements/${sdk}-2.txt`,
      ].join(' '),
    );
  }
}

/** The adapter wrote something on stdout that is not a protocol message. */
export class ProtocolViolation extends Error {
  constructor(lines: readonly string[]) {
    super(`stdout lines that are not protocol messages: ${JSON.stringify(lines)}`);
    this.name = 'ProtocolViolation';
  }
}

function servicePath(service: string, folder: string, extension: string): string {
  return path.isAbsolute(service) ? service : path.join(folder, `${service}${extension}`);
}

export type AdapterLanguage = 'python' | 'typescript';

export interface AdapterSpec {
  readonly language: AdapterLanguage;
  /**
   * A module of adapters/python/tests/services/ or test/contract/helper/services/, without its
   * extension, or the absolute path of an adapter file.
   */
  readonly service: string;
  /** The SDK alias of package.json a Node service loads, as `MODEL_EVAL_SDK`. */
  readonly sdk?: string;
  /** Python only: the SDK the case needs in the interpreter of `MODEL_EVAL_PYTHON`. */
  readonly pythonSdk?: Provider;
  /** The whole environment of the process, normally built with `apiEnv`. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A response: the result checked against the method's schema, with the result as sent, or the
 * JSON-RPC error of an adapter error.
 */
export type RpcResponse<T> =
  | { readonly kind: 'result'; readonly result: T; readonly sent: JsonValue }
  | { readonly kind: 'error'; readonly error: RpcError };

/** A response as it arrived, before the result is checked against the method's schema. */
type Arrived =
  | { readonly kind: 'result'; readonly result: JsonValue }
  | { readonly kind: 'error'; readonly error: RpcError };

interface Pending {
  /** Throws when the result breaks the method's schema. */
  readonly settle: (response: Arrived) => void;
  readonly reject: (error: Error) => void;
}

/** Everything an adapter sent besides responses. */
export interface Exchange {
  readonly calls: CallsParams[];
  readonly logs: LogParams[];
  readonly stderr: string[];
  /** stdout lines that are not protocol messages, and messages that break their schema. */
  readonly violations: string[];
}

/**
 * A Python adapter or a Node service spoken to over stdio, with every message checked against the
 * schemas of src/adapter/protocol.ts.
 */
export class AdapterDriver {
  readonly exchange: Exchange = { calls: [], logs: [], stderr: [], violations: [] };
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private readonly exited: Promise<number | null>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.on('data', (chunk: Buffer) => this.exchange.stderr.push(chunk.toString('utf8')));
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.receive(line);
    });
    this.exited = new Promise((resolve) => {
      child.on('exit', (code) => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`the adapter exited with ${String(code)}:\n${this.stderr()}`));
        }
        this.pending.clear();
        resolve(code);
      });
    });
  }

  static start(spec: AdapterSpec): AdapterDriver {
    const env: Record<string, string | undefined> = { ...spec.env };
    requireLoopback(env);
    if (spec.language === 'python') {
      if (spec.pythonSdk !== undefined) {
        requirePythonSdk(spec.pythonSdk);
      }
      env.PYTHONPATH = [PYTHON_DIR, PYTHON_SERVICES, env.PYTHONPATH]
        .filter((entry) => entry !== undefined && entry !== '')
        .join(path.delimiter);
      const script = servicePath(spec.service, PYTHON_SERVICES, '.py');
      return new AdapterDriver(spawn(pythonInterpreter(), [script], { cwd: PYTHON_SERVICES, env }));
    }
    if (spec.sdk === undefined) {
      throw new Error(`the Node service ${spec.service} needs an SDK alias`);
    }
    env.MODEL_EVAL_SDK = spec.sdk;
    const script = servicePath(spec.service, NODE_SERVICES, '.mjs');
    return new AdapterDriver(spawn(process.execPath, [script], { cwd: NODE_SERVICES, env }));
  }

  stderr(): string {
    return this.exchange.stderr.join('');
  }

  initialize(params: JsonValue): Promise<RpcResponse<z.infer<typeof initializeResultSchema>>> {
    return this.request('initialize', params, (value) => initializeResultSchema.parse(value)).done;
  }

  render(params: JsonValue): Promise<RpcResponse<z.infer<typeof renderResultSchema>>> {
    return this.request('render', params, (value) => renderResultSchema.parse(value)).done;
  }

  /** The request ID, so the test can `cancel` it, and the response. */
  generate(params: JsonValue): {
    readonly id: number;
    readonly done: Promise<RpcResponse<z.infer<typeof generateResultSchema>>>;
  } {
    return this.request('generate', params, (value) => generateResultSchema.parse(value));
  }

  cancel(id: number): void {
    this.write({ jsonrpc: '2.0', method: 'cancel', params: { id } });
  }

  async shutdown(): Promise<void> {
    const response = await this.request('shutdown', null, (value) =>
      shutdownResultSchema.parse(value),
    ).done;
    if (response.kind === 'error') {
      throw new Error(`shutdown failed: ${response.error.message}`);
    }
  }

  /** Waits for the process to exit after `shutdown`, killing it when it does not. */
  async close(timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    await this.exited;
    clearTimeout(timer);
    this.checkStdout();
  }

  checkStdout(): void {
    if (this.exchange.violations.length > 0) {
      throw new ProtocolViolation(this.exchange.violations);
    }
  }

  private request<T>(
    method: string,
    params: JsonValue,
    parse: (value: JsonValue) => T,
  ): { readonly id: number; readonly done: Promise<RpcResponse<T>> } {
    this.nextId += 1;
    const id = this.nextId;
    const done = new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} ${String(id)}; stderr:\n${this.stderr()}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        settle: (response) => {
          clearTimeout(timer);
          resolve(
            response.kind === 'error'
              ? response
              : { kind: 'result', result: parse(response.result), sent: response.result },
          );
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.write(
      params === null ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params },
    );
    return { id, done };
  }

  private write(message: JsonValue): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.exchange.violations.push(line);
      return;
    }
    const message = adapterMessageSchema.safeParse(value);
    if (!message.success) {
      this.exchange.violations.push(line);
      return;
    }
    const data = message.data;
    if ('method' in data) {
      this.notification(data.method, data.params ?? null, line);
    } else if ('result' in data) {
      this.settle(data.id, line, { kind: 'result', result: data.result });
    } else if (data.id !== null) {
      const error = data.error;
      if (error.data !== undefined && !rpcErrorDataSchema.safeParse(error.data).success) {
        this.exchange.violations.push(line);
      }
      this.settle(data.id, line, { kind: 'error', error });
    } else {
      this.exchange.violations.push(line);
    }
  }

  private settle(id: number, line: string, response: Arrived): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      this.exchange.violations.push(line);
      return;
    }
    this.pending.delete(id);
    if (this.exchange.violations.length > 0) {
      pending.reject(new ProtocolViolation(this.exchange.violations));
      return;
    }
    try {
      pending.settle(response);
    } catch (error) {
      this.exchange.violations.push(line);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private notification(method: string, params: JsonValue, line: string): void {
    if (method === 'calls') {
      const parsed = callsParamsSchema.safeParse(params);
      if (parsed.success) {
        this.exchange.calls.push(parsed.data);
        return;
      }
    } else if (method === 'log') {
      const parsed = logParamsSchema.safeParse(params);
      if (parsed.success) {
        this.exchange.logs.push(parsed.data);
        return;
      }
    }
    this.exchange.violations.push(line);
  }
}
