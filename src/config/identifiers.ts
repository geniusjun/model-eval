import { z } from 'zod';

/** Rule, case and variant IDs appear in directory names and run IDs (data-model §Identifiers and Hashing). */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type Sha256 = `sha256:${string}`;

export const idSchema = z.string().regex(ID_PATTERN, 'must match ^[a-z0-9][a-z0-9._-]{0,63}$');

export const sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, 'must be sha256: plus 64 lowercase hex digits');

export const gradeSetIdSchema = z
  .string()
  .regex(/^gs-[0-9a-f]{12}$/, 'must be gs- plus 12 hex digits');
export const comparisonIdSchema = z
  .string()
  .regex(/^cmp-[0-9a-f]{12}$/, 'must be cmp- plus 12 hex digits');
