import { parseJsonText } from '../adapter/canonical-json.js';
import { compileSchema, schemaErrorText } from './json-schema.js';
import { checkError, fail, PASS, type CheckOfType, type CheckResult } from './result.js';

/**
 * Fails when the text is not JSON (as data-model §Canonical JSON reads it) or violates the
 * schema. The evidence names each violation by instance path and validator message. A schema
 * that does not compile is an error for every text, so it shows whatever the answer.
 */
export function checkJson(check: CheckOfType<'json'>, text: string): CheckResult {
  const schema = check.schema === undefined ? undefined : compileSchema(check.schema);
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
  return schema.validate(parsed.value)
    ? PASS
    : fail((schema.validate.errors ?? []).map(schemaErrorText));
}
