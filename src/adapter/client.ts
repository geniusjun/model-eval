import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import process from 'node:process';

import type { z } from 'zod';

import { parseJsonText } from './canonical-json.js';
import { adapterChanges, type AdapterChange } from './identity.js';
import type { JsonValue } from './json-value.js';
import {
  adapterMessageSchema,
  answerResultSchema,
  callsParamsSchema,
  failureResultSchema,
  initializeResultSchema,
  logParamsSchema,
  PROTOCOL_VERSION,
  renderResultSchema,
  rpcErrorDataSchema,
  type CallsParams,
  type CancelParams,
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
/**
 * On POSIX the adapter runs in a process group of its own, so an interrupt from the terminal
 * reaches only the tool, which decides what the adapter receives (adapter-protocol §Transport).
 */
const OWN_GROUP = process.platform !== 'win32';
/** Losses of the adapter process in a row after which no new process is started. */
export const LOSSES_IN_A_ROW = 3;
const SHOWN_LINE_CHARS = 200;

export interface AdapterLaunch {
  readonly command: readonly string[];
  /** Absolute; resolved from the config folder by the loader. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface StartOptions {
  readonly launch: AdapterLaunch;
  /** Also the time limit of each request: `adapter.timeoutMs`. */
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
    | 'spawn-failed'
    | 'initialize-failed'
    | 'version-mismatch'
    | 'protocol-violation'
    | 'exited'
    /** The `toolPaths` of a restart could not be listed, so no process was started. */
    | 'tool-paths-failed';
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

export type GenerateOutcome =
  | CallOutcome<GenerateResult>
  /** No response within `adapter.timeoutMs`; the request keeps its slot until it answers. */
  | { readonly kind: 'timed-out'; readonly message: string }
  /** The request reached no adapter: none runs and none may be started. */
  | { readonly kind: 'refused'; readonly message: string };

/** The response to an abandoned request: it is never graded, only its cost counts. */
export type LateResponse = Exclude<CallOutcome<GenerateResult>, { readonly kind: 'lost' }>;

/**
 * Why the adapter process was lost: it could not start, it exited, it broke the protocol, or
 * every slot held a request without an answer for another time limit.
 */
export type LossCause = 'spawn' | 'exit' | 'violation' | 'stuck';

/** What happened to the adapter process of a supervised client (adapter-protocol §Time Limits). */
export type AdapterFault =
  /** The process was lost; the next `generate` starts a new one. */
  | { readonly kind: 'restarting'; readonly cause: LossCause; readonly message: string }
  /** The {@link LOSSES_IN_A_ROW}th loss in a row: no new process is started. */
  | { readonly kind: 'crashed'; readonly cause: LossCause; readonly message: string }
  /** A new process did not start or initialise; none is started after it. */
  | { readonly kind: 'restart-failed'; readonly error: StartFailure }
  /** A new process declares other code than the first; it gets no request. */
  | { readonly kind: 'restart-changed'; readonly changes: readonly AdapterChange[] }
  /** A new process runs, initialised with these `toolPaths`. */
  | { readonly kind: 'restarted'; readonly toolPaths: readonly string[] };

export interface Recovery {
  /** The `toolPaths` of the `initialize` of a new process. */
  readonly toolPaths: () => Promise<readonly string[]>;
  readonly onFault: (fault: AdapterFault) => void;
}

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
  /** The response to a request abandoned at the time limit, when it arrives. */
  readonly onLate?: (response: LateResponse) => void;
}

export interface AdapterClient {
  /** What the first process declared. */
  readonly info: InitializeResult;
  /** The smaller of `run.concurrency` and the adapter's `maxConcurrency`. */
  readonly concurrency: number;
  render(params: RenderParams): Promise<CallOutcome<RenderResult>>;
  generate(params: GenerateParams, options?: GenerateOptions): Promise<GenerateOutcome>;
  /**
   * After this call, a lost process is replaced by a new one at the next `generate` and faults
   * are reported; without it, a lost process stays lost.
   */
  supervise(recovery: Recovery): void;
  shutdown(): Promise<ShutdownOutcome>;
  /**
   * Gives up every request in flight without waiting: sends `cancel` for each when declared,
   * starts no new process and closes stdin, so the adapter exits within the grace period.
   */
  cancel(): void;
}

type RequestParams = InitializeParams | RenderParams | GenerateParams;

interface Loss {
  readonly cause: LossCause;
  readonly message: string;
}

type RawResponse =
  | { kind: 'result'; result: JsonValue }
  | { kind: 'error'; code: number; message: string; data: JsonValue | undefined }
  | { kind: 'lost'; cause: LossCause | 'timeout'; message: string };

interface Sent {
  /** Absent when the process was lost before the request could be written. */
  readonly id: number | undefined;
  readonly response: Promise<RawResponse>;
}

interface Exit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

type LossListener = (connection: Connection, loss: Loss) => void;

/** Request IDs are unique over every process of one client, so `calls` notifications stay apart. */
function idCounter(): () => number {
  let next = 1;
  return () => next++;
}

export async function startAdapter(options: StartOptions): Promise<StartResult> {
  const ids = idCounter();
  const launched = await launch(options, options.initialize, ids);
  if (!launched.ok) {
    return launched;
  }
  const { info } = launched;
  const concurrency = Math.min(
    options.concurrency,
    info.capabilities.maxConcurrency ?? options.concurrency,
  );
  return { ok: true, client: new SupervisedClient(options, ids, launched, concurrency) };
}

type Launched =
  | { readonly ok: true; readonly connection: Connection; readonly info: InitializeResult }
  | { readonly ok: false; readonly error: StartFailure };

/** Spawns the adapter and `initialize`s it; a failed start ends the process. */
async function launch(
  options: StartOptions,
  initialize: Omit<InitializeParams, 'protocolVersion'>,
  ids: () => number,
): Promise<Launched> {
  const [executable, ...args] = options.launch.command;
  if (executable === undefined) {
    return { ok: false, error: { kind: 'spawn-failed', message: 'adapter.command is empty' } };
  }
  const child = spawn(executable, args, {
    cwd: options.launch.cwd,
    env: { ...process.env, ...options.launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: OWN_GROUP,
  });
  const connection = new Connection(child, options, ids);
  const spawned = await connection.spawned;
  if (!spawned.ok) {
    return { ok: false, error: { kind: 'spawn-failed', message: spawned.message } };
  }
  const response = await connection.request(
    'initialize',
    { protocolVersion: PROTOCOL_VERSION, ...initialize },
    initialize.timeoutMs,
  );
  const initialized = readInitialize(response);
  if (!initialized.ok) {
    await endAfterFailedStart(connection, initialized.error.kind, initialize.timeoutMs);
    return initialized;
  }
  return { ok: true, connection, info: initialized.info };
}

type Initialized = { ok: true; info: InitializeResult } | { ok: false; error: StartFailure };

const LOST_START_FAILURES: Readonly<Record<LossCause | 'timeout', StartFailure['kind']>> = {
  spawn: 'spawn-failed',
  exit: 'exited',
  violation: 'protocol-violation',
  stuck: 'exited',
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

type Reader<T> = (value: JsonValue) => z.ZodSafeParseResult<T>;

const readRender: Reader<RenderResult> = (value) => renderResultSchema.safeParse(value);

/**
 * A failure result has `error`; anything else must be an answer, so the problems reported are
 * those of the shape the adapter meant.
 */
const readGenerate: Reader<GenerateResult> = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && 'error' in value
    ? failureResultSchema.safeParse(value)
    : answerResultSchema.safeParse(value);

function toOutcome<T>(response: RawResponse, read: Reader<T>): CallOutcome<T> {
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
      const parsed = read(response.result);
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

/** The concurrency limit; a freed slot goes straight to the next waiter, so no newcomer takes it. */
class Slots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.used < this.limit) {
      this.used += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.used -= 1;
    } else {
      next();
    }
  }
}

/**
 * The adapter of one variant over its processes: the concurrency limit, the time limit of each
 * request, and once supervised, a new process after a loss (adapter-protocol §Time Limits and
 * Recovery).
 */
class SupervisedClient implements AdapterClient {
  readonly info: InitializeResult;
  private connection: Connection;
  /** What the running process declared. */
  private declared: InitializeResult;
  private readonly slots: Slots;
  private recovery: Recovery | undefined;
  private lossesInARow = 0;
  /** Why no request goes to the adapter any more: a loss limit or a refused restart. */
  private refusal: string | undefined;
  private restarting: Promise<void> | undefined;
  private shuttingDown = false;
  /** Set by {@link cancel}: the process is being terminated and nothing waits for it. */
  private cancelled = false;
  /** Ends the wait of each `generate` still waiting for its answer. */
  private readonly waiters = new Set<() => void>();
  private stuckTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: StartOptions,
    private readonly ids: () => number,
    started: { readonly connection: Connection; readonly info: InitializeResult },
    readonly concurrency: number,
  ) {
    this.info = started.info;
    this.declared = started.info;
    this.connection = started.connection;
    this.install(started.connection);
    this.slots = new Slots(concurrency);
  }

  private get timeoutMs(): number {
    return this.options.initialize.timeoutMs;
  }

  async render(params: RenderParams): Promise<CallOutcome<RenderResult>> {
    await this.slots.acquire();
    try {
      // A render calls no model, so an adapter that does not answer within the limit is broken
      // (adapter-protocol §Time Limits and Recovery).
      const response = await this.connection.request('render', params, this.timeoutMs);
      return toOutcome(response, readRender);
    } finally {
      this.slots.release();
    }
  }

  async generate(params: GenerateParams, options: GenerateOptions = {}): Promise<GenerateOutcome> {
    await this.slots.acquire();
    const connection = await this.usable();
    const sent = connection?.send('generate', params, options.onRequest);
    if (connection === undefined || sent?.id === undefined) {
      this.slots.release();
      return { kind: 'refused', message: this.refusal ?? this.lossMessage() };
    }
    // An abandoned request keeps its slot until its late response or the loss of its process.
    void sent.response.finally(() => {
      this.slots.release();
    });
    return this.answer(connection, sent, options);
  }

  supervise(recovery: Recovery): void {
    this.recovery = recovery;
    const { loss } = this.connection;
    if (loss !== undefined) {
      this.onLoss(this.connection, loss);
    }
  }

  async shutdown(): Promise<ShutdownOutcome> {
    this.shuttingDown = true;
    clearTimeout(this.stuckTimer);
    if (this.cancelled) {
      return { ...(await this.connection.terminate()), forced: true, answered: false };
    }
    await this.restarting;
    return shutdownAdapter(this.connection, this.timeoutMs);
  }

  cancel(): void {
    this.shuttingDown = true;
    this.cancelled = true;
    clearTimeout(this.stuckTimer);
    this.connection.abandonAll(this.declared.capabilities.cancel);
    // An answer that still arrives goes to `onLate`, which only corrects the cost.
    for (const giveUp of [...this.waiters]) {
      giveUp();
    }
    void this.connection.terminate();
  }

  /** Called once per lost process; only the running process of a supervised client counts. */
  private onLoss(connection: Connection, loss: Loss): void {
    const { recovery } = this;
    // Once requests are refused, no new process follows a loss, so there is nothing to report.
    if (
      connection !== this.connection ||
      recovery === undefined ||
      this.shuttingDown ||
      this.refusal !== undefined
    ) {
      return;
    }
    clearTimeout(this.stuckTimer);
    this.lossesInARow += 1;
    if (this.lossesInARow >= LOSSES_IN_A_ROW) {
      this.refusal = loss.message;
      recovery.onFault({ kind: 'crashed', ...loss });
    } else {
      recovery.onFault({ kind: 'restarting', ...loss });
    }
  }

  private lossMessage(): string {
    return this.connection.loss?.message ?? 'the adapter is not running';
  }

  /** Makes `connection` the running process and counts its loss, also one before this call. */
  private install(connection: Connection): void {
    this.connection = connection;
    connection.watch((lost, loss) => {
      this.onLoss(lost, loss);
    });
    if (connection.loss !== undefined) {
      this.onLoss(connection, connection.loss);
    }
  }

  /** The process that takes requests, if any. */
  private running(): Connection | undefined {
    return this.refusal === undefined && this.connection.loss === undefined
      ? this.connection
      : undefined;
  }

  /**
   * The running process, else a new one; none once requests are refused. A new process lost
   * before the request goes out is replaced again, and each loss counts towards the limit.
   */
  private async usable(): Promise<Connection | undefined> {
    const { recovery } = this;
    for (;;) {
      const running = this.running();
      if (
        running !== undefined ||
        this.refusal !== undefined ||
        recovery === undefined ||
        this.shuttingDown
      ) {
        return running;
      }
      this.restarting ??= this.restart(recovery).finally(() => {
        this.restarting = undefined;
      });
      await this.restarting;
    }
  }

  private async restart(recovery: Recovery): Promise<void> {
    const toolPaths = await recovery.toolPaths().then(
      (paths) => ({ ok: true as const, paths }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!toolPaths.ok) {
      const reason =
        toolPaths.error instanceof Error ? toolPaths.error.message : String(toolPaths.error);
      this.refuse({
        kind: 'tool-paths-failed',
        message: `the toolPaths of the restart could not be listed: ${reason}`,
      });
      return;
    }
    const launched = await launch(
      this.options,
      { ...this.options.initialize, toolPaths: [...toolPaths.paths] },
      this.ids,
    );
    if (!launched.ok) {
      this.refuse(launched.error);
      return;
    }
    this.declared = launched.info;
    const changes = adapterChanges(this.info, launched.info);
    if (changes.length > 0) {
      this.refusal = `the restarted adapter declares a different ${changes.join(', ')}`;
      recovery.onFault({ kind: 'restart-changed', changes });
    }
    this.install(launched.connection);
    // A process already lost at install was reported as a loss; it never ran.
    if (changes.length === 0 && launched.connection.loss === undefined) {
      recovery.onFault({ kind: 'restarted', toolPaths: toolPaths.paths });
    }
  }

  private refuse(error: StartFailure): void {
    this.refusal = error.message;
    this.recovery?.onFault({ kind: 'restart-failed', error });
  }

  /** The response, or `timed-out` at the time limit; a later response goes to `onLate`. */
  private answer(
    connection: Connection,
    sent: Sent,
    options: GenerateOptions,
  ): Promise<GenerateOutcome> {
    return new Promise((resolve) => {
      let waiting = true;
      const stopWaiting = (outcome: GenerateOutcome): void => {
        waiting = false;
        clearTimeout(timer);
        this.waiters.delete(giveUp);
        resolve(outcome);
      };
      const giveUp = (): void => {
        stopWaiting({ kind: 'timed-out', message: 'the tool gave the request up' });
      };
      const timer = setTimeout(() => {
        if (sent.id !== undefined) {
          this.abandon(connection, sent.id);
        }
        stopWaiting({
          kind: 'timed-out',
          message: `no response to generate within ${String(this.timeoutMs)} ms`,
        });
      }, this.timeoutMs);
      this.waiters.add(giveUp);
      void sent.response.then((response) => {
        clearTimeout(timer);
        if (response.kind !== 'lost' && connection === this.connection) {
          this.lossesInARow = 0;
        }
        const outcome = toOutcome(response, readGenerate);
        if (waiting) {
          stopWaiting(outcome);
        } else if (outcome.kind !== 'lost') {
          options.onLate?.(outcome);
        }
      });
    });
  }

  /**
   * Sends `cancel` when declared. Once every slot holds an abandoned request, the process gets
   * one more time limit before it is replaced.
   */
  private abandon(connection: Connection, id: number): void {
    if (connection !== this.connection) {
      return;
    }
    connection.abandon(id, this.declared.capabilities.cancel);
    if (connection.abandoned < this.concurrency) {
      return;
    }
    clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => {
      if (connection === this.connection && connection.abandoned >= this.concurrency) {
        connection.abort(
          `all ${String(this.concurrency)} requests in flight went without an answer for another ${String(this.timeoutMs)} ms`,
        );
      }
    }, this.timeoutMs);
  }
}

/** One adapter process: line framing, request IDs and process lifetime. */
class Connection {
  readonly spawned: Promise<{ ok: true } | { ok: false; message: string }>;
  private readonly pending = new Map<number, (response: RawResponse) => void>();
  /** Requests abandoned at the time limit that have not answered yet. */
  private readonly abandonedIds = new Set<number>();
  private readonly exited: Promise<Exit>;
  private terminating: Promise<Exit> | undefined;
  private lost: Loss | undefined;
  private listener: LossListener | undefined;
  private stdoutBuffer = '';
  private stderrBuffer = '';

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: StartOptions,
    private readonly ids: () => number,
  ) {
    endWithTool(this);
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
        running.delete(this);
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

  /** Why the process was lost, once it was. */
  get loss(): Loss | undefined {
    return this.lost;
  }

  /** The protocol violation that ended the connection, if one did. */
  get violation(): string | undefined {
    return this.lost?.cause === 'violation' ? this.lost.message : undefined;
  }

  get abandoned(): number {
    return this.abandonedIds.size;
  }

  /** `listener` hears of the loss of this process, once, if it happens after this call. */
  watch(listener: LossListener): void {
    this.listener = listener;
  }

  /** Writes a request; its response, or `lost`, settles `response` whenever it comes. */
  send(method: string, params?: RequestParams, onRequest?: (id: number) => void): Sent {
    if (this.lost !== undefined) {
      return { id: undefined, response: Promise.resolve({ kind: 'lost', ...this.lost }) };
    }
    const id = this.ids();
    onRequest?.(id);
    const response = new Promise<RawResponse>((resolve) => {
      this.pending.set(id, resolve);
    });
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return { id, response };
  }

  /** A request whose answer after `timeoutMs` breaks the protocol, since nobody waits for it. */
  async request(method: string, params?: RequestParams, timeoutMs?: number): Promise<RawResponse> {
    const sent = this.send(method, params);
    if (timeoutMs === undefined || sent.id === undefined) {
      return sent.response;
    }
    const { id } = sent;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<RawResponse>((resolve) => {
      timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          kind: 'lost',
          cause: 'timeout',
          message: `no response to ${method} within ${String(timeoutMs)} ms`,
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([sent.response, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Nobody waits for request `id` any more; its late response is still expected. */
  abandon(id: number, cancel: boolean): void {
    if (!this.pending.has(id)) {
      return;
    }
    this.abandonedIds.add(id);
    if (cancel) {
      const params: CancelParams = { id };
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'cancel', params })}\n`);
    }
  }

  /** Nobody waits for any request in flight any more. */
  abandonAll(cancel: boolean): void {
    for (const id of this.pending.keys()) {
      this.abandon(id, cancel);
    }
  }

  /** Gives the process up: requests in flight are lost and the process is signalled. */
  abort(message: string): void {
    this.lose('stuck', message);
    void this.terminate();
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
      this.signal('SIGTERM');
      const exit = await Promise.race([this.exited, delay(this.graceMs)]);
      if (exit !== undefined) {
        return exit;
      }
      this.signal('SIGKILL');
      return this.exited;
    })();
    return this.terminating;
  }

  /** Signals the adapter's process group, so processes it started end with it. */
  signal(signal: NodeJS.Signals): void {
    const { pid } = this.child;
    // Also after the adapter exited: POSIX reuses no ID while a group of that ID has members.
    if (!OWN_GROUP || pid === undefined) {
      this.child.kill(signal);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // ESRCH: every process of the group has ended.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw error;
      }
    }
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
    this.abandonedIds.delete(id);
    resolve?.(response);
    return resolve !== undefined;
  }

  private violate(message: string): void {
    this.lose('violation', message);
    void this.terminate();
  }

  private lose(cause: LossCause, message: string): void {
    if (this.lost !== undefined) {
      return;
    }
    const lost = { cause, message };
    this.lost = lost;
    for (const resolve of this.pending.values()) {
      resolve({ kind: 'lost', ...lost });
    }
    this.pending.clear();
    this.abandonedIds.clear();
    this.listener?.(this, lost);
  }
}

/** Adapter processes that have not ended, whose groups are killed when the tool exits. */
const running = new Set<Connection>();
let killOnExit = false;

/**
 * Whatever way the tool exits (an uncaught failure included), no adapter group outlives it; a
 * normal end has shut every adapter down before.
 */
function endWithTool(connection: Connection): void {
  running.add(connection);
  if (!killOnExit) {
    killOnExit = true;
    process.once('exit', () => {
      for (const each of running) {
        each.signal('SIGKILL');
      }
    });
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
