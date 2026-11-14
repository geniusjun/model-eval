import { z } from 'zod';

import type { JsonObject, JsonValue } from './json-types.js';

export { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from './json-types.js';

/** Finite numbers only, so every accepted value has a canonical JSON form. */
export const jsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema),
    ]),
  )
  .meta({ id: 'JsonValue' });

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
