import { createHash } from 'node:crypto';

import type { Sha256 } from '../config/identifiers.js';
import { isJsonArray, type JsonObject, type JsonValue } from './json-value.js';

/**
 * Serialises a value per data-model §Canonical JSON: keys sorted by UTF-16 code units,
 * ECMAScript string escapes (lone surrogates as lowercase `\udXXX`) and number notation.
 * Throws on values that have no canonical form, such as NaN or infinity.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${String(value)} has no canonical JSON form`);
    }
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const members = Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(memberOf(value, key))}`);
  return `{${members.join(',')}}`;
}

export function sha256OfText(text: string): Sha256 {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function hashValue(value: JsonValue): Sha256 {
  return sha256OfText(canonicalJson(value));
}

/** The first 12 hex digits of a hash, the body of `gradeSetId` and `comparisonId`. */
export function shortHex(hash: Sha256): string {
  return hash.slice('sha256:'.length, 'sha256:'.length + 12);
}

export type ParsedJson = { ok: true; value: JsonValue } | { ok: false; reason: string };

/**
 * Reads JSON text with the reading rules of data-model §Canonical JSON: numbers too large
 * for a double make the text not JSON, and duplicate names keep the last value.
 */
export function parseJsonText(text: string): ParsedJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return containsNonFiniteNumber(parsed)
    ? { ok: false, reason: 'a number does not fit in a double' }
    : { ok: true, value: parsed as JsonValue };
}

/** String order by UTF-16 code units, the order canonical JSON sorts keys in. */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function memberOf(object: JsonObject, key: string): JsonValue {
  const member = object[key];
  if (member === undefined) {
    throw new TypeError(`member ${JSON.stringify(key)} has no JSON value`);
  }
  return member;
}

function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsNonFiniteNumber);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsNonFiniteNumber);
  }
  return false;
}
