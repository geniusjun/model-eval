import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

import type { z } from 'zod';

import { parseJsonText } from './canonical-json.js';
import type { JsonValue } from './json-value.js';
import {
  adapterMessageSchema,
  callsParamsSchema,
  generateResultSchema,
  initializeResultSchema,
  logParamsSchema,
  PROTOCOL_VERSION,
  renderResultSchema,
  rpcErrorDataSchema,
  type CallsParams,
  type GenerateParams,
  type GenerateResult,
  type InitializeParams,
  type InitializeResult,
  type LogParams,
  type RenderParams,
  type RenderResult,
  type RpcErrorData,
} from './protocol.js';

/** How long an adapter may take to exit after `shutdown` before it gets a termination signal. */
export const SHUTDOWN_GRACE_MS = 5000;
const SHOWN_LINE_CHARS = 200;

export interface AdapterLaunch {
  readonly command: readonly string[];
  /** Absolute; resolved from the config folder by the loader. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface StartOptions {
  readonly launch: AdapterLaunch;
  readonly initialize: Omit<InitializeParams, 'protocolVersion'>;
  /** `run.concurrency`; the adapter's `maxConcurrency` can lower it. */
  readonly concurrency: number;
  readonly onLog?: (params: LogParams) => void;
  readonly onCalls?: (params: CallsParams) => void;
  readonly onStderr?: (line: string) => void;
  /** How long to wait for an exit before each signal; `SHUTDOWN_GRACE_MS` unless set. */
  readonly shutdownGraceMs?: number;
}

/** Every start problem is a configuration error (exit code 4). */
export interface StartFailure {
  readonly kind:
    'spawn-failed' | 'initialize-failed' | 'version-mismatch' | 'protocol-violation' | 'exited';
  readonly message: string;
}

export type StartResult =
  | { readonly ok: true; readonly client: AdapterClient }
  | { readonly ok: false; readonly error: StartFailure };

export type CallOutcome<T> =
  | { readonly kind: 'result'; readonly value: T }
  | {
      readonly kind: 'rpc-error';
      readonly code: number;
      readonly message: string;
      readonly data?: RpcErrorData;
    }
  /** The response broke the protocol: a result without required fields, malformed error data. */
  | { readonly kind: 'invalid'; readonly message: string }
  /** No response will come: the process died or its stdout broke the protocol. */
  | { readonly kind: 'lost'; readonly message: string };

/** How the adapter process ended. */
interface Ending {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The adapter had to be sent a termination signal. */
  readonly forced: boolean;
}

export interface ShutdownOutcome extends Ending {
  /**
   * `shutdown` got a result. An exit or a JSON-RPC error is no answer, since every adapter must
   * implement `shutdown`.
   */
  readonly answered: boolean;
  /** How the adapter broke the protocol, stdout contamination included, if it did. */
  readonly violation?: string;
}

export interface GenerateOptions {
  /** The JSON-RPC `id` of the request, which `calls` notifications name; called once it is sent. */
  readonly onRequest?: (id: number) => void;
}

export interface AdapterClient {
  readonly info: InitializeResult;
  /** The smaller of `run.concurrency` and the adapter's `maxConcurrency`. */
  readonly concurrency: number;
  render(params: RenderParams): Promise<CallOutcome<RenderResult>>;
  generate(params: GenerateParams, options?: GenerateOptions): Promise<CallOutcome<GenerateResult>>;
  shutdown(): Promise<ShutdownOutcome>;
}

type RequestParams = InitializeParams | RenderParams | GenerateParams;
type LostCause = 'spawn' | 'exit' | 'violation' | 'timeout';

type RawResponse =
  | { kind: 'result'; result: JsonValue }
  | { kind: 'error'; code: number; message: string; data: JsonValue | undefined }
  | { kind: 'lost'; cause: LostCause; message: string };

interface Exit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export async function startAdapter(options: StartOptions): Promise<StartResult> {
  const [executable, ...args] = options.launch.command;
  if (executable === undefined) {
    return { ok: false, error: { kind: 'spawn-failed', message: 'adapter.command is empty' } };
  }
  const child = spawn(executable, args, {
    cwd: options.launch.cwd,
    env: { ...process.env, ...options.launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const connection = new Connection(child, options);
  const spawned = await connection.spawned;
  if (!spawned.ok) {
    return { ok: false, error: { kind: 'spawn-failed', message: spawned.message } };
  }

  const response = await connection.request(
    'initialize',
    { protocolVersion: PROTOCOL_VERSION, ...options.initialize },
    options.initialize.timeoutMs,
  );
  const initialized = readInitialize(response);
  if (!initialized.ok) {
    await endAfterFailedStart(connection, initialized.error.kind, options.initialize.timeoutMs);
    return initialized;
  }
  const { info } = initialized;
  const concurrency = Math.min(
    options.concurrency,
    info.capabilities.maxConcurrency ?? options.concurrency,
  );
  connection.setLimit(concurrency);
  return {
    ok: true,
    client: createClient(connection, info, concurrency, options.initialize.timeoutMs),
  };
}

type Initialized = { ok: true; info: InitializeResult } | { ok: false; error: StartFailure };

const LOST_START_FAILURES: Readonly<Record<LostCause, StartFailure['kind']>> = {
  spawn: 'spawn-failed',
  exit: 'exited',
  violation: 'protocol-violation',
  timeout: 'initialize-failed',
};

/**
 * `shutdown`, then stdin closed and the grace period; an adapter that does not answer
 * `shutdown` within the time limit is signalled at once (adapter-protocol §`shutdown`).
 */
async function shutdownAdapter(
  connection: Connection,
  timeoutMs: number,
): Promise<ShutdownOutcome> {
  const response = await connection.request('shutdown', undefined, timeoutMs);
  const ending =
    response.kind === 'lost' && response.cause === 'timeout'
      ? { ...(await connection.terminate()), forced: true }
      : await connection.close();
  const outcome = { ...ending, answered: response.kind === 'result' };
  const { violation } = connection;
  return violation === undefined ? outcome : { ...outcome, violation };
}

async function endAfterFailedStart(
  connection: Connection,
  kind: StartFailure['kind'],
  timeoutMs: number,
): Promise<void> {
  if (kind === 'version-mismatch') {
    await shutdownAdapter(connection, timeoutMs);
  } else if (kind === 'initialize-failed') {
    await connection.terminate();
  } else {
    await connection.close();
  }
}

function readInitialize(response: RawResponse): Initialized {
  const fail = (kind: StartFailure['kind'], message: string): Initialized => ({
    ok: false,
    error: { kind, message },
  });
  switch (response.kind) {
    case 'lost':
      return fail(LOST_START_FAILURES[response.cause], response.message);
    case 'error':
      return fail('initialize-failed', `initialize failed: ${response.message}`);
    case 'result': {
      const parsed = initializeResultSchema.safeParse(response.result);
      if (!parsed.success) {
        return fail(
          'initialize-failed',
          `initialize result is invalid: ${summarise(parsed.error)}`,
        );
      }
      const { protocolVersion } = parsed.data;
      if (protocolVersion.split('.')[0] !== PROTOCOL_VERSION) {
        return fail(
          'version-mismatch',
          `the adapter speaks protocol ${protocolVersion}; this tool speaks ${PROTOCOL_VERSION}`,
        );
      }
      return { ok: true, info: parsed.data };
    }
  }
}

function createClient(
  connection: Connection,
  info: InitializeResult,
  concurrency: number,
  timeoutMs: number,
): AdapterClient {
  const call = async <T>(
    method: string,
    params: RequestParams,
    schema: z.ZodType<T>,
    options: { readonly timeoutMs?: number; readonly onRequest?: (id: number) => void } = {},
  ): Promise<CallOutcome<T>> =>
    toOutcome(
      await connection.limited(() =>
        connection.request(method, params, options.timeoutMs, options.onRequest),
      ),
      schema,
    );
  return {
    info,
    concurrency,
    // A render calls no model, so an adapter that does not answer within the limit is broken
    // (adapter-protocol §Time Limits and Recovery); generate time-outs are handled per trial.
    render: (params) => call('render', params, renderResultSchema, { timeoutMs }),
    generate: (params, options) =>
      call(
        'generate',
        params,
        generateResultSchema,
        options?.onRequest === undefined ? {} : { onRequest: options.onRequest },
      ),
    shutdown: () => shutdownAdapter(connection, timeoutMs),
  };
}

function toOutcome<T>(response: RawResponse, schema: z.ZodType<T>): CallOutcome<T> {
  switch (response.kind) {
    case 'lost':
      return { kind: 'lost', message: response.message };
    case 'error': {
      if (response.data === undefined) {
        return { kind: 'rpc-error', code: response.code, message: response.message };
      }
      const data = rpcErrorDataSchema.safeParse(response.data);
      return data.success
        ? { kind: 'rpc-error', code: response.code, message: response.message, data: data.data }
        : { kind: 'invalid', message: `JSON-RPC error data is invalid: ${summarise(data.error)}` };
    }
    case 'result': {
      const parsed = schema.safeParse(response.result);
      return parsed.success
        ? { kind: 'result', value: parsed.data }
        : { kind: 'invalid', message: `result is invalid: ${summarise(parsed.error)}` };
    }
  }
}

function summarise(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

/** One adapter process: line framing, request IDs, the concurrency limit and process lifetime. */
class Connection {
  readonly spawned: Promise<{ ok: true } | { ok: false; message: string }>;
  private readonly pending = new Map<number, (response: RawResponse) => void>();
  private readonly waiting: (() => void)[] = [];
  private readonly exited: Promise<Exit>;
  private terminating: Promise<Exit> | undefined;
  private nextId = 1;
  private inFlight = 0;
  private limit = 1;
  private lost: { cause: LostCause; message: string } | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: StartOptions,
  ) {
    this.spawned = new Promise((resolve) => {
      child.once('spawn', () => {
        resolve({ ok: true });
      });
      child.once('error', (error) => {
        this.lose('spawn', `the adapter could not start: ${error.message}`);
        resolve({ ok: false, message: `the adapter could not start: ${error.message}` });
      });
    });
    this.exited = new Promise((resolve) => {
      child.once('close', (exitCode, signal) => {
        if (this.stderrBuffer !== '') {
          this.options.onStderr?.(this.stderrBuffer);
          this.stderrBuffer = '';
        }
        this.lose(
          'exit',
          `the adapter exited (code ${String(exitCode)}, signal ${String(signal)})`,
        );
        resolve({ exitCode, signal });
      });
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      this.onStderr(chunk);
    });
    child.stdin.on('error', () => {
      // A dead adapter closes its stdin; the close event reports the exit.
    });
  }

  private get graceMs(): number {
    return this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  /** The protocol violation that ended the connection, if one did. */
  get violation(): string | undefined {
    return this.lost?.cause === 'violation' ? this.lost.message : undefined;
  }

  setLimit(limit: number): void {
    this.limit = limit;
  }

  /** A finished request hands its slot straight to the next waiter, so no newcomer can take it. */
  async limited(send: () => Promise<RawResponse>): Promise<RawResponse> {
    if (this.inFlight >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.inFlight += 1;
    }
    try {
      return await send();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) {
        this.inFlight -= 1;
      } else {
        next();
      }
    }
  }

  request(
    method: string,
    params?: RequestParams,
    timeoutMs?: number,
    onRequest?: (id: number) => void,
  ): Promise<RawResponse> {
    if (this.lost !== undefined) {
      return Promise.resolve({ kind: 'lost', ...this.lost });
    }
    const id = this.nextId++;
    onRequest?.(id);
    return new Promise((resolve) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              resolve({
                kind: 'lost',
                cause: 'timeout',
                message: `no response to ${method} within ${String(timeoutMs)} ms`,
              });
            }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  /** Closes stdin and gives the adapter the grace period to exit before signalling it. */
  async close(): Promise<Ending> {
    this.child.stdin.end();
    const graceful = await Promise.race([this.exited, delay(this.graceMs)]);
    if (graceful !== undefined) {
      return { ...graceful, forced: false };
    }
    return { ...(await this.terminate()), forced: true };
  }

  /** SIGTERM, then SIGKILL after the grace period, so the wait is always bounded. */
  terminate(): Promise<Exit> {
    this.terminating ??= (async () => {
      this.child.kill('SIGTERM');
      const exit = await Promise.race([this.exited, delay(this.graceMs)]);
      if (exit !== undefined) {
        return exit;
      }
      this.child.kill('SIGKILL');
      return this.exited;
    })();
    return this.terminating;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split('\n');
    this.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.options.onStderr?.(line);
    }
  }

  private onLine(line: string): void {
    const json = parseJsonText(line);
    const message = json.ok ? adapterMessageSchema.safeParse(json.value) : undefined;
    if (message?.success !== true) {
      this.violate(`stdout is reserved for the protocol; the adapter wrote: ${shown(line)}`);
      return;
    }
    const value = message.data;
    if ('error' in value) {
      const settled =
        value.id !== null &&
        this.settle(value.id, {
          kind: 'error',
          code: value.error.code,
          message: value.error.message,
          data: value.error.data,
        });
      if (!settled) {
        this.violate(`the adapter answered a request the tool did not send: ${shown(line)}`);
      }
    } else if ('result' in value) {
      if (!this.settle(value.id, { kind: 'result', result: value.result })) {
        this.violate(`the adapter answered a request the tool did not send: ${shown(line)}`);
      }
    } else {
      this.onNotification(value.method, value.params, line);
    }
  }

  private onNotification(method: string, params: JsonValue | undefined, line: string): void {
    const invalid = (): void => {
      this.violate(`the adapter sent an invalid ${method} notification: ${shown(line)}`);
    };
    if (method === 'log') {
      const parsed = logParamsSchema.safeParse(params);
      if (parsed.success) {
        this.options.onLog?.(parsed.data);
      } else {
        invalid();
      }
    } else if (method === 'calls') {
      const parsed = callsParamsSchema.safeParse(params);
      if (parsed.success) {
        this.options.onCalls?.(parsed.data);
      } else {
        invalid();
      }
    }
  }

  private settle(id: number, response: RawResponse): boolean {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(response);
    return resolve !== undefined;
  }

  private violate(message: string): void {
    this.lose('violation', message);
    void this.terminate();
  }

  private lose(cause: LostCause, message: string): void {
    this.lost ??= { cause, message };
    const lost = this.lost;
    for (const resolve of this.pending.values()) {
      resolve({ kind: 'lost', ...lost });
    }
    this.pending.clear();
  }
}

function shown(line: string): string {
  return line.slice(0, SHOWN_LINE_CHARS);
}

function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve(undefined);
    }, ms).unref(),
  );
}
