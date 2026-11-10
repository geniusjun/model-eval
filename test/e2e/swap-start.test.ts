import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { E2E, swapJson, useProjects } from './support/commands.js';
import {
  attemptLines,
  comparisonOf,
  parseSwapEnvelope,
  readRun,
  swapRunOf,
} from './support/outputs.js';
import { greetCases } from './support/project.js';
import { ANSWERED } from './support/rules.js';

// What the swap command checks before and at the start (contracts/cli.md §Exit Codes, §Options
// of `run` and `swap`), against the mock adapter.

const project = useProjects();

const CASES = greetCases({ ko: 3, ja: 3 });
const RULES = [ANSWERED];

describe('001 swap start', () => {
  it(
    '001 FR-032 --from and --to naming the same variant is a usage error with exit 4 before any adapter starts',
    async () => {
      const same = await project({ scenario: 'swap-clean', rules: RULES, cases: CASES });
      const cli = await same.run(['swap', '--from', 'current', '--to', 'current', '--json']);
      const envelope = parseSwapEnvelope(cli.stdout);
      expect(cli.code).toBe(4);
      expect(envelope.exit).toEqual({ code: 4, name: 'config-error' });
      expect(envelope.result).toBeNull();
      expect(cli.stderr).toContain('"current"');
      expect(await same.sessions()).toEqual([]);
    },
    E2E.timeout,
  );

  it(
    '001 FR-032 a failure after the adapters started exits 6 and shuts both adapters down',
    async () => {
      const blocked = await project({
        scenario: 'swap-clean',
        rules: RULES,
        cases: CASES,
        config: { output: { dir: 'not-a-folder' } },
      });
      await writeFile(path.join(blocked.root, 'not-a-folder'), 'a regular file\n');
      const { cli, envelope } = await swapJson(blocked);
      // A process kept alive by an adapter would end on the time limit's signal, without a code.
      expect(cli.code).toBe(6);
      expect(envelope.exit).toEqual({ code: 6, name: 'internal-error' });
      const sessions = await blocked.sessions();
      expect(sessions.map((session) => session.variant).sort()).toEqual(['current', 'next']);
      for (const session of sessions) {
        const methods = session.requests.map((request) => request.method);
        expect(methods).not.toContain('generate');
        expect(methods.at(-1)).toBe('shutdown');
      }
    },
    E2E.timeout,
  );

  it(
    '001 FR-016 --cases sends and compares only the matching cases in both variants',
    async () => {
      const korean = await project({ scenario: 'swap-clean', rules: RULES, cases: CASES });
      const { cli, envelope } = await swapJson(korean, ['--cases', 'greet-ko-*']);
      expect(cli.code).toBe(0);
      const koIds = ['greet-ko-1', 'greet-ko-2', 'greet-ko-3'];
      for (const runId of swapRunOf(envelope).runs) {
        const { manifest, lines } = await readRun(korean.outputDir, runId);
        expect(manifest.sampling.cases).toBe('greet-ko-*');
        expect(manifest.cases.map((runCase) => runCase.id)).toEqual(koIds);
        expect(new Set(attemptLines(lines).map((line) => line.caseId))).toEqual(new Set(koIds));
      }
      const requests = await korean.generateRequests();
      for (const variant of ['current', 'next']) {
        const sent = requests.filter((request) => request.variant === variant);
        expect(sent).toHaveLength(koIds.length * 2);
        expect(new Set(sent.map((request) => request.caseId))).toEqual(new Set(koIds));
      }
      expect(comparisonOf(envelope).coverage.commonCases).toBe(koIds.length);
    },
    E2E.timeout,
  );
});
