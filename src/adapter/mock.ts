import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { parse as parseYaml } from 'yaml';

import {
  cancelParamsSchema,
  generateParamsSchema,
  initializeParamsSchema,
  renderParamsSchema,
  rpcNotificationSchema,
  rpcRequestSchema,
  type ProtocolVariant,
} from './protocol.js';
import {
  behaviourFor,
  delayFor,
  fill,
  generateAction,
  initializeResult,
  renderCase,
  scenarioSchema,
  type MockReply,
} from './mock-scenario.js';

// The mock adapter: `node dist/adapter/mock.js <scenario.yaml>`. It never calls a model.

const scenarioPath = process.argv[2];
if (scenarioPath === undefined) {
  process.stderr.write('usage: mock.js <scenario.yaml>\n');
  process.exit(2);
}
const scenario = scenarioSchema.parse(parseYaml(readFileSync(scenarioPath, 'utf8')));

process.stderr.write(`mock: started pid=${String(process.pid)}\n`);
if (scenario.startNoise !== undefined) {
  process.stdout.write(`${scenario.startNoise}\n`);
}

let variant: ProtocolVariant | undefined;
let inFlight = 0;
/** `generate` requests per trial key, for outcomes limited to the first sends. */
const sends = new Map<string, number>();
/** Background work still to report, which `shutdown` waits for. */
const background = new Set<Promise<void>>();
/** Answers held back by `late` and `hang` rows; a declared `cancel` sends them at once. */
const heldBack = new Map<number, () => void>();
/** `generate` requests whose row is not drawn yet. */
const drawing = new Set<number>();
/** Requests cancelled before their row was drawn, answered as soon as they are held back. */
const cancelled = new Set<number>();

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sendReply(id: number, reply: MockReply): void {
  send('result' in reply ? { id, result: reply.result } : { id, error: reply.error });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether an earlier process of this variant started, counted in `MOCK_STATE_DIR` when it is
 * set, so a scenario's `restarted` declaration applies from the second process on.
 */
function countStart(variantId: string): boolean {
  const dir = process.env.MOCK_STATE_DIR;
  if (dir === undefined) {
    return false;
  }
  const file = path.join(dir, `mock-starts-${variantId}`);
  let starts = 0;
  try {
    starts = Number(readFileSync(file, 'utf8'));
  } catch {
    // The first process of this variant.
  }
  writeFileSync(file, String(starts + 1));
  return starts > 0;
}

/** Holds `reply` back until `delayMs` passes, or forever without it, or a declared `cancel`. */
function holdBack(id: number, reply: MockReply, delayMs: number | undefined): void {
  const answered = new Promise<void>((resolve) => {
    const answer = (): void => {
      if (heldBack.delete(id)) {
        sendReply(id, reply);
        resolve();
      }
    };
    heldBack.set(id, answer);
    if (cancelled.delete(id)) {
      answer();
    } else if (delayMs !== undefined) {
      setTimeout(answer, delayMs);
    }
  });
  // A late answer comes before the `shutdown` response, like other unfinished work.
  if (delayMs !== undefined) {
    background.add(answered);
    void answered.finally(() => background.delete(answered));
  }
}

function crash(caseId: string): never {
  process.stderr.write(`mock: exiting on ${caseId}\n`);
  process.exit(1);
}

function onNotification(method: string, params: unknown): void {
  if (method !== 'cancel') {
    return;
  }
  const { id } = cancelParamsSchema.parse(params);
  process.stderr.write(`mock: cancel ${String(id)}\n`);
  if (!scenario.capabilities.cancel) {
    return;
  }
  const answer = heldBack.get(id);
  if (answer !== undefined) {
    answer();
  } else if (drawing.has(id)) {
    cancelled.add(id);
  }
}

async function handle(id: number, method: string, params: unknown): Promise<void> {
  switch (method) {
    case 'initialize': {
      variant = initializeParamsSchema.parse(params).variant;
      const restarted = countStart(variant.id);
      const exit = restarted ? scenario.restarted?.exit : undefined;
      if (exit === 'at-start') {
        process.stderr.write('mock: exiting before initialize\n');
        process.exit(2);
      }
      const result = initializeResult(scenario, restarted);
      if (exit === 'after-initialize') {
        // The write callback runs once the answer is flushed, so it reaches the tool first.
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, () => {
          process.exit(2);
        });
        return;
      }
      send({ id, result });
      return;
    }
    case 'render': {
      const request = renderParamsSchema.parse(params);
      const caseId = request.caseId ?? '';
      await wait(scenario.renderDelayMs);
      if (scenario.renderExits.includes(caseId)) {
        process.exit(3);
      }
      if (scenario.renderInvalid.includes(caseId)) {
        send({ id, result: { messages: [] } });
        return;
      }
      if (scenario.renderErrors.includes(caseId)) {
        send({ id, error: { code: -32603, message: `mock render failed for ${caseId}` } });
        return;
      }
      const behaviour = variant === undefined ? undefined : behaviourFor(scenario, variant);
      const result = renderCase(scenario, request, behaviour);
      if (scenario.renderThenExit.includes(caseId)) {
        // The write callback runs once the answer is flushed, so it reaches the tool first.
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, () => {
          process.exit(0);
        });
        return;
      }
      send({ id, result });
      return;
    }
    case 'generate': {
      if (variant === undefined) {
        send({ id, error: { code: -32600, message: 'generate before initialize' } });
        return;
      }
      const request = generateParamsSchema.parse(params);
      const key = `${request.caseId}:${String(request.repeat)}`;
      const count = (sends.get(key) ?? 0) + 1;
      sends.set(key, count);
      drawing.add(id);
      const behaviour = behaviourFor(scenario, variant);
      const { beforeCalls, afterCalls, afterCallsDelayMs } = behaviour;
      if (behaviour.stderr !== undefined) {
        process.stderr.write(`${fill(behaviour.stderr, request)}\n`);
      }
      for (const log of behaviour.logs) {
        send({ method: 'log', params: { level: log.level, message: fill(log.message, request) } });
      }
      inFlight += 1;
      if (scenario.reportInflight) {
        send({
          method: 'log',
          params: { level: 'debug', message: `inflight ${String(inFlight)}` },
        });
      }
      await wait(delayFor(scenario, variant, request.seed));
      inFlight -= 1;
      if (beforeCalls.length > 0) {
        send({ method: 'calls', params: { id, calls: beforeCalls } });
      }
      drawing.delete(id);
      const action = generateAction(scenario, variant, request, count);
      if (action.kind !== 'late') {
        cancelled.delete(id);
      }
      switch (action.kind) {
        case 'crash':
          return crash(request.caseId);
        case 'noise':
          process.stdout.write(`${action.line}\n`);
          return;
        case 'late':
          holdBack(id, action.reply, action.delayMs);
          return;
        case 'broken':
          send({ id, result: action.result });
          return;
        case 'reply':
          sendReply(id, action.reply);
      }
      if (afterCalls.length > 0) {
        const report = wait(afterCallsDelayMs).then(() => {
          send({ method: 'calls', params: { id, calls: afterCalls } });
        });
        background.add(report);
        void report.finally(() => background.delete(report));
      }
      return;
    }
    case 'shutdown':
      process.stderr.write('mock: shutdown\n');
      if (scenario.shutdownReply === 'ignore') {
        return;
      }
      if (scenario.shutdownReply === 'exit') {
        process.exit(0);
      }
      if (scenario.shutdownReply === 'error') {
        send({ id, error: { code: -32603, message: 'mock shutdown failed' } });
        lines.close();
        return;
      }
      if (scenario.shutdownReply === 'stray') {
        process.stdout.write('shutting down\n');
      }
      await Promise.all(background);
      if (scenario.shutdownCalls.length > 0) {
        send({ method: 'calls', params: { calls: scenario.shutdownCalls } });
      }
      send({ id, result: null });
      lines.close();
      return;
    default:
      send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message: unknown = JSON.parse(line);
  const request = rpcRequestSchema.safeParse(message);
  if (!request.success) {
    const notification = rpcNotificationSchema.parse(message);
    onNotification(notification.method, notification.params);
    return;
  }
  const { id, method, params } = request.data;
  handle(id, method, params).catch((error: unknown) => {
    send({
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
    });
  });
});
