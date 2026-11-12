import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalJson, parseJsonText, sha256OfText } from '../../../src/adapter/canonical-json.js';
import { isEmptyText } from '../../../src/grade/outcome.js';

// The shared value vectors both helpers are tested against agree with the tool itself, so a
// helper that passes them writes what the tool reads and hashes.

const VALUES = fileURLToPath(new URL('../../fixtures/helper/parity/values.json', import.meta.url));

const valuesSchema = z.object({
  whitespace: z.array(
    z.object({ name: z.string(), text: z.string(), trimmed: z.string(), empty: z.boolean() }),
  ),
  canonicalJson: z.array(
    z.object({ name: z.string(), text: z.string(), canonical: z.string(), sha256: z.string() }),
  ),
  notJson: z.array(z.object({ name: z.string(), text: z.string() })),
});

const values = valuesSchema.parse(JSON.parse(readFileSync(VALUES, 'utf8')));

/** Trimming with the same White_Space set `isEmptyText` uses; the tool has no trim of its own. */
function trimWhiteSpace(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

describe('shared helper values', () => {
  it.each(values.whitespace)('003 FR-024 whitespace: $name', ({ text, trimmed, empty }) => {
    expect(isEmptyText(text)).toBe(empty);
    expect(trimWhiteSpace(text)).toBe(trimmed);
  });

  it.each(values.canonicalJson)(
    '003 FR-024 canonical JSON: $name',
    ({ text, canonical, sha256 }) => {
      const parsed = parseJsonText(text);
      if (!parsed.ok) {
        throw new Error(`${JSON.stringify(text)} is JSON: ${parsed.reason}`);
      }
      expect(canonicalJson(parsed.value)).toBe(canonical);
      expect(sha256OfText(canonical)).toBe(sha256);
    },
  );

  it.each(values.notJson)('003 FR-024 not JSON: $name', ({ text }) => {
    expect(parseJsonText(text).ok).toBe(false);
  });
});
