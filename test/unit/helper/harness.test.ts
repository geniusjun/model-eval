import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdapterDriver,
  apiEnv,
  ProtocolViolation,
  requireLoopback,
  requirePythonSdk,
} from '../../contract/helper/support/driver.js';

// The safeguards of the helper contract harness, which no later test takes the failure path of.

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'helper-harness-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});

describe('helper contract harness', () => {
  it('003 SC-002 an adapter gets the mock base URLs, dummy keys, no proxy and no real token', () => {
    const parent = {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy.invalid:3128',
      https_proxy: 'http://proxy.invalid:3128',
      ALL_PROXY: 'socks5://proxy.invalid:1080',
      NO_PROXY: 'internal.invalid',
      ANTHROPIC_AUTH_TOKEN: 'real-token',
      OPENAI_ORG_ID: 'org-real',
      OPENAI_PROJECT_ID: 'proj-real',
      OPENAI_API_KEY: 'real-key',
      ANTHROPIC_API_KEY: 'real-key',
      OPENAI_BASE_URL: 'https://api.example.invalid/v1',
      UNSET: undefined,
    };
    expect(apiEnv('http://127.0.0.1:9', parent)).toEqual({
      PATH: '/usr/bin',
      NO_PROXY: '*',
      no_proxy: '*',
      OPENAI_API_KEY: 'test-openai-key',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
  });

  it.each([
    'http://0.0.0.0:9',
    'https://api.example.invalid',
    'http://127.0.0.1.example.invalid/v1',
    'http://10.0.0.1:9',
    'http://[::2]:9',
    '',
  ])('003 SC-002 refuses the base URL %j, which leaves the machine', (url) => {
    expect(() => {
      requireLoopback({ ...apiEnv('http://127.0.0.1:9', {}), ANTHROPIC_BASE_URL: url });
    }).toThrow(/ANTHROPIC_BASE_URL must be a loopback address/);
  });

  it.each(['http://127.0.0.1:9', 'http://127.5.6.7:9', 'http://[::1]:9', 'http://localhost:9'])(
    '003 SC-002 accepts the loopback base URL %s',
    (url) => {
      expect(() => {
        requireLoopback(apiEnv(url, {}));
      }).not.toThrow();
    },
  );

  it('003 SC-002 starts no adapter whose base URL leaves the machine', async () => {
    const service = path.join(folder, 'service.mjs');
    const marker = path.join(folder, 'started');
    await writeFile(
      service,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`,
    );
    const env = {
      ...apiEnv('http://127.0.0.1:9', {}),
      OPENAI_BASE_URL: 'https://api.example.invalid',
    };
    expect(() =>
      AdapterDriver.start({ language: 'typescript', service, sdk: 'openai-7', env }),
    ).toThrow(/OPENAI_BASE_URL must be a loopback address/);
    await expect(access(marker)).rejects.toThrow();
  });

  it('003 SC-002 a non-JSON stdout line raises a protocol violation', async () => {
    const service = path.join(folder, 'noisy.mjs');
    await writeFile(
      service,
      [
        "import { createInterface } from 'node:readline';",
        'const lines = createInterface({ input: process.stdin });',
        "lines.once('line', (line) => {",
        '  const { id } = JSON.parse(line);',
        "  process.stdout.write('not a protocol message\\n');",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: null }) + '\\n');",
        '});',
      ].join('\n'),
    );
    const driver = AdapterDriver.start({
      language: 'typescript',
      service,
      sdk: 'openai-7',
      env: apiEnv('http://127.0.0.1:9', { PATH: process.env.PATH }),
    });
    await expect(driver.shutdown()).rejects.toThrow(ProtocolViolation);
    await expect(driver.close()).rejects.toThrow(/not a protocol message/);
  });

  it('003 SC-002 a missing Python SDK fails with the way to build the environment', async () => {
    const python = path.join(folder, 'python-without-sdks');
    await writeFile(python, '#!/bin/sh\nexit 0\n');
    await chmod(python, 0o755);
    vi.stubEnv('MODEL_EVAL_PYTHON', python);
    expect(() => {
      requirePythonSdk('anthropic');
    }).toThrow(
      `The Python at MODEL_EVAL_PYTHON (${python}) has no anthropic SDK. Point MODEL_EVAL_PYTHON at the interpreter of an environment built from one file of adapters/python/tests/requirements/, for example: uv venv adapters/python/.venv && uv pip install --python adapters/python/.venv/bin/python -r adapters/python/tests/requirements/anthropic-2.txt`,
    );
  });

  it('003 SC-002 an installed Python SDK passes the check', async () => {
    const python = path.join(folder, 'python-with-sdks');
    await writeFile(python, '#!/bin/sh\necho 1.17.0\n');
    await chmod(python, 0o755);
    vi.stubEnv('MODEL_EVAL_PYTHON', python);
    expect(() => {
      requirePythonSdk('openai');
    }).not.toThrow();
  });
});
