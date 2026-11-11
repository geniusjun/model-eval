import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestSchema } from '../../../src/run/manifest.js';
import { readRunRecords } from '../../../src/run/run-records.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };
import { okLine } from '../grade/lines.js';

const SEND = {
  caseId: 'greet-ko',
  repeat: 0,
  attempt: 1,
  segment: 1,
  reservedUsd: 0.01,
  sending: true,
};
const ATTEMPT = okLine({ raw: '안녕' });
const jsonl = (...values: readonly unknown[]) =>
  values.map((value) => `${JSON.stringify(value)}\n`).join('');

describe('saved run records', () => {
  let runDir: string;
  const manifest = manifestSchema.parse(manifestFixture);

  beforeEach(async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'model-eval-run-records-'));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it('001 FR-019 reads the manifest and the complete trial lines, leaving a cut last line out', async () => {
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
    const complete = jsonl(SEND, ATTEMPT);
    await writeFile(path.join(runDir, 'trials.jsonl'), `${complete}{"cut`);
    expect(await readRunRecords(runDir)).toEqual({
      ok: true,
      run: {
        runDir,
        manifest,
        lines: [SEND, ATTEMPT],
        log: {
          lines: [SEND, ATTEMPT],
          completeBytes: Buffer.byteLength(complete),
          cutBytes: Buffer.byteLength('{"cut'),
        },
      },
    });
  });

  it('001 FR-019 a run without a manifest is missing, and an invalid one is unreadable', async () => {
    expect(await readRunRecords(runDir)).toEqual({ ok: false, problem: { kind: 'missing' } });
    await writeFile(path.join(runDir, 'manifest.json'), '{"runId": 1}');
    expect(await readRunRecords(runDir)).toEqual({
      ok: false,
      problem: {
        kind: 'manifest',
        file: path.join(runDir, 'manifest.json'),
        detail: 'not a manifest',
      },
    });
  });

  it('001 FR-013 a broken middle line of trials.jsonl is a problem with its file and line', async () => {
    await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(path.join(runDir, 'trials.jsonl'), `${jsonl(SEND)}{\n${jsonl(ATTEMPT)}`);
    expect(await readRunRecords(runDir)).toMatchObject({
      ok: false,
      problem: { kind: 'trials', file: path.join(runDir, 'trials.jsonl'), line: 2 },
    });
  });
});
