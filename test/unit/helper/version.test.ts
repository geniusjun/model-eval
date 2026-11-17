import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../../../src/adapter/protocol.js';
import { BUNDLED_HELPER_VERSION } from '../../../src/lint/helper-version.js';

const HELPER = fileURLToPath(
  new URL('../../../adapters/python/model_eval_adapter.py', import.meta.url),
);

/**
 * The header: the lines before the first function or class, where a reader of a copied helper
 * finds its versions.
 */
function header(source: string): string {
  const firstDefinition = /^(?:def|class|async def) /m.exec(source);
  return firstDefinition === null ? source : source.slice(0, firstDefinition.index);
}

/** The string a module-level assignment `NAME = "…"` gives, or undefined. */
function declared(source: string, name: string): string | undefined {
  return new RegExp(`^${name}\\s*(?::\\s*str\\s*)?=\\s*"([^"]*)"\\s*$`, 'm').exec(source)?.[1];
}

describe('Python helper versions', () => {
  const source = readFileSync(HELPER, 'utf8');

  it('003 FR-004 FR-025 the header declares the bundled helper version', () => {
    expect(declared(header(source), 'HELPER_VERSION')).toBe(BUNDLED_HELPER_VERSION);
  });

  it('003 FR-004 the header declares the protocol version the tool speaks', () => {
    expect(declared(header(source), 'PROTOCOL_VERSION')).toBe(PROTOCOL_VERSION);
  });
});
