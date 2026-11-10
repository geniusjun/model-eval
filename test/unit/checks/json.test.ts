import { describe, expect, it } from 'vitest';

import { checkJson } from '../../../src/checks/json.js';
import { parseCheck } from './parse-check.js';

const anyJson = parseCheck('json');

const reply = parseCheck('json', {
  schema: {
    type: 'object',
    required: ['reply'],
    properties: { reply: { type: 'string' } },
  },
});

describe('json check', () => {
  it('001 FR-017 without a schema passes any JSON text', () => {
    expect(checkJson(anyJson, '{"reply": "hi"}')).toEqual({ outcome: 'pass' });
    expect(checkJson(anyJson, ' [1, 2]\n')).toEqual({ outcome: 'pass' });
    expect(checkJson(anyJson, 'null')).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 fails text that is not JSON', () => {
    expect(checkJson(anyJson, 'reply: hi')).toEqual({ outcome: 'fail', evidence: [] });
    expect(checkJson(anyJson, '```json\n{}\n```')).toEqual({ outcome: 'fail', evidence: [] });
    expect(checkJson(anyJson, '')).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 fails a number too large for a double, as data-model Canonical JSON reads it', () => {
    expect(checkJson(anyJson, '{"n": 1e400}')).toEqual({ outcome: 'fail', evidence: [] });
  });

  it('001 FR-017 fails a schema violation, naming where and why', () => {
    expect(checkJson(reply, '{"reply": "hi"}')).toEqual({ outcome: 'pass' });
    expect(checkJson(reply, '{"reply": 1}')).toEqual({
      outcome: 'fail',
      evidence: ['/reply must be string'],
    });
    expect(checkJson(reply, '{}')).toEqual({
      outcome: 'fail',
      evidence: ["/ must have required property 'reply'"],
    });
  });

  it('001 FR-017 validates with JSON Schema draft 2020-12', () => {
    const tuple = parseCheck('json', {
      schema: { type: 'array', prefixItems: [{ type: 'string' }], items: false },
    });
    expect(checkJson(tuple, '["a"]')).toEqual({ outcome: 'pass' });
    expect(checkJson(tuple, '["a", 1]').outcome).toBe('fail');
    const never = parseCheck('json', { schema: false });
    expect(checkJson(never, '{}').outcome).toBe('fail');
  });

  it('001 FR-017 treats unknown keywords and format as annotations, as draft 2020-12 does', () => {
    const annotated = parseCheck('json', {
      schema: { type: 'string', format: 'email', 'x-note': 'shown to people' },
    });
    expect(checkJson(annotated, '"not an address"')).toEqual({ outcome: 'pass' });
  });

  it('001 FR-017 cannot run with a schema that does not compile', () => {
    const broken = parseCheck('json', { schema: { type: 'nonsense' } });
    const result = checkJson(broken, '{}');
    expect(result.outcome).toBe('error');
    expect(result).toMatchObject({ problem: { code: 'invalid-schema' } });
  });
});
