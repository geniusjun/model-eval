import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  jsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from '../../../../src/adapter/json-value.js';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const PYTHON_DIR = path.join(ROOT, 'adapters/python');
const SERVER = path.join(PYTHON_DIR, 'mock_api/server.py');
const START_TIMEOUT_MS = 10_000;

/** The interpreter of an environment built from a file of adapters/python/tests/requirements/. */
export function pythonInterpreter(): string {
  return process.env.MODEL_EVAL_PYTHON ?? 'python3';
}

/** One request the mock server received, as its request log records it. */
export const receivedRequestSchema = z
  .object({
    method: z.string(),
    path: z.string(),
    api: z.enum(['chat-completions', 'responses', 'messages']).nullable(),
    model: z.string().nullable(),
    stream: z.boolean(),
    headers: z.record(z.string(), z.string()),
    scripted: z.boolean(),
    servedEncoding: z.string().nullable(),
    waitTimedOut: z.string().optional(),
  })
  .loose();
export type ReceivedRequest = z.infer<typeof receivedRequestSchema>;

const logSchema = z.object({ requests: z.array(receivedRequestSchema) });
const tlsSchema = z.object({ port: z.int() });

/** The mock API server of adapters/python/mock_api/server.py, run in its own process. */
export class MockApi {
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly url: string,
  ) {}

  static async start(): Promise<MockApi> {
    const child = spawn(pythonInterpreter(), [SERVER, '--port', '0'], { stdio: 'pipe' });
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    const lines = createInterface({ input: child.stdout });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the mock API server did not start: ${stderr.join('')}`));
      }, START_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the mock API server exited with ${String(code)}: ${stderr.join('')}`));
      });
      lines.once('line', (line) => {
        clearTimeout(timer);
        const address = /http:\/\/[^\s]+/.exec(line)?.[0];
        if (address === undefined) {
          reject(new Error(`unexpected first line from the mock API server: ${line}`));
        } else {
          resolve(address);
        }
      });
    });
    lines.close();
    return new MockApi(child, url);
  }

  async load(script: readonly JsonValue[]): Promise<void> {
    await this.control('script', { requests: script });
  }

  async reset(): Promise<void> {
    await this.control('reset', {});
  }

  /**
   * The requests received since the script was loaded. Fails when a response or chunk held by
   * `afterRequests` or `chunkAfterRequests` gave up waiting, since the case then did not run the
   * scene its script describes.
   */
  async log(): Promise<ReceivedRequest[]> {
    const response = await fetch(`${this.url}/__mock__/log`);
    const requests = logSchema.parse(await response.json()).requests;
    requests.forEach((record, index) => {
      if (record.waitTimedOut !== undefined) {
        throw new Error(`mock server, request ${String(index + 1)}: ${record.waitTimedOut}`);
      }
    });
    return requests;
  }

  /** The base URL of a TLS listener that presents a certificate of test/fixtures/helper/tls/. */
  async tlsUrl(certificate: string): Promise<string> {
    const { port } = tlsSchema.parse(await this.control('tls', { certificate }));
    return `https://localhost:${String(port)}`;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) =>
      this.child.once('exit', () => {
        resolve();
      }),
    );
    this.child.kill('SIGTERM');
    await exited;
  }

  private async control(action: string, body: JsonObject): Promise<JsonObject> {
    const response = await fetch(`${this.url}/__mock__/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`mock API server ${action}: ${JSON.stringify(value)}`);
    }
    return jsonObjectSchema.parse(value);
  }
}
