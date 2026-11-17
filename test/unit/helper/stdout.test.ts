import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STDOUT_MODULE = fileURLToPath(new URL('../../../src/helper/stdout.ts', import.meta.url));

describe('stdout protection', () => {
  it('003 FR-002 process.stdout.write and console go to stderr, the protocol writer to stdout', () => {
    const script = [
      `const { writeProtocol } = await import(${JSON.stringify(STDOUT_MODULE)});`,
      `process.stdout.write('written\\n');`,
      `console.log('logged');`,
      `console.info('informed');`,
      `console.table([1]);`,
      `await writeProtocol('{"jsonrpc":"2.0"}\\n');`,
    ].join('\n');
    const done = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module'], {
      input: script,
      encoding: 'utf8',
    });
    expect(done.status).toBe(0);
    expect(done.stdout).toBe('{"jsonrpc":"2.0"}\n');
    expect(done.stderr).toContain('written\n');
    expect(done.stderr).toContain('logged\n');
    expect(done.stderr).toContain('informed\n');
  });
});
