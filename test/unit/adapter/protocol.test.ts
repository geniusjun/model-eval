import { describe, expect, it } from 'vitest';

import {
  answerResultSchema,
  callRecordSchema,
  capabilitiesSchema,
  generateParamsSchema,
  rpcRequestSchema,
} from '../../../src/adapter/protocol.js';

const ANSWER = { raw: 'hi', latencyMs: 10, finishReason: 'stop' };

describe('adapter protocol v1 schemas', () => {
  it('001 FR-007 accepts structured params or none, never null', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'shutdown' };
    expect(rpcRequestSchema.safeParse(request).success).toBe(true);
    expect(rpcRequestSchema.safeParse({ ...request, params: {} }).success).toBe(true);
    expect(rpcRequestSchema.safeParse({ ...request, params: [] }).success).toBe(true);
    expect(rpcRequestSchema.safeParse({ ...request, params: null }).success).toBe(false);
    expect(rpcRequestSchema.safeParse({ ...request, params: 'x' }).success).toBe(false);
  });

  it('001 FR-016 keeps the per-trial seed within an unsigned 32-bit integer', () => {
    const params = { target: 'chat', input: {}, caseId: 'c', repeat: 0 };
    expect(generateParamsSchema.safeParse({ ...params, seed: 0xffff_ffff }).success).toBe(true);
    expect(generateParamsSchema.safeParse({ ...params, seed: 2 ** 32 }).success).toBe(false);
    expect(generateParamsSchema.safeParse({ ...params, seed: -1 }).success).toBe(false);
  });

  it('001 FR-007 allows only model failure kinds on a call record', () => {
    for (const kind of ['config', 'transient', 'permanent', 'timeout']) {
      expect(
        callRecordSchema.safeParse({ model: 'm', outcome: 'failed', errorKind: kind }).success,
      ).toBe(true);
    }
    expect(
      callRecordSchema.safeParse({ model: 'm', outcome: 'failed', errorKind: 'adapter' }).success,
    ).toBe(false);
  });

  it('001 FR-010 rejects answers 0 with finalKind model and defaults answers to 1', () => {
    expect(
      answerResultSchema.safeParse({ ...ANSWER, answers: 0, finalKind: 'model', final: 'hi' })
        .success,
    ).toBe(false);
    expect(
      answerResultSchema.safeParse({ ...ANSWER, answers: 0, finalKind: 'fallback', final: 'x' })
        .success,
    ).toBe(true);
    expect(answerResultSchema.parse({ ...ANSWER, finalKind: 'model', final: 'hi' }).answers).toBe(
      1,
    );
  });

  it('001 FR-007 reads left-out capabilities as false, except postprocess', () => {
    expect(capabilitiesSchema.parse({})).toEqual({
      render: false,
      stages: false,
      postprocess: true,
      cancel: false,
    });
  });
});
