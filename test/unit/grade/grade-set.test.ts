import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { caseSchema, ruleSchema } from '../../../src/config/schema.js';
import type { RunCase } from '../../../src/grade/grade.js';
import {
  casesHashOf,
  ensureGradeSet,
  gradeSetIdOf,
  readGradeSet,
  trialsFingerprintOf,
  type GradeSetIdentity,
} from '../../../src/grade/grade-set.js';
import { okLine } from './lines.js';

const HASH_A = `sha256:${'a'.repeat(64)}` as const;
const HASH_B = `sha256:${'b'.repeat(64)}` as const;
const HASH_C = `sha256:${'c'.repeat(64)}` as const;

const IDENTITY: GradeSetIdentity = {
  runId: '20261110-120000-current-ab12',
  rulesHash: HASH_A,
  checkerVersion: '0.1.0',
  trialsFingerprint: HASH_B,
  casesHash: HASH_C,
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const emojiRule = ruleSchema.parse({
  id: 'no-emoji',
  title: 'No emoji',
  severity: 'major',
  scope: 'global',
  check: { type: 'emoji' },
});
const greet = caseSchema.parse({
  id: 'greet-ko',
  target: 'chat',
  lang: 'ko',
  provenance: 'synthetic',
  input: {},
});
const CASES: readonly RunCase[] = [
  {
    id: 'greet-ko',
    target: 'chat',
    lang: 'ko',
    hash: HASH_A,
    current: { definition: greet, hash: HASH_A },
  },
];

/** What ensureGradeSet is given; it derives `casesHash` from the cases itself. */
const INPUT = {
  runId: IDENTITY.runId,
  rulesHash: IDENTITY.rulesHash,
  checkerVersion: IDENTITY.checkerVersion,
  trialsFingerprint: IDENTITY.trialsFingerprint,
};
const STORED: GradeSetIdentity = { ...INPUT, casesHash: casesHashOf(CASES) };

let runDir = '';

beforeEach(async () => {
  runDir = await mkdtemp(path.join(tmpdir(), 'model-eval-grade-set-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

describe('grade set identity', () => {
  it('001 FR-018 gradeSetId is gs- plus 12 hex of the canonical JSON of its five inputs', () => {
    const canonical =
      `{"casesHash":"${HASH_C}","checkerVersion":"0.1.0","rulesHash":"${HASH_A}",` +
      `"runId":"20261110-120000-current-ab12","trialsFingerprint":"${HASH_B}"}`;
    expect(gradeSetIdOf(IDENTITY)).toBe(`gs-${sha256(canonical).slice(0, 12)}`);
  });

  it('001 D6 a changed input gives a new gradeSetId', () => {
    const changes: readonly Partial<GradeSetIdentity>[] = [
      { runId: '20261110-120000-next-ab12' },
      { rulesHash: HASH_B },
      { checkerVersion: '0.1.1' },
      { trialsFingerprint: HASH_A },
      { casesHash: HASH_A },
    ];
    const ids = changes.map((change) => gradeSetIdOf({ ...IDENTITY, ...change }));
    expect(new Set([gradeSetIdOf(IDENTITY), ...ids]).size).toBe(changes.length + 1);
  });

  it('001 FR-018 casesHash covers each run case with its current hash or null, sorted by id', () => {
    const cases: readonly RunCase[] = [
      {
        id: 'mood-ko',
        target: 'chat',
        lang: 'ko',
        hash: HASH_A,
        current: { definition: greet, hash: HASH_B },
      },
      { id: 'greet-ko', target: 'chat', lang: 'ko', hash: HASH_A },
    ];
    const canonical = `[{"hash":null,"id":"greet-ko"},{"hash":"${HASH_B}","id":"mood-ko"}]`;
    expect(casesHashOf(cases)).toBe(`sha256:${sha256(canonical)}`);
  });

  it('001 FR-018 trialsFingerprint covers every line in file order', () => {
    const send = {
      caseId: 'greet-ko',
      repeat: 0,
      attempt: 1,
      segment: 1,
      reservedUsd: 0.001,
      sending: true,
    };
    const cost = { segment: 1, source: 'calls', costUsd: 0, costCorrection: true, calls: [] };
    const canonical =
      '[{"attempt":1,"caseId":"greet-ko","repeat":0,"reservedUsd":0.001,"segment":1,"sending":true}]';
    expect(trialsFingerprintOf([send])).toBe(`sha256:${sha256(canonical)}`);
    expect(trialsFingerprintOf([send, cost])).not.toBe(trialsFingerprintOf([send]));
    expect(trialsFingerprintOf([cost, send])).not.toBe(trialsFingerprintOf([send, cost]));
  });
});

describe('grade set files', () => {
  it('001 D6 writes grades/<gradeSetId>.jsonl, header first, without leaving temporary files', async () => {
    const { gradeSet, reused } = await ensureGradeSet({
      runDir,
      ...INPUT,
      rules: [emojiRule],
      cases: CASES,
      lines: [okLine({ raw: '😀' })],
    });
    expect(reused).toBe(false);
    const gradeSetId = gradeSetIdOf(STORED);
    expect(gradeSet.header).toEqual({ gradeSetId, ...STORED });
    expect(await readdir(path.join(runDir, 'grades'))).toEqual([`${gradeSetId}.jsonl`]);
    const text = await readFile(path.join(runDir, 'grades', `${gradeSetId}.jsonl`), 'utf8');
    expect(
      text.split('\n').map((line): unknown => (line === '' ? null : JSON.parse(line))),
    ).toEqual([
      { gradeSetId, ...STORED },
      { caseId: 'greet-ko', repeat: 0, ruleId: 'no-emoji', surface: 'final', outcome: 'pass' },
      {
        caseId: 'greet-ko',
        repeat: 0,
        ruleId: 'no-emoji',
        surface: 'raw',
        outcome: 'fail',
        evidence: ['😀'],
      },
      null,
    ]);
    expect(await readGradeSet(runDir, gradeSetId)).toEqual(gradeSet);
  });

  it('001 FR-018 grades from the effective attempt line of each key', async () => {
    const { gradeSet } = await ensureGradeSet({
      runDir,
      ...INPUT,
      rules: [emojiRule],
      cases: CASES,
      lines: [okLine({ raw: '😀' }), okLine({ attempt: 2, raw: '안녕', final: '안녕' })],
    });
    expect(gradeSet.grades.map(({ outcome }) => outcome)).toEqual(['pass', 'pass']);
  });

  it('001 D6 reuses an existing grade set instead of grading again', async () => {
    const first = await ensureGradeSet({
      runDir,
      ...INPUT,
      rules: [emojiRule],
      cases: CASES,
      lines: [okLine({ raw: '😀' })],
    });
    // Same identity, different grading input: only the identity decides, so nothing is rebuilt.
    const second = await ensureGradeSet({
      runDir,
      ...INPUT,
      rules: [],
      cases: CASES,
      lines: [],
    });
    expect(second.reused).toBe(true);
    expect(second.gradeSet).toEqual(first.gradeSet);
  });

  it('001 D6 a changed input writes a new grade set beside the old one', async () => {
    const input = { runDir, rules: [emojiRule], cases: CASES, lines: [okLine()] };
    const first = await ensureGradeSet({ ...input, ...INPUT });
    const second = await ensureGradeSet({ ...input, ...INPUT, trialsFingerprint: HASH_C });
    expect(second.reused).toBe(false);
    expect(second.gradeSet.header.gradeSetId).not.toBe(first.gradeSet.header.gradeSetId);
    expect((await readdir(path.join(runDir, 'grades'))).sort()).toEqual(
      [first, second].map(({ gradeSet }) => `${gradeSet.header.gradeSetId}.jsonl`).sort(),
    );
  });

  it('001 D6 reads nothing for a grade set that was never written', async () => {
    expect(await readGradeSet(runDir, gradeSetIdOf(STORED))).toBeUndefined();
  });
});
