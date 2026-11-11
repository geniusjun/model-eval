import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { canonicalJson } from '../adapter/canonical-json.js';
import type { JsonObject } from '../adapter/json-value.js';

// The one JSON Schema compiler of the tool: the `json` check and lint's case input check use it.

export type CompiledSchema =
  | { readonly ok: true; readonly validate: ValidateFunction }
  | { readonly ok: false; readonly detail: string };

// Draft 2020-12 semantics: unknown keywords and `format` are annotations, so neither strict
// mode nor format validation applies. `addUsedSchema: false` keeps one schema's `$id` from
// clashing with another that reuses it.
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
  addUsedSchema: false,
});

/** Keyed by canonical JSON, so the same schema compiles once however often it is checked. */
const compiled = new Map<string, CompiledSchema>();

export function compileSchema(schema: boolean | JsonObject): CompiledSchema {
  const key = canonicalJson(schema);
  const known = compiled.get(key);
  if (known !== undefined) {
    return known;
  }
  let result: CompiledSchema;
  try {
    result = { ok: true, validate: ajv.compile(schema) };
  } catch (error) {
    result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  compiled.set(key, result);
  return result;
}

/** A violation as instance path and validator message, `/` for the whole value. */
export function schemaErrorText(error: ErrorObject): string {
  const where = error.instancePath === '' ? '/' : error.instancePath;
  return `${where} ${error.message ?? error.keyword}`;
}
