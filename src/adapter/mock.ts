import { readFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

import { parse as parseYaml } from 'yaml';

import {
  generateParamsSchema,
  initializeParamsSchema,
  renderParamsSchema,
  rpcRequestSchema,
  type ProtocolVariant,
} from './protocol.js';
import {
  behaviourFor,
  delayFor,
  generateTrial,
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

let variant: ProtocolVariant | undefined;
let inFlight = 0;
/** `generate` requests per trial key, for outcomes limited to the first sends. */
const sends = new Map<string, number>();
/** Background work still to report, which `shutdown` waits for. */
const background = new Set<Promise<void>>();

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sendReply(id: number, reply: MockReply): void {
  send('result' in reply ? { id, result: reply.result } : { id, error: reply.error });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handle(id: number, method: string, params: unknown): Promise<void> {
  switch (method) {
    case 'initialize':
      variant = initializeParamsSchema.parse(params).variant;
      send({ id, result: initializeResult(scenario) });
      return;
    case 'render': {
      const request = renderParamsSchema.parse(params);
      if (request.caseId !== undefined && scenario.renderErrors.includes(request.caseId)) {
        send({ id, error: { code: -32603, message: `mock render failed for ${request.caseId}` } });
        return;
      }
      send({ id, result: renderCase(scenario, request) });
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
      const { beforeCalls, afterCalls, afterCallsDelayMs } = behaviourFor(scenario, variant);
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
      sendReply(id, generateTrial(scenario, variant, request, count));
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
  const request = rpcRequestSchema.safeParse(JSON.parse(line));
  if (!request.success) {
    // Notifications such as cancel need no answer from this adapter.
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
