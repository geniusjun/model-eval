import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import type { Target } from '../../../src/adapter/protocol.js';
import { loadProject } from '../../../src/config/load.js';
import { lintSubject, type LintSubject } from '../../../src/lint/subject.js';

// Lint unit tests load real YAML files, so findings carry the file, line and column a user sees.

export const CONFIG = `version: 1
adapter:
  command: [node, adapter.mjs]
variants:
  - id: current
    model: model-a
pricing:
  model-a: { input: 0.1, output: 0.5 }
`;

/** The target of the config contract: Korean and Japanese chat with a required `user`. */
export const CHAT: Target = {
  name: 'chat',
  languages: ['ko', 'ja'],
  inputSchema: {
    type: 'object',
    required: ['user'],
    properties: { user: { type: 'string' } },
  },
};

export interface Workspace {
  /** The temporary folder of the current test. */
  readonly root: () => string;
  write(files: Readonly<Record<string, string>>): Promise<void>;
  /** Writes the files (the config defaults to {@link CONFIG}) and builds the lint subject. */
  subject(
    files: Readonly<Record<string, string>>,
    targets?: readonly Target[],
  ): Promise<LintSubject>;
}

/** A fresh folder per test, removed after it. */
export function useWorkspace(): Workspace {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'model-eval-lint-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const write = async (files: Readonly<Record<string, string>>): Promise<void> => {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
  };
  return {
    root: () => root,
    write,
    async subject(files, targets) {
      await write({ 'model-eval.config.yaml': CONFIG, ...files });
      const loaded = await loadProject('model-eval.config.yaml', root);
      if (!loaded.ok) {
        throw new Error(`the test files do not load: ${JSON.stringify(loaded.diagnostics)}`);
      }
      return lintSubject(loaded.project, root, targets);
    },
  };
}
