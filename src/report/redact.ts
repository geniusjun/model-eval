import type { RedactRule } from '../config/schema.js';

/**
 * Fields that hold free text in written records (spec FR-031). Identifiers, hashes, codes
 * (a cell's `note` among them), model names and other enumerated values are written as they
 * are. No written record carries case notes; one that does names that field here.
 */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set([
  'raw',
  'final',
  'text',
  'message',
  'detail',
  'sentence',
  'discardReason',
  'capturedRaw',
  'evidence',
  'warnings',
  'title',
  'quote',
  'example',
]);

/** Applies the config `redact` rules to every surface of FR-031 except raw trial records. */
export interface Redactor {
  /** Redacts a whole line of human output. */
  text(value: string): string;
  /** Redacts the strings of free-text fields (and lists of them) inside a JSON-like value. */
  json(value: unknown): unknown;
}

export function createRedactor(rules: readonly RedactRule[]): Redactor {
  const compiled = rules.map((rule) => ({
    pattern: new RegExp(rule.pattern, 'gu'),
    replace: rule.replace,
  }));
  // A replacer function keeps `$&` and `$1` in `replace` literal; a zero-width match such as
  // `\b` replaces nothing, so the replacement is never inserted between characters.
  const text = (value: string): string =>
    compiled.reduce(
      (current, rule) =>
        current.replace(rule.pattern, (match) => (match === '' ? match : rule.replace)),
      value,
    );

  const freeText = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return text(value);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value.map(text);
    }
    return json(value);
  };
  const json = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(json);
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          FREE_TEXT_FIELDS.has(key) ? freeText(member) : json(member),
        ]),
      );
    }
    return value;
  };
  return { text, json };
}
