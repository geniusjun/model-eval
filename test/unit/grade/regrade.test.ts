import { describe, expect, it } from 'vitest';

import { caseSchema } from '../../../src/config/schema.js';
import { currentCases } from '../../../src/grade/regrade.js';
import { caseHash } from '../../../src/run/hashes.js';
import { manifestSchema, type Manifest } from '../../../src/run/manifest.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };

const definition = (id: string, fields: Record<string, unknown> = {}) =>
  caseSchema.parse({ id, target: 'chat', provenance: 'synthetic', input: { user: id }, ...fields });

function manifestWith(cases: Manifest['cases']): Manifest {
  return { ...manifestSchema.parse(manifestFixture), cases };
}

describe('current cases of saved runs', () => {
  const recorded = (id: string, lang: string) => ({
    id,
    target: 'chat',
    lang,
    hash: caseHash('chat', lang, { user: id }),
  });

  it('001 FR-027 hashes each recorded case as it is in the case files now', () => {
    const current = currentCases(
      [definition('a', { lang: 'ko' }), definition('b', { lang: 'ko', input: { user: 'edited' } })],
      manifestWith([recorded('a', 'ko'), recorded('b', 'ko')]),
    );
    expect(current.get('a')?.hash).toBe(recorded('a', 'ko').hash);
    expect(current.get('b')?.hash).not.toBe(recorded('b', 'ko').hash);
    expect(current.get('b')?.hash).toBe(caseHash('chat', 'ko', { user: 'edited' }));
  });

  it('001 FR-019 a case without lang keeps the language key its run recorded', () => {
    const current = currentCases(
      [definition('only-ja'), definition('no-lang')],
      manifestWith([recorded('only-ja', 'ja'), recorded('no-lang', '*')]),
    );
    expect(current.get('only-ja')).toMatchObject({
      lang: 'ja',
      hash: recorded('only-ja', 'ja').hash,
    });
    expect(current.get('no-lang')).toMatchObject({
      lang: '*',
      hash: recorded('no-lang', '*').hash,
    });
  });

  it('001 FR-027 leaves out cases no run recorded and keeps deleted ones absent', () => {
    const current = currentCases(
      [definition('new', { lang: 'ko' })],
      manifestWith([recorded('deleted', 'ko')]),
    );
    expect([...current.keys()]).toEqual([]);
  });

  it('001 FR-019 each run keeps its own language key, so grade and compare grade it alike', () => {
    const plain = [definition('plain')];
    const baseline = currentCases(plain, manifestWith([recorded('plain', 'ko')]));
    const candidate = currentCases(plain, manifestWith([recorded('plain', 'ja')]));
    expect(baseline.get('plain')).toMatchObject({ lang: 'ko', hash: recorded('plain', 'ko').hash });
    expect(candidate.get('plain')).toMatchObject({
      lang: 'ja',
      hash: recorded('plain', 'ja').hash,
    });
  });
});
