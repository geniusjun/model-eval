import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  hashValue,
  parseJsonText,
  sha256OfText,
  shortHex,
} from '../../src/adapter/canonical-json.js';
import type { JsonValue } from '../../src/adapter/json-value.js';
import { SHA256_PATTERN } from '../../src/config/identifiers.js';

describe('canonical JSON', () => {
  it('001 FR-014 sorts keys by UTF-16 code units at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 0, y: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":1,"z":0}]},"b":1}',
    );
    // U+20000 is the surrogate pair D840 DC00, which sorts before U+FF61 by code unit
    // although its code point is larger.
    expect(canonicalJson({ '\uff61': 1, '\u{20000}': 2 })).toBe('{"\u{20000}":2,"\uff61":1}');
    expect(canonicalJson({ é: 1, e: 2, E: 3 })).toBe('{"E":3,"e":2,"é":1}');
  });

  it('001 FR-014 escapes only quote, backslash and control characters', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
    expect(canonicalJson('\u0000\u001f\u000b')).toBe('"\\u0000\\u001f\\u000b"');
    expect(canonicalJson('\u007f\u2028\u2029 한글 /</script>')).toBe(
      '"\u007f\u2028\u2029 한글 /</script>"',
    );
  });

  it('001 FR-014 writes lone surrogates as lowercase escapes and keeps pairs as is', () => {
    expect(canonicalJson('\ud800x\udfff')).toBe('"\\ud800x\\udfff"');
    expect(canonicalJson('\uDABC')).toBe('"\\udabc"');
    expect(canonicalJson('\u{20000}')).toBe('"\u{20000}"');
  });

  it('001 FR-014 writes numbers in ECMAScript notation', () => {
    const cases: [number, string][] = [
      [1, '1'],
      [1.0, '1'],
      [-0, '0'],
      [0.1, '0.1'],
      [1e-7, '1e-7'],
      [1e21, '1e+21'],
      [123456789012345680000, '123456789012345680000'],
      [5e-324, '5e-324'],
    ];
    for (const [value, text] of cases) {
      expect(canonicalJson(value)).toBe(text);
    }
  });

  it('001 FR-014 writes literals and arrays without whitespace', () => {
    expect(canonicalJson([true, false, null, [], {}])).toBe('[true,false,null,[],{}]');
  });

  it('001 FR-014 rejects values that cannot be canonical', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson({ a: [Number.NEGATIVE_INFINITY] })).toThrow(TypeError);
    const withUndefined = { a: undefined } as unknown as JsonValue;
    expect(() => canonicalJson(withUndefined)).toThrow(TypeError);
  });

  it('001 FR-014 rejects a list with an undefined element or a hole', () => {
    const undefinedElement = [1, undefined] as unknown as JsonValue;
    expect(() => canonicalJson(undefinedElement)).toThrow(TypeError);
    // eslint-disable-next-line no-sparse-arrays
    const hole = [, 1] as unknown as JsonValue;
    expect(() => canonicalJson(hole)).toThrow(TypeError);
    // eslint-disable-next-line no-sparse-arrays
    const nestedHole = { tools: [{ enum: ['a', , 'b'] }] } as unknown as JsonValue;
    expect(() => canonicalJson(nestedHole)).toThrow(TypeError);
  });
});

describe('reading JSON text', () => {
  it('001 FR-014 treats numbers too large for a double as not JSON', () => {
    expect(parseJsonText('{"a":1e400}').ok).toBe(false);
    expect(parseJsonText('[-1e400]').ok).toBe(false);
    expect(parseJsonText('NaN').ok).toBe(false);
    expect(parseJsonText('{"a":Infinity}').ok).toBe(false);
  });

  it('001 FR-014 keeps the last value of a duplicate name', () => {
    expect(parseJsonText('{"a":1,"a":2}')).toEqual({ ok: true, value: { a: 2 } });
  });
});

describe('hashes and IDs', () => {
  it('001 FR-014 writes sha256: plus 64 lowercase hex digits of the canonical JSON', () => {
    const value = { b: [1, 2], a: 'x' };
    const expected = createHash('sha256').update('{"a":"x","b":[1,2]}', 'utf8').digest('hex');
    const hash = hashValue(value);
    expect(hash).toBe(`sha256:${expected}`);
    expect(hash).toMatch(SHA256_PATTERN);
    expect(hashValue({ a: 'x', b: [1, 2] })).toBe(hash);
  });

  it('001 FR-014 hashes text as UTF-8', () => {
    const expected = createHash('sha256').update(Buffer.from('한', 'utf8')).digest('hex');
    expect(sha256OfText('한')).toBe(`sha256:${expected}`);
  });

  it('001 FR-014 takes the first 12 hex digits for IDs', () => {
    const hash = hashValue({ id: 1 });
    expect(shortHex(hash)).toBe(hash.slice(7, 19));
    expect(shortHex(hash)).toMatch(/^[0-9a-f]{12}$/);
  });
});
