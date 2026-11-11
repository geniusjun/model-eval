import { attemptLineSchema, type AttemptLine } from '../../../src/run/records.js';

const KEY = { caseId: 'greet-ko', repeat: 0, attempt: 1, segment: 1, seed: 235035669, costUsd: 0 };

/** An `ok` attempt line; the defaults make a normal answer (data-model §Trial Outcomes row 11). */
export function okLine(fields: Record<string, unknown> = {}): AttemptLine {
  return attemptLineSchema.parse({
    ...KEY,
    status: 'ok',
    raw: '안녕! 오늘 어땠어?',
    answers: 1,
    finalKind: 'model',
    final: '안녕! 오늘 어땠어?',
    finishReason: 'stop',
    latencyMs: 800,
    ...fields,
  });
}

export function errorLine(
  kind: 'config' | 'adapter' | 'transient' | 'permanent' | 'timeout',
  fields: Record<string, unknown> = {},
): AttemptLine {
  return attemptLineSchema.parse({
    ...KEY,
    status: 'error',
    error: { kind, message: `${kind} failure` },
    ...fields,
  });
}

export function stoppedLine(fields: Record<string, unknown> = {}): AttemptLine {
  return attemptLineSchema.parse({ ...KEY, status: 'stopped', costEstimated: true, ...fields });
}
