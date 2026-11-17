import { describe, expect, it } from 'vitest';

import {
  fallback,
  isFallback,
  isModelCallError,
  isResult,
  ModelCallError,
  result,
  type ResultFields,
} from '../../../src/helper/outcome.js';

describe('Result and ModelCallError values', () => {
  it('003 FR-018 an unknown field name is a TypeError when the value is created', () => {
    expect(() => result({ raw: 'Hi.', finish: 'stop' } as unknown as ResultFields)).toThrow(
      TypeError,
    );
    expect(
      () => new ModelCallError({ status: 429, retry_after_ms: 10 } as unknown as object),
    ).toThrow(TypeError);
  });

  it('003 FR-018 values are not checked when the value is created', () => {
    const odd = { kind: 'Model', answers: -1, usage: { tokens: 1.5 } } as unknown as ResultFields;
    expect(() => result(odd)).not.toThrow();
    expect(() => new ModelCallError({ status: 99, kind: 'refused' } as never)).not.toThrow();
  });

  it('003 FR-018 values built by another copy of the module are recognised by their mark', () => {
    const other = Object.defineProperty(
      { fields: { raw: 'Hi.' } },
      Symbol.for('model-eval.adapter.result'),
      {
        value: true,
      },
    );
    expect(isResult(other)).toBe(true);
    expect(isResult({ fields: { raw: 'Hi.' } })).toBe(false);
    expect(isResult(result({ raw: 'Hi.' }))).toBe(true);
    expect(isFallback(fallback('Sorry.'))).toBe(true);
    expect(isModelCallError(new ModelCallError({ status: 429 }))).toBe(true);
    expect(isModelCallError(new Error('429'))).toBe(false);
  });

  it('003 FR-018 a ModelCallError keeps a message only when it is text', () => {
    expect(new ModelCallError({ message: 'slow down', status: 429 }).message).toBe('slow down');
    expect(new ModelCallError({ message: 7, status: 429 } as never).message).toBe('');
  });
});
