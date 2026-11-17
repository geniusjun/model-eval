import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startAdapter } from '../../../src/adapter/client.js';
import { ROOT } from './support/mock-api.js';
import { TIMEOUT_MS } from './support/service-runs.js';

// The TypeScript helper ships as the `model-eval/adapter` subpath of the tool package (helper-api
// §Distribution; FR-025): the packed tarball holds it, its types and the Python helper; unpacked
// into a folder of its own next to an SDK, with none of the tool's dependencies there, it exports
// exactly `defineAdapter`, `fallback`, `result` and `ModelCallError` and answers `initialize`;
// its static import graph reaches only `node:` built-ins and files under dist/; and the tool
// package's runtime dependencies stay the ones it had.

const HELPER_ENTRY = 'dist/helper/index.js';
const RUNTIME_DEPENDENCIES = ['ajv', 'yaml', 'zod'];
const EXPORTS = ['ModelCallError', 'defineAdapter', 'fallback', 'result'];
const SDK = 'openai-7';

let folder: string | undefined;
let tarball: string | undefined;

beforeAll(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'helper-distribution-'));
  const packed = path.join(folder, 'packed');
  mkdirSync(packed);
  execFileSync('pnpm', ['pack', '--pack-destination', packed], { cwd: ROOT, stdio: 'pipe' });
  const [name] = readdirSync(packed);
  tarball = name === undefined ? undefined : path.join(packed, name);
}, TIMEOUT_MS);

afterAll(() => {
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function workFolder(): string {
  if (folder === undefined) {
    throw new Error('the package was not packed');
  }
  return folder;
}

function packedFile(): string {
  if (tarball === undefined) {
    throw new Error('the package was not packed');
  }
  return tarball;
}

/**
 * A project folder with the tarball unpacked as node_modules/model-eval and the SDK linked as
 * node_modules/openai, and nothing else: no zod, ajv or yaml for the helper to fall back on.
 */
function project(): string {
  const root = path.join(workFolder(), 'project');
  if (!existsSync(root)) {
    const modules = path.join(root, 'node_modules');
    const unpacked = path.join(modules, 'model-eval');
    mkdirSync(unpacked, { recursive: true });
    execFileSync('tar', ['-xzf', packedFile(), '-C', unpacked, '--strip-components', '1']);
    symlinkSync(realpathSync(path.join(ROOT, 'node_modules', SDK)), path.join(modules, 'openai'));
    writeFileSync(path.join(root, 'package.json'), '{"type": "module", "private": true}\n');
  }
  return root;
}

/** Static import specifiers of an ES module: `import … from`, `export … from`, bare `import`. */
function importSpecifiers(source: string): string[] {
  const pattern = /(?:^|[;\s])(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Every module the entry reaches by static imports, and every bare specifier on the way. */
function importGraph(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        pending.push(path.resolve(path.dirname(file), specifier));
      } else {
        bare.add(specifier);
      }
    }
  }
  return { files: [...files], bare: [...bare] };
}

describe('003 distribution of the TypeScript helper (helper-api §Distribution)', () => {
  it(
    '003 FR-025 the pnpm pack tarball holds the helper, its types and the Python helper',
    () => {
      const listed = execFileSync('tar', ['-tzf', packedFile()], { encoding: 'utf8' }).split('\n');
      expect(listed).toEqual(
        expect.arrayContaining([
          'package/dist/helper/index.js',
          'package/dist/helper/index.d.ts',
          'package/adapters/python/model_eval_adapter.py',
        ]),
      );
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-025 unpacked next to an SDK, model-eval/adapter exports exactly its four names',
    () => {
      const root = project();
      const report = path.join(root, 'exports.json');
      // The helper sends process.stdout to stderr on import, so the names go to a file.
      const script = [
        "import { writeFileSync } from 'node:fs';",
        "const helper = await import('model-eval/adapter');",
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.keys(helper).sort()));`,
      ].join('\n');
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        stdio: 'pipe',
      });
      expect(z.array(z.string()).parse(JSON.parse(readFileSync(report, 'utf8')))).toEqual(EXPORTS);
    },
    TIMEOUT_MS,
  );

  it(
    '003 FR-025 an adapter in that folder answers initialize as the TypeScript helper',
    async () => {
      const root = project();
      const adapter = path.join(root, 'adapter.mjs');
      writeFileSync(
        adapter,
        [
          "import { defineAdapter } from 'model-eval/adapter';",
          "import OpenAI from 'openai';",
          '',
          "defineAdapter({ name: 'packed', version: '0.0.1', targets: { chat: {",
          '  async generate(c, variant) {',
          '    const client = new OpenAI({ maxRetries: 0 });',
          "    const r = await client.chat.completions.create({ model: variant.model, messages: [{ role: 'user', content: 'Hi.' }] });",
          "    return r.choices[0]?.message?.content ?? '';",
          '  },',
          '} } }).listen();',
          '',
        ].join('\n'),
      );
      const started = await startAdapter({
        launch: { command: [process.execPath, adapter], cwd: root, env: {} },
        initialize: {
          client: { name: 'model-eval', version: '0.0.0-test' },
          variant: { id: 'next', model: 'model-b' },
          timeoutMs: 30_000,
          toolPaths: [],
        },
        concurrency: 1,
      });
      if (!started.ok) {
        throw new Error(`the packed adapter did not start: ${started.error.message}`);
      }
      const ended = await started.client.shutdown();
      expect(started.client.info.adapter.helper?.language).toBe('typescript');
      expect(ended).toMatchObject({ answered: true, exitCode: 0 });
    },
    TIMEOUT_MS,
  );

  it('003 FR-025 the static import graph of the helper reaches only node: built-ins and dist/', () => {
    const dist = path.join(ROOT, 'dist');
    const { files, bare } = importGraph(path.join(ROOT, HELPER_ENTRY));
    expect(files.filter((file) => !file.startsWith(`${dist}${path.sep}`))).toEqual([]);
    expect(bare.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
    for (const dependency of RUNTIME_DEPENDENCIES) {
      expect(bare).not.toContain(dependency);
    }
  });

  it('003 FR-025 the package runtime dependencies are unchanged', () => {
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
    expect(Object.keys(manifest.dependencies).sort()).toEqual(RUNTIME_DEPENDENCIES);
  });
});
