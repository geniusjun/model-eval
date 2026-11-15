import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { canonicalJson } from '../adapter/canonical-json.js';
import { PROTOCOL_VERSION } from '../adapter/protocol-version.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../adapter/json-types.js';
import { BUNDLED_HELPER_VERSION } from '../lint/helper-version.js';
import { asCount, asDict, asList, asStr, isBlocked } from './capture.js';
import { CURRENT_TRIAL, HUB, KEPT_MS, Trial, trialKey, waitFor, yieldToLoop } from './context.js';
import { exceptionText, message } from './messages.js';
import {
  type Call,
  callRecord,
  type Case,
  configResult,
  costOf,
  type Decided,
  decide,
  type DiscardOn,
  isFallback,
  isModelCallError,
  isResult,
  freeze,
  type FunctionEnd,
  inSendOrder,
  milliseconds,
  type RenderFunction,
  type Seen,
  type Target,
  type TargetFunction,
  trialViews,
  type Variant,
} from './outcome.js';
import { renderDecision, renderFunctionDecision } from './render.js';
import { serviceVersion } from './service.js';
import { writeProtocol } from './stdout.js';

// Adapter protocol v1 over stdio (001 adapter-protocol §Transport, §Methods) for the target
// functions of `defineAdapter`; helper-api §Cancel.

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const ADAPTER_ERROR = -32000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** helper-api §Target Options. */
export interface TargetOptions {
  readonly languages?: readonly string[];
  readonly inputSchema?: JsonValue;
  readonly render?: boolean | RenderFunction;
  readonly discardOn?: DiscardOn;
  readonly replyCall?: (call: Call) => unknown;
  readonly answerTool?: readonly [string, string];
  readonly postprocess?: boolean;
  readonly generate: TargetFunction;
}

/** helper-api §Adapter Options. */
export interface AdapterOptions {
  readonly name: string;
  readonly version: string;
  readonly serviceDir?: string;
  readonly maxConcurrency?: number;
  readonly targets: Readonly<Record<string, TargetOptions>>;
}

export interface Adapter {
  /** Serves the protocol on the process's stdio until `shutdown` or the end of stdin. */
  listen(): void;
}

/** An adapter process that answers the tool's requests with the given target functions. */
export function defineAdapter(options: AdapterOptions): Adapter {
  const targets = new Map<string, Target>();
  for (const [name, target] of Object.entries(options.targets)) {
    targets.set(name, {
      name,
      generate: target.generate,
      languages: target.languages,
      inputSchema: target.inputSchema ?? true,
      render: target.render ?? false,
      discardOn: target.discardOn ?? [],
      replyCall: target.replyCall,
      answerTool: target.answerTool,
      postprocess: target.postprocess ?? true,
    });
  }
  return {
    listen() {
      new Server(options, targets).listen();
    },
  };
}

/** The third argument of a target function: the trial's calls, read when it is used. */
function liveCalls(trial: Trial): readonly Call[] {
  return new Proxy([] as Call[], {
    get(_target, property) {
      const views = trialViews(trial);
      const value: unknown = Reflect.get(views, property);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(views)
        : value;
    },
    has(_target, property) {
      return Reflect.has(trialViews(trial), property);
    },
  });
}

class Server {
  private variant: Variant = { id: '', model: '', params: {} };
  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private readonly tasks = new Set<Promise<void>>();
  private lastWrite: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(
    private readonly options: AdapterOptions,
    private readonly targets: ReadonlyMap<string, Target>,
  ) {}

  listen(): void {
    HUB.flush = () => {
      this.flushNotifications(false);
    };
    process.on('unhandledRejection', (reason) => {
      // L2 for an unhandled rejection in background work; L3 when a cut or blocked request of an
      // abandoned trial caused it.
      const id = isBlocked(reason) ? 'L3' : 'L2';
      this.log(message(id, { exception: exceptionText(reason) }));
    });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', (line) => {
      this.received(line);
    });
    lines.on('close', () => {
      void this.inputEnded();
    });
  }

  /** stdin closed: the requests already read are answered, then the process ends. */
  private async inputEnded(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
    await this.stop();
  }

  private async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    await this.lastWrite.catch(() => undefined);
    process.exit(0);
  }

  // Messages

  private received(line: string): void {
    if (line.trim() === '') {
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      this.sendError(null, PARSE_ERROR, 'The line is not JSON.');
      return;
    }
    if (!isJsonObject(request as JsonValue) || (request as JsonObject)['jsonrpc'] !== '2.0') {
      this.sendError(null, INVALID_REQUEST, 'The message is not a JSON-RPC 2.0 object.');
      return;
    }
    const body = request as JsonObject;
    const method = body['method'];
    const params = asDict(body['params']);
    const requestId = body['id'];
    if (requestId === undefined || requestId === null) {
      if (method === 'cancel') {
        this.cancel(params['id']);
      }
      return;
    }
    const handlers = new Map<string, (id: JsonValue, params: JsonObject) => Promise<void>>([
      ['initialize', (id, p) => this.initialize(id, p)],
      ['generate', (id, p) => this.generate(id, p)],
      ['shutdown', (id) => this.shutdown(id)],
      ['render', (id, p) => this.render(id, p)],
    ]);
    const handler = typeof method === 'string' ? handlers.get(method) : undefined;
    if (handler === undefined) {
      this.sendError(
        requestId,
        METHOD_NOT_FOUND,
        `Unknown method ${method === undefined ? 'None' : textOf(method)}.`,
      );
      return;
    }
    const task = this.answer(handler, requestId, params);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async answer(
    handler: (id: JsonValue, params: JsonObject) => Promise<void>,
    requestId: JsonValue,
    params: JsonObject,
  ): Promise<void> {
    try {
      await handler(requestId, params);
    } catch (error) {
      this.sendError(requestId, ADAPTER_ERROR, `The helper failed: ${exceptionText(error)}`);
    }
  }

  private send(value: JsonObject): void {
    const line = `${canonicalJson(value)}\n`;
    const written = this.lastWrite.then(() => writeProtocol(line));
    this.lastWrite = written.catch(() => undefined);
  }

  private sendResult(requestId: JsonValue, result: JsonValue): void {
    this.send({ jsonrpc: '2.0', id: requestId, result });
  }

  private sendError(requestId: JsonValue, code: number, text: string, data?: JsonObject): void {
    const error: Record<string, JsonValue> = { code, message: text };
    if (data !== undefined) {
      error['data'] = data;
    }
    this.send({ jsonrpc: '2.0', id: requestId, error });
  }

  private sendDecided(requestId: JsonValue, decided: Decided): void {
    if (decided.kind === 'result') {
      this.sendResult(requestId, decided.result);
    } else {
      this.sendError(requestId, ADAPTER_ERROR, decided.message, decided.data);
    }
  }

  private log(text: string): void {
    this.send({ jsonrpc: '2.0', method: 'log', params: { level: 'warn', message: text } });
  }

  // initialize

  private async initialize(requestId: JsonValue, params: JsonObject): Promise<void> {
    const variant = asDict(params['variant']);
    this.variant = {
      id: textOf(variant['id']),
      model: textOf(variant['model']),
      params: asDict(variant['params']),
    };
    this.timeoutMs = asCount(params['timeoutMs']) || this.timeoutMs;
    const toolPaths = asList(params['toolPaths']).map((path) => textOf(path));
    const version = await serviceVersion(this.options.serviceDir, toolPaths);
    if (version.reason !== undefined) {
      this.log(message('L1', { reason: version.reason }));
    }
    const targets = [...this.targets.values()];
    const capabilities: Record<string, JsonValue> = {
      render: targets.some(renders),
      stages: true,
      postprocess: targets.length === 0 || targets.some((target) => target.postprocess),
      cancel: true,
    };
    if (this.options.maxConcurrency !== undefined) {
      capabilities['maxConcurrency'] = this.options.maxConcurrency;
    }
    const result: Record<string, JsonValue> = {
      protocolVersion: PROTOCOL_VERSION,
      adapter: {
        name: this.options.name,
        version: this.options.version,
        helper: { language: 'typescript', version: BUNDLED_HELPER_VERSION },
      },
      targets: targets.map(targetDescription),
      capabilities,
    };
    if (Object.keys(version.service).length > 0) {
      result['service'] = { ...version.service };
    }
    this.sendResult(requestId, result);
  }

  // render

  /**
   * helper-api §Render Mode: runs the target with `case.rendering`, or the adapter's render
   * function, and answers with the render result. A target without render mode is A15.
   */
  private async render(requestId: JsonValue, params: JsonObject): Promise<void> {
    const target = this.targets.get(textOf(params['target']));
    if (target === undefined) {
      this.sendError(requestId, INVALID_PARAMS, `Unknown target ${textOf(params['target'])}.`);
      return;
    }
    if (!renders(target)) {
      this.sendError(requestId, ADAPTER_ERROR, message('A15'), {});
      return;
    }
    const trial = this.newTrial(requestId, target, params, true);
    let decided: Decided;
    try {
      if (typeof target.render === 'function') {
        decided = await this.renderByFunction(trial, target.render);
      } else {
        await this.runFunction(trial);
        decided = renderDecision(trial);
      }
    } finally {
      this.endTrial(trial);
    }
    this.sendDecided(requestId, decided);
  }

  /**
   * A render function run like the service function in render mode, in the render's trial
   * context, its captured requests answered with the render-mode 400.
   */
  private async renderByFunction(trial: Trial, render: RenderFunction): Promise<Decided> {
    let ended: { readonly value: unknown } | { readonly thrown: unknown };
    try {
      ended = {
        value: await CURRENT_TRIAL.run(trial, () => render(trial.testCase, trial.variant)),
      };
    } catch (error) {
      ended = { thrown: error };
    } finally {
      trial.state = 'waiting';
    }
    return renderFunctionDecision(trial, ended);
  }

  // generate

  private async generate(requestId: JsonValue, params: JsonObject): Promise<void> {
    const target = this.targets.get(textOf(params['target']));
    if (target === undefined) {
      this.sendError(requestId, INVALID_PARAMS, `Unknown target ${textOf(params['target'])}.`);
      return;
    }
    const trial = this.newTrial(requestId, target, params, false);
    try {
      const end = await this.runFunction(trial);
      if (trial.cancelled) {
        this.sendCancelled(trial);
      } else {
        await this.finish(trial, end);
      }
    } finally {
      this.endTrial(trial);
      this.flushNotifications(false);
    }
  }

  private newTrial(requestId: JsonValue, target: Target, params: JsonObject, rendering: boolean) {
    const c: Case = {
      id: textOf(params['caseId']),
      lang: asStr(params['lang']),
      input: asDict(params['input']),
      repeat: rendering ? 0 : asCount(params['repeat']) || 0,
      seed: asCount(params['seed']) || 0,
      rendering,
    };
    const trial = new Trial(requestId, target, c, this.variant, this.timeoutMs);
    HUB.trials.set(trialKey(requestId), trial);
    return trial;
  }

  private endTrial(trial: Trial): void {
    trial.state = 'sent';
    HUB.trials.delete(trialKey(trial.requestId));
  }

  private async runFunction(trial: Trial): Promise<FunctionEnd> {
    const target = trial.target;
    let value: unknown;
    try {
      value = await CURRENT_TRIAL.run(trial, () =>
        target.generate(trial.testCase, trial.variant, liveCalls(trial)),
      );
    } catch (error) {
      // A `ModelCallError` is the adapter's report of a call failure, never a service exception,
      // so `discardOn` is not consulted for it.
      return isModelCallError(error) ? { thrown: error } : { error: { thrown: error } };
    } finally {
      trial.functionEndedAt = performance.now();
      if (trial.state === 'running') {
        trial.state = 'waiting';
      }
    }
    if (isFallback(value) && typeof value.text === 'string') {
      return { value: value.text, isFallback: true };
    }
    if (typeof value === 'string') {
      return { value };
    }
    if (isResult(value)) {
      return { result: value };
    }
    return { notText: true };
  }

  /** Waits for the trial's unfinished calls, then sends its result. */
  private async finish(trial: Trial, end: FunctionEnd): Promise<void> {
    const latency = milliseconds((trial.functionEndedAt ?? trial.started) - trial.started);
    await yieldToLoop();
    const calls = inSendOrder(trial.calls);
    const seens = calls.map(freeze);
    await waitFor(
      () => trial.cancelled || !calls.some((call) => call.inFlight()),
      trial.deadline(),
    );
    if (trial.cancelled) {
      this.sendCancelled(trial, seens);
      return;
    }
    const finals = seens.map((seen) => (seen.state === 'unfinished' ? freeze(seen.call) : seen));
    let decided: Decided;
    try {
      decided = decide(trial, end, seens, finals, latency);
    } catch (error) {
      this.sendDecisionFailure(trial, error, seens, finals, latency);
      return;
    }
    this.sendDecided(trial.requestId, decided);
  }

  // cancel

  /**
   * helper-api §Cancel: later requests of the trial are not sent and its calls in flight are cut
   * as `unanswered`. A Node target function cannot be stopped; it ends when its requests fail.
   */
  private cancel(requestId: JsonValue | undefined): void {
    // helper-api §Shared Conventions: only an integer names a trial; JSON 1.0 is 1.
    const trial =
      typeof requestId === 'number' && Number.isSafeInteger(requestId)
        ? HUB.trials.get(trialKey(requestId))
        : undefined;
    if (trial === undefined || (trial.state !== 'running' && trial.state !== 'waiting')) {
      return;
    }
    trial.cancelled = true;
    for (const call of trial.calls) {
      if (call.inFlight()) {
        call.cutNow();
      }
    }
  }

  /**
   * data-model §Outcome Decision, decision failure: Outcome row 1 when a call failed with
   * `config` (unless classifying failed too), else adapter error A16 with the calls.
   */
  private sendDecisionFailure(
    trial: Trial,
    error: unknown,
    seens: readonly Seen[],
    finals: readonly Seen[],
    latency: number,
  ): void {
    const result = configResult(finals, seens, latency);
    if (result !== undefined) {
      this.sendResult(trial.requestId, result);
      return;
    }
    const text = message('A16', { exception: exceptionText(error) });
    this.sendError(trial.requestId, ADAPTER_ERROR, text, costOf(finals, seens));
  }

  /**
   * helper-api §Cancel: the response to a cancelled trial, sent without waiting for calls: a
   * failure result with its calls, `config` when a call failed so (Outcome row 1), else `timeout`
   * with F2. `returned` holds the calls as they were when the function returned, when it returned
   * before the cancel.
   */
  private sendCancelled(trial: Trial, returned?: readonly Seen[]): void {
    const finals = inSendOrder(trial.calls).map(freeze);
    const latency = milliseconds((trial.functionEndedAt ?? trial.started) - trial.started);
    const result = configResult(finals, returned, latency) ?? {
      error: { kind: 'timeout', message: message('F2') },
      latencyMs: latency,
      ...costOf(finals, returned),
    };
    this.sendResult(trial.requestId, result);
  }

  // Notifications

  private flushNotifications(force: boolean): void {
    for (const call of HUB.unreported(force)) {
      const params: Record<string, JsonValue> = {
        calls: [callRecord(freeze(call), undefined)],
      };
      if (call.trial !== undefined) {
        params['id'] = call.trial.requestId;
      }
      this.send({ jsonrpc: '2.0', method: 'calls', params });
    }
  }

  // shutdown

  /**
   * Waits for running trials and for calls no result included, reports them, then answers (001
   * adapter-protocol §`shutdown`).
   */
  private async shutdown(requestId: JsonValue): Promise<void> {
    const deadline = performance.now() + this.timeoutMs - KEPT_MS;
    const others = [...this.tasks];
    if (others.length > 0) {
      const left = Math.max(deadline - performance.now(), 0);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(others),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
    await waitFor(() => !HUB.notifiedInFlight(), deadline);
    this.flushNotifications(true);
    this.sendResult(requestId, null);
    await this.stop();
  }
}

function renders(target: Target): boolean {
  return target.render !== false;
}

function targetDescription(target: Target): JsonObject {
  const description: Record<string, JsonValue> = { name: target.name };
  if (target.languages !== undefined) {
    description['languages'] = [...target.languages];
  }
  description['inputSchema'] = target.inputSchema;
  return description;
}

function textOf(value: JsonValue | undefined): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : canonicalJson(value);
}
