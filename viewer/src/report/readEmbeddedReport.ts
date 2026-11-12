import './jitless.js';

import { pageDataSchema, type PageData } from '../../../src/report/schema.js';

const DATA_BLOCK_ID = 'model-eval-data';

export interface InvalidData {
  /** The `schemaVersion` the data names, or null when it names none or is not JSON. */
  readonly foundVersion: string | null;
}

export type ReadResult =
  | { readonly ok: true; readonly page: PageData }
  | { readonly ok: false; readonly error: InvalidData };

type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function parseJson(text: string): JsonResult {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function foundVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) {
    return null;
  }
  const version = value.schemaVersion;
  return typeof version === 'string' || typeof version === 'number' ? String(version) : null;
}

/**
 * Reads the data block once and validates it with the schema feature 001 writes with
 * (page-data §Embedded Block). An unfilled template fails at `JSON.parse`.
 */
export function readEmbeddedReport(doc: Document): ReadResult {
  const text = doc.getElementById(DATA_BLOCK_ID)?.textContent ?? null;
  const parsed: JsonResult = text === null ? { ok: false } : parseJson(text);
  if (!parsed.ok) {
    return { ok: false, error: { foundVersion: null } };
  }
  const result = pageDataSchema.safeParse(parsed.value);
  return result.success
    ? { ok: true, page: result.data }
    : { ok: false, error: { foundVersion: foundVersion(parsed.value) } };
}
