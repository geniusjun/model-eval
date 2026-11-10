import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manifestSchema, swapRecordSchema } from '../../../src/run/manifest.js';
import type { TrialLine } from '../../../src/run/records.js';
import type { Warning } from '../../../src/run/warning.js';
import {
  RUN_FILES,
  hasNewWarningCode,
  isTemporaryName,
  listResultEntries,
  openTrialLog,
  runDirectoryPath,
  swapRecordPath,
  temporaryPath,
  writeFileAtomic,
  writeFolderAtomic,
  writeManifest,
  writeSwapRecord,
} from '../../../src/run/writer.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'model-eval-writer-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SEND: TrialLine = {
  caseId: 'greet-ko',
  repeat: 0,
  attempt: 1,
  segment: 1,
  reservedUsd: 0.0016,
  sending: true,
};

function attempt(repeat: number): TrialLine {
  return {
    caseId: 'greet-ko',
    repeat,
    attempt: 1,
    segment: 1,
    seed: 235035669,
    costUsd: 0.0016,
    costEstimated: true,
    status: 'stopped',
  };
}

async function entries(folder: string): Promise<string[]> {
  return (await readdir(folder)).sort();
}

describe('trials.jsonl', () => {
  it('001 FR-010 flushes the send line to the file before append resolves, so the attempt can follow', async () => {
    const file = path.join(root, RUN_FILES.trials);
    const log = await openTrialLog(file);
    await log.append(SEND);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(SEND)}\n`);
    await log.append(attempt(0));
    await log.close();
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[1] ?? '')).toEqual(attempt(0));
  });

  it('001 D6 appends concurrent lines whole and in call order, after existing lines', async () => {
    const file = path.join(root, RUN_FILES.trials);
    await writeFile(file, `${JSON.stringify(SEND)}\n`);
    const log = await openTrialLog(file);
    await Promise.all([0, 1, 2, 3, 4].map((repeat) => log.append(attempt(repeat))));
    await log.close();
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      SEND,
      ...[0, 1, 2, 3, 4].map(attempt),
    ]);
  });
});

describe('atomic writes', () => {
  it('001 D6 names temporary files .tmp- with the process ID and a random part in the destination folder', () => {
    const destination = path.join(root, 'manifest.json');
    const first = temporaryPath(destination);
    const second = temporaryPath(destination);
    expect(path.dirname(first)).toBe(root);
    expect(path.basename(first).startsWith(`.tmp-${String(process.pid)}-`)).toBe(true);
    expect(first).not.toBe(second);
    expect(isTemporaryName(path.basename(first))).toBe(true);
    expect(isTemporaryName('manifest.json')).toBe(false);
  });

  it('001 D6 writes a file through a temporary name and rename, replacing an existing one', async () => {
    const destination = path.join(root, 'index.html');
    await writeFile(destination, 'old');
    await writeFileAtomic(destination, 'new');
    expect(await readFile(destination, 'utf8')).toBe('new');
    expect(await entries(root)).toEqual(['index.html']);
  });

  it('001 FR-014 writes manifest.json atomically as the manifest schema', async () => {
    const manifest = manifestSchema.parse(manifestFixture);
    await writeManifest(root, manifest);
    const written: unknown = JSON.parse(
      await readFile(path.join(root, RUN_FILES.manifest), 'utf8'),
    );
    expect(manifestSchema.parse(written)).toEqual(manifest);
    expect(await entries(root)).toEqual(['manifest.json']);
  });

  it('001 FR-014 places a run directory at runs/<runId>/ under the output directory', () => {
    expect(runDirectoryPath(root, '20261105-101500-next-a1b2')).toBe(
      path.join(root, 'runs', '20261105-101500-next-a1b2'),
    );
  });

  it('001 FR-014 writes the swap record to swaps/<swapId>.json', async () => {
    const record = swapRecordSchema.parse({
      swapId: '20261105-101500-swap-c3d4',
      baselineRunId: '20261105-101500-current-a1b2',
      candidateRunId: '20261105-101500-next-e5f6',
      budget: { maxCostUsd: 1, scope: 'swap' },
      spentUsd: 0.0031,
      segments: [{ segment: 1, startedAt: '2026-11-05T10:15:00.000Z', spentUsd: 0.0031 }],
      status: 'running',
    });
    await writeSwapRecord(root, record);
    const file = swapRecordPath(root, record.swapId);
    expect(file).toBe(path.join(root, 'swaps', '20261105-101500-swap-c3d4.json'));
    expect(swapRecordSchema.parse(JSON.parse(await readFile(file, 'utf8')))).toEqual(record);
    expect(await entries(path.join(root, 'swaps'))).toEqual(['20261105-101500-swap-c3d4.json']);
  });

  it('001 D6 writes a new folder as a temporary folder and renames it', async () => {
    const destination = path.join(root, 'comparisons', 'cmp-3f9a1c0e2b7d');
    await writeFolderAtomic(destination, { 'comparison.json': '{}', 'report.md': '# r' });
    expect(await entries(destination)).toEqual(['comparison.json', 'report.md']);
    expect(await entries(path.join(root, 'comparisons'))).toEqual(['cmp-3f9a1c0e2b7d']);
  });

  it('001 D6 replaces each file of an existing folder the same way', async () => {
    const destination = path.join(root, 'cmp-3f9a1c0e2b7d');
    await mkdir(destination);
    await writeFile(path.join(destination, 'comparison.json'), 'old');
    await writeFile(path.join(destination, 'notes.txt'), 'kept');
    await writeFolderAtomic(destination, { 'comparison.json': 'new', 'report.md': '# r' });
    expect(await readFile(path.join(destination, 'comparison.json'), 'utf8')).toBe('new');
    expect(await readFile(path.join(destination, 'notes.txt'), 'utf8')).toBe('kept');
    expect(await entries(destination)).toEqual(['comparison.json', 'notes.txt', 'report.md']);
    expect(await entries(root)).toEqual(['cmp-3f9a1c0e2b7d']);
  });

  it('001 D6 skips .tmp- names when scanning a result folder', async () => {
    await mkdir(path.join(root, 'cmp-000000000001'));
    await mkdir(path.join(root, '.tmp-123-abcd-cmp-000000000002'));
    await writeFile(path.join(root, '.tmp-123-ef01-index.html'), '');
    expect(await listResultEntries(root)).toEqual(['cmp-000000000001']);
    expect(await listResultEntries(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('manifest warnings', () => {
  const overrun: Warning = {
    code: 'budget-overrun',
    params: { overrunUsd: { next: 0.0002 } },
    variants: ['next'],
  };
  const renderMismatch: Warning = { code: 'render-mismatch', params: { trials: { next: 1 } } };

  it('001 FR-014 asks for a rewrite whenever a new warning code appears', () => {
    expect(hasNewWarningCode([], [overrun])).toBe(true);
    expect(hasNewWarningCode([overrun], [overrun, renderMismatch])).toBe(true);
    const larger: Warning = { ...overrun, params: { overrunUsd: { next: 0.0009 } } };
    expect(hasNewWarningCode([overrun], [larger])).toBe(false);
    expect(hasNewWarningCode([overrun, renderMismatch], [overrun])).toBe(false);
  });
});
