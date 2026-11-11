import { z } from 'zod';

import { idSchema } from './identifiers.js';

/**
 * Fields shared by lint findings, run and comparison warnings. Records hold no sentences the
 * tool composes: each code has the `params` of its data-model table row, and the message files
 * turn code and params into text (data-model §Warnings).
 */
export const findingFields = {
  ruleId: idSchema.optional(),
  lang: z.string().min(1).optional(),
  variants: z.array(idSchema).optional(),
  caseIds: z.array(idSchema).optional(),
  file: z.string().min(1).optional(),
  line: z.int().min(1).optional(),
  column: z.int().min(1).optional(),
};

/** Why a rule left the gate: the `excluded-from-gate` warning and lint finding share it. */
export const excludedCauseSchema = z.enum(['review', 'uncalibrated-judge']);

/** An object keyed by variant ID ("per variant" in the data-model Params columns). */
export function perVariant<T extends z.ZodType>(value: T) {
  return z.record(idSchema, value);
}

/** A finding whose code carries params. */
export function finding<C extends string, P extends z.ZodType>(code: C, params: P) {
  return z.object({ code: z.literal(code), params, ...findingFields });
}

/** A finding whose code has no params. */
export function bareFinding<C extends string>(code: C) {
  return z.object({ code: z.literal(code), ...findingFields });
}
