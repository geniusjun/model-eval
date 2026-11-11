import {
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from '../adapter/json-value.js';

/** `input.<key>…` or `params.<key>…`, the case values a check reads (data-model §Check). */
export const CASE_PATH_PATTERN = /^(?:input|params)(?:\.[^.\s]+)+$/;

export interface CaseValues {
  readonly input: JsonObject;
  readonly params?: JsonObject | undefined;
}

export type PathLookup = { found: true; value: JsonValue } | { found: false };

export type TextList =
  | { kind: 'list'; values: readonly string[] }
  | { kind: 'missing' }
  | { kind: 'not-text'; value: JsonValue };

export function lookupCasePath(path: string, values: CaseValues): PathLookup {
  const [root, ...keys] = path.split('.');
  let current: JsonValue | undefined = root === 'input' ? values.input : values.params;
  for (const key of keys) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) {
      return { found: false };
    }
    current = current[key];
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

/** A string is a one-item list; a list must hold strings only. */
export function textListAt(path: string, values: CaseValues): TextList {
  const lookup = lookupCasePath(path, values);
  if (!lookup.found) {
    return { kind: 'missing' };
  }
  const { value } = lookup;
  if (typeof value === 'string') {
    return { kind: 'list', values: [value] };
  }
  if (isJsonArray(value) && value.every(isString)) {
    return { kind: 'list', values: value };
  }
  return { kind: 'not-text', value };
}

function isString(value: JsonValue): value is string {
  return typeof value === 'string';
}
