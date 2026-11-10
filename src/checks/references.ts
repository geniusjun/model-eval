import { textListAt, type CaseValues } from '../config/paths.js';
import { checkError, type CheckError } from './result.js';

export type TextsFrom =
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false; readonly error: CheckError };

/**
 * Reads the strings a `…From` path names (data-model §Check). A missing `ignoreFrom` or
 * `withFrom` value is an empty list; a missing `anyFrom` value cannot be graded.
 */
export function textsFrom(
  path: string | undefined,
  values: CaseValues,
  whenMissing: 'empty' | 'unresolved',
): TextsFrom {
  if (path === undefined) {
    return { ok: true, values: [] };
  }
  const list = textListAt(path, values);
  switch (list.kind) {
    case 'list':
      return { ok: true, values: list.values };
    case 'missing':
      return whenMissing === 'empty'
        ? { ok: true, values: [] }
        : { ok: false, error: checkError({ code: 'unresolved-ref', path }) };
    case 'not-text':
      return { ok: false, error: checkError({ code: 'not-text', path }) };
  }
}
