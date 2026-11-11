import { describe, expect, it } from 'vitest';

import {
  comparisonWarnings,
  groupRedactedWarnings,
  groupWarnings,
  type WarningRun,
} from '../../../src/compare/warnings.js';
import type { Sha256 } from '../../../src/config/identifiers.js';
import { reportConfigSchema } from '../../../src/config/schema.js';
import { createRedactor } from '../../../src/report/redact.js';
import { manifestSchema, type Manifest } from '../../../src/run/manifest.js';
import { trialLineSchema, type AttemptLine, type TrialLine } from '../../../src/run/records.js';
import type { Warning } from '../../../src/run/warning.js';
import manifestFixture from '../../fixtures/contracts/manifest.json' with { type: 'json' };
import { errorLine, okLine } from '../grade/lines.js';

const REPORT = reportConfigSchema.parse({});
const FINGERPRINT: Sha256 = `sha256:${'a'.repeat(64)}`;
const OTHER: Sha256 = `sha256:${'b'.repeat(64)}`;

function manifest(id: string, model: string, fields: Partial<Manifest> = {}): Manifest {
  const base = manifestSchema.parse(manifestFixture);
  return {
    ...base,
    variant: { ...base.variant, id, model },
    warnings: [],
    segments: base.segments.map((segment) => ({ ...segment, resumeWarnings: [] })),
    ...fields,
  };
}

const ok = (caseId: string, repeat: number, fields: Record<string, unknown> = {}) =>
  okLine({ caseId, repeat, ...fields });

function runs(
  baseline: readonly AttemptLine[],
  candidate: readonly AttemptLine[],
  manifests: Partial<{ baseline: Manifest; candidate: Manifest }> = {},
): { baseline: WarningRun; candidate: WarningRun } {
  return {
    baseline: {
      manifest: manifests.baseline ?? manifest('current', 'model-a'),
      lines: baseline,
      finished: baseline,
    },
    candidate: {
      manifest: manifests.candidate ?? manifest('next', 'model-b'),
      lines: candidate,
      finished: candidate,
    },
  };
}

const codes = (warnings: readonly Warning[]) => warnings.map((warning) => warning.code);

describe('run warnings recounted on common cases', () => {
  it('001 FR-023 transient-rate when the share of transient finished trials passes report.warn.transientRate', () => {
    const lines = (transient: number) =>
      Array.from({ length: 20 }, (_, repeat) =>
        repeat < transient ? errorLine('transient', { caseId: 'a', repeat }) : ok('a', repeat),
      );
    const warnings = comparisonWarnings(runs(lines(1), lines(2)), REPORT);
    expect(warnings).toEqual([
      {
        code: 'transient-rate',
        params: { rates: { next: 0.1 }, threshold: 0.05 },
        variants: ['next'],
      },
    ]);
    expect(comparisonWarnings(runs(lines(2), lines(2)), REPORT)).toEqual([
      {
        code: 'transient-rate',
        params: { rates: { current: 0.1, next: 0.1 }, threshold: 0.05 },
        variants: ['current', 'next'],
      },
    ]);
  });

  it('001 FR-016 identical-repeats when every finished repeat of a case is ok with the same raw answer', () => {
    const baseline = [
      ok('same', 0, { raw: 'hi' }),
      ok('same', 1, { raw: 'hi' }),
      ok('differ', 0, { raw: 'hi' }),
      ok('differ', 1, { raw: 'hello' }),
      ok('single', 0),
      ok('failed', 0, { raw: 'hi' }),
      errorLine('permanent', { caseId: 'failed', repeat: 1 }),
    ];
    const candidate = [ok('also', 0), ok('also', 1), ok('also', 2)];
    expect(comparisonWarnings(runs(baseline, candidate), REPORT)).toEqual([
      { code: 'identical-repeats', variants: ['current', 'next'], caseIds: ['also', 'same'] },
    ]);
  });

  it('001 FR-016 response-model-changed when a run has more than one response snapshot', () => {
    const baseline = [
      ok('a', 0, { modelSnapshot: 'm-2' }),
      ok('a', 1, { modelSnapshot: 'm-1', raw: 'x' }),
    ];
    const candidate = [ok('a', 0, { modelSnapshot: 'n-1' }), ok('a', 1, { raw: 'x' })];
    expect(comparisonWarnings(runs(baseline, candidate), REPORT)).toEqual([
      {
        code: 'response-model-changed',
        params: { models: { current: ['m-1', 'm-2'] } },
        variants: ['current'],
      },
    ]);
  });

  it('001 FR-015 render-mismatch counts trials whose fingerprint differs from the render fingerprint of the case', () => {
    const prompts = { a: FINGERPRINT, b: FINGERPRINT };
    const baseline = [
      ok('a', 0, { fingerprint: FINGERPRINT }),
      ok('b', 0, { fingerprint: OTHER }),
      ok('b', 1, { fingerprint: OTHER, raw: 'x' }),
      ok('c', 0, { fingerprint: OTHER }),
    ];
    const warnings = comparisonWarnings(
      runs(baseline, [], { baseline: manifest('current', 'model-a', { prompts }) }),
      REPORT,
    );
    expect(warnings).toEqual([
      {
        code: 'render-mismatch',
        params: { trials: { current: 2 } },
        variants: ['current'],
        caseIds: ['b'],
      },
    ]);
  });
});

describe('manifest warnings', () => {
  it('001 FR-023 are copied under their run variant and grouped per code; trial-based codes are recounted instead', () => {
    const baseline = manifest('current', 'model-a', {
      warnings: [
        { code: 'budget-overrun', params: { overrunUsd: { current: 0.1 } }, variants: ['current'] },
        { code: 'unpriced-model', params: { models: ['model-z'] } },
        {
          code: 'transient-rate',
          params: { rates: { current: 0.9 }, threshold: 0.05 },
          variants: ['current'],
        },
      ],
    });
    const candidate = manifest('next', 'model-b', {
      warnings: [
        { code: 'budget-overrun', params: { overrunUsd: { next: 0.2 } }, variants: ['next'] },
        { code: 'unpriced-model', params: { models: ['model-y', 'model-z'] }, variants: ['next'] },
      ],
      segments: manifest('next', 'model-b').segments.map((segment) => ({
        ...segment,
        resumeWarnings: [{ code: 'resume-unverified', params: { conditions: ['tree-hash'] } }],
      })),
    });
    expect(comparisonWarnings(runs([], [], { baseline, candidate }), REPORT)).toEqual([
      {
        code: 'budget-overrun',
        params: { overrunUsd: { current: 0.1, next: 0.2 } },
        variants: ['current', 'next'],
      },
      { code: 'resume-unverified', params: { conditions: ['tree-hash'] }, variants: ['next'] },
      {
        code: 'unpriced-model',
        params: { models: ['model-y', 'model-z'] },
        variants: ['current', 'next'],
      },
    ]);
  });
});

describe('adapter faults in the comparison', () => {
  const abandoned = (caseId: string, cause: 'timeout' | 'restart') =>
    errorLine('adapter', {
      caseId,
      error: { kind: 'adapter', message: 'no answer', abandoned: cause },
    });
  const late = (caseId: string, calls: readonly Record<string, unknown>[]): TrialLine =>
    trialLineSchema.parse({
      caseId,
      repeat: 0,
      attempt: 1,
      segment: 1,
      source: 'late',
      costUsd: 0,
      calls: [{ model: 'model-b', outcome: 'ok' }, ...calls],
      costCorrection: true,
    });
  const failed = (errorKind: string, retryAfterMs?: number) => ({
    model: 'model-b',
    outcome: 'failed',
    errorKind,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  it('001 FR-008 abandoned-trials counts causes and, per kind, the time-outs whose late responses failed and their longest wait', () => {
    const finished = [
      abandoned('a', 'timeout'),
      abandoned('b', 'timeout'),
      abandoned('c', 'timeout'),
      abandoned('d', 'restart'),
      ok('e', 0),
    ];
    const lines = [
      ...finished,
      late('a', [failed('transient', 2000), failed('transient', 500)]),
      late('b', [failed('transient'), failed('timeout')]),
      late('c', []),
    ];
    const candidate = { manifest: manifest('next', 'model-b'), lines, finished };
    const warnings = comparisonWarnings(
      { baseline: runs([], []).baseline, candidate },
      REPORT,
    ).filter((warning) => warning.code === 'abandoned-trials');
    expect(warnings).toEqual([
      {
        code: 'abandoned-trials',
        params: {
          trials: { next: { timeout: 3, restart: 1 } },
          timeoutMs: { next: candidate.manifest.limits.timeoutMs },
          lateFailures: {
            next: {
              transient: { trials: 2, maxRetryAfterMs: 2000 },
              timeout: { trials: 1, maxRetryAfterMs: null },
            },
          },
        },
        variants: ['next'],
      },
    ]);
  });

  it('001 FR-008 adapter-warnings counts each trial once per sentence over all its attempts', () => {
    const sentence = 'the raw call was not captured';
    const transient = errorLine('transient', { caseId: 'a', warnings: [sentence] });
    const finished = [
      ok('a', 0, { attempt: 2 }),
      ok('b', 0, { warnings: [sentence, sentence, 'other'] }),
      ok('c', 0),
    ];
    const candidate = {
      manifest: manifest('next', 'model-b'),
      lines: [transient, ...finished],
      finished,
    };
    const warnings = comparisonWarnings(
      { baseline: runs([], []).baseline, candidate },
      REPORT,
    ).filter((warning) => warning.code === 'adapter-warnings');
    expect(warnings).toEqual([
      {
        code: 'adapter-warnings',
        params: { sentence: 'other', trials: { next: 1 } },
        variants: ['next'],
        caseIds: ['b'],
      },
      {
        code: 'adapter-warnings',
        params: { sentence, trials: { next: 2 } },
        variants: ['next'],
        caseIds: ['a', 'b'],
      },
    ]);
  });
});

describe('same-response-model', () => {
  const snapshots = (...models: string[]) =>
    models.map((modelSnapshot, repeat) => ok('a', repeat, { modelSnapshot, raw: String(repeat) }));

  it('001 FR-023 different models answered with the same non-empty snapshot list', () => {
    const warnings = comparisonWarnings(runs(snapshots('m-1'), snapshots('m-1', 'm-1')), REPORT);
    expect(warnings).toEqual([
      { code: 'same-response-model', params: { models: ['m-1'] }, variants: ['current', 'next'] },
    ]);
  });

  it('001 FR-023 not for the same model, different snapshots or no snapshot', () => {
    const sameModel = {
      baseline: manifest('current', 'model-a'),
      candidate: manifest('next', 'model-a'),
    };
    expect(
      codes(comparisonWarnings(runs(snapshots('m-1'), snapshots('m-1'), sameModel), REPORT)),
    ).toEqual([]);
    expect(codes(comparisonWarnings(runs(snapshots('m-1'), snapshots('m-2')), REPORT))).toEqual([]);
    expect(codes(comparisonWarnings(runs([ok('a', 0)], [ok('a', 0)]), REPORT))).toEqual([]);
  });
});

describe('grouping', () => {
  it('001 FR-023 one warning per code, rule and language, and per sentence for adapter-warnings', () => {
    const grouped = groupWarnings([
      {
        code: 'adapter-warnings',
        params: { sentence: 'b', trials: { current: 1 } },
        variants: ['current'],
        caseIds: ['y'],
      },
      {
        code: 'adapter-warnings',
        params: { sentence: 'a', trials: { next: 2 } },
        variants: ['next'],
        caseIds: ['x'],
      },
      {
        code: 'adapter-warnings',
        params: { sentence: 'b', trials: { next: 3 } },
        variants: ['next'],
        caseIds: ['x'],
      },
      { code: 'excluded-from-gate', ruleId: 'r2', params: { cause: 'review' } },
      { code: 'excluded-from-gate', ruleId: 'r1', params: { cause: 'review' } },
    ]);
    expect(grouped).toEqual([
      {
        code: 'adapter-warnings',
        params: { sentence: 'a', trials: { next: 2 } },
        variants: ['next'],
        caseIds: ['x'],
      },
      {
        code: 'adapter-warnings',
        params: { sentence: 'b', trials: { current: 1, next: 3 } },
        variants: ['current', 'next'],
        caseIds: ['x', 'y'],
      },
      { code: 'excluded-from-gate', ruleId: 'r1', params: { cause: 'review' } },
      { code: 'excluded-from-gate', ruleId: 'r2', params: { cause: 'review' } },
    ]);
  });

  it('001 FR-023 warnings whose values disagree for one variant stay apart', () => {
    const grouped = groupWarnings([
      { code: 'estimate-low-accuracy', params: { inputTokens: 100 }, variants: ['current'] },
      { code: 'estimate-low-accuracy', params: { inputTokens: 200 }, variants: ['next'] },
      { code: 'budget-overrun', params: { overrunUsd: { current: 0.1 } }, variants: ['current'] },
      { code: 'budget-overrun', params: { overrunUsd: { current: 0.1 } }, variants: ['current'] },
    ]);
    expect(grouped).toEqual([
      { code: 'budget-overrun', params: { overrunUsd: { current: 0.1 } }, variants: ['current'] },
      { code: 'estimate-low-accuracy', params: { inputTokens: 100 }, variants: ['current'] },
      { code: 'estimate-low-accuracy', params: { inputTokens: 200 }, variants: ['next'] },
    ]);
  });

  it('001 FR-031 groups on redacted text, so sentences that differ only in a redacted part merge', () => {
    const redactor = createRedactor([
      { pattern: 'req-[0-9]+', replace: 'req' },
      { pattern: 'miss', replace: 'miss-x' },
    ]);
    const grouped = groupRedactedWarnings(
      [
        {
          code: 'adapter-warnings',
          params: { sentence: 'cache miss req-1', trials: { current: 1 } },
          variants: ['current'],
        },
        {
          code: 'adapter-warnings',
          params: { sentence: 'cache miss req-2', trials: { next: 2 } },
          variants: ['next'],
        },
      ],
      redactor,
    );
    expect(grouped).toEqual([
      {
        code: 'adapter-warnings',
        params: { sentence: 'cache miss-x req', trials: { current: 1, next: 2 } },
        variants: ['current', 'next'],
      },
    ]);
  });
});
