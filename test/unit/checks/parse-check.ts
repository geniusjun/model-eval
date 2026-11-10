import type { CheckOfType } from '../../../src/checks/result.js';
import { gradingCheckSchema, type GradingCheck } from '../../../src/config/schema.js';

function hasType<T extends GradingCheck['type']>(
  check: GradingCheck,
  type: T,
): check is CheckOfType<T> {
  return check.type === type;
}

/** Parses a check through the loader schema, so defaults such as `normalize` apply. */
export function parseCheck<T extends GradingCheck['type']>(
  type: T,
  fields: Record<string, unknown> = {},
): CheckOfType<T> {
  const check = gradingCheckSchema.parse({ type, ...fields });
  if (!hasType(check, type)) {
    throw new Error(`parsed a ${check.type} check, expected ${type}`);
  }
  return check;
}

export const NO_VALUES = { input: {} } as const;
