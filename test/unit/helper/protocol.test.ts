import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HELPER = fileURLToPath(new URL('../../../src/helper/index.ts', import.meta.url));

/** The protocol lines an adapter with one target writes for the given request lines. */
function exchange(lines: readonly object[]): unknown[] {
  const script = [
    `const { defineAdapter } = await import(${JSON.stringify(HELPER)});`,
    `defineAdapter({ name: 'a', version: '0.0.1', targets: { chat: { generate: () => 'Hi.' } } }).listen();`,
  ].join('\n');
  const done = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      input: lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      encoding: 'utf8',
    },
  );
  expect(done.status).toBe(0);
  return done.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('protocol server', () => {
  it('003 FR-001 methods inherited from Object are unknown methods', () => {
    const responses = exchange([
      { jsonrpc: '2.0', id: 1, method: 'toString' },
      { jsonrpc: '2.0', id: 2, method: 'constructor' },
      { jsonrpc: '2.0', id: 3, method: '__proto__' },
    ]);
    expect(responses).toEqual(
      [1, 2, 3].map((id) => ({
        jsonrpc: '2.0',
        id,
        error: expect.objectContaining({ code: -32601 }) as unknown,
      })),
    );
  });
});
