import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { canonicalJson, parseJsonText } from '../adapter/canonical-json.js';
import type { JsonObject } from '../adapter/json-value.js';
import { checkError, fail, PASS, type CheckOfType, type CheckResult } from './result.js';

type CompiledSchema =
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

/** Compiling is the costly part; the same schema is checked against many answers. */
const compiled = new Map<string, CompiledSchema>();

/**
 * Fails when the text is not JSON (as data-model §Canonical JSON reads it) or violates the
 * schema. The evidence names each violation by instance path and validator message. A schema
 * that does not compile is an error for every text, so it shows whatever the answer.
 */
export function checkJson(check: CheckOfType<'json'>, text: string): CheckResult {
  const schema = check.schema === undefined ? undefined : compile(check.schema);
  if (schema?.ok === false) {
    return checkError({ code: 'invalid-schema', detail: schema.detail });
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return fail([]);
  }
  if (schema === undefined) {
    return PASS;
  }
  return schema.validate(parsed.value) ? PASS : fail((schema.validate.errors ?? []).map(describe));
}

function compile(schema: boolean | JsonObject): CompiledSchema {
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

function describe(error: ErrorObject): string {
  const where = error.instancePath === '' ? '/' : error.instancePath;
  return `${where} ${error.message ?? error.keyword}`;
}
