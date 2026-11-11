import { realpathSync } from 'node:fs';

import { compareCodeUnits, hashValue, parseJsonText } from '../adapter/canonical-json.js';
import type { JsonValue } from '../adapter/json-value.js';
import type { RenderResult } from '../adapter/protocol.js';
import type { Sha256 } from '../config/identifiers.js';
import type { Case, Rule, Variant } from '../config/schema.js';

// The hashes of data-model §Identifiers and Hashing that a run records.

/**
 * The JSON value a record holds once written: keys whose value is `undefined` disappear, as
 * they do in the files.
 */
export function asJsonValue(value: unknown): JsonValue {
  const parsed = parseJsonText(JSON.stringify(value));
  if (!parsed.ok) {
    throw new TypeError(`not a JSON value: ${parsed.reason}`);
  }
  return parsed.value;
}

/** `{target, lang, input}`, only what generation uses; `lang` is the language key. */
export function caseHash(target: string, lang: string, input: Case['input']): Sha256 {
  return hashValue({ target, lang, input });
}

/** `active` rule definitions sorted by `id`, and per-case `rules` lists sorted by case `id`. */
export function rulesHash(rules: readonly Rule[], cases: readonly Case[]): Sha256 {
  const byId = <T extends { readonly id: string }>(a: T, b: T): number =>
    compareCodeUnits(a.id, b.id);
  return hashValue({
    rules: asJsonValue(rules.filter((rule) => rule.status === 'active').sort(byId)),
    cases: asJsonValue(
      [...cases].sort(byId).map(({ id, rules: listed }) => ({ id, rules: listed })),
    ),
  });
}

/** `{id, model, params}`; a variant without `params` hashes without the key. */
export function variantFingerprint(variant: Variant): Sha256 {
  return hashValue(asJsonValue({ id: variant.id, model: variant.model, params: variant.params }));
}

export interface LaunchSettings {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/**
 * `adapter.command`, `adapter.env` and the real path of `adapter.cwd`, with links and letter case
 * resolved, so another spelling of the same folder gives the same hash.
 */
export function launchHash(launch: LaunchSettings): Sha256 {
  return hashValue({
    command: [...launch.command],
    env: { ...launch.env },
    cwd: realpathSync.native(launch.cwd),
  });
}

/** The adapter's fingerprint, else the hash of the render's `{messages, tools}`. */
export function renderFingerprint(render: RenderResult): string {
  return (
    render.fingerprint ??
    hashValue(asJsonValue({ messages: render.messages, tools: render.tools ?? null }))
  );
}
