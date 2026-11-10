import { z } from 'zod';

import { jsonObjectSchema } from '../adapter/json-value.js';
import { idSchema } from './identifiers.js';
import { CASE_PATH_PATTERN } from './paths.js';

const casePathSchema = z
  .string()
  .regex(CASE_PATH_PATTERN, 'must be a path into the case, such as input.nickname or params.words');

const unitInterval = z.number().gt(0).lt(1);
const share = z.number().min(0).max(1);
const usd = z.number().min(0);

function isValidRegex(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

export const severitySchema = z.enum(['blocking', 'major', 'minor']);
export const surfaceSchema = z.enum(['raw', 'final', 'trial']);
export const langSchema = z.enum(['en', 'ko']);

// Checks

const scriptCheck = z.strictObject({
  type: z.literal('script'),
  allow: z.array(z.string().min(1)).min(1),
  ignore: z.array(z.string()).optional(),
  ignoreFrom: casePathSchema.optional(),
});

const emojiCheck = z.strictObject({ type: z.literal('emoji') });

const patternCheck = z
  .strictObject({
    type: z.literal('pattern'),
    regex: z.string().min(1),
    flags: z
      .string()
      .regex(/^(?!.*(.).*\1)[ims]*$/, 'accepts only i, m and s, each at most once')
      .optional(),
    mode: z.enum(['forbid', 'require']),
  })
  .refine((check) => isValidRegex(check.regex, `u${check.flags ?? ''}`), {
    message: 'is not a valid regular expression with the u flag',
    path: ['regex'],
  });

// A check without anything to compare against checks nothing (data-model §Check). The refine
// enforces it in the loader; the `anyOf` metadata carries the same rule into the JSON Schema.

function needsOneOf(first: string, second: string): { anyOf: { required: string[] }[] } {
  return { anyOf: [{ required: [first] }, { required: [second] }] };
}

const phrasesCheck = z
  .strictObject({
    type: z.literal('phrases'),
    any: z.array(z.string().min(1)).optional(),
    anyFrom: casePathSchema.optional(),
    mode: z.enum(['forbid', 'require']),
    normalize: z.boolean().default(true),
  })
  .refine((check) => check.any !== undefined || check.anyFrom !== undefined, {
    message: 'needs any or anyFrom',
  })
  .meta(needsOneOf('any', 'anyFrom'));

const overlapCheck = z
  .strictObject({
    type: z.literal('overlap'),
    with: z.array(z.string().min(1)).optional(),
    withFrom: casePathSchema.optional(),
    minChars: z.int().min(1),
  })
  .refine((check) => check.with !== undefined || check.withFrom !== undefined, {
    message: 'needs with or withFrom',
  })
  .meta(needsOneOf('with', 'withFrom'));

const lengthCheck = z
  .strictObject({
    type: z.literal('length'),
    min: z.int().min(0).optional(),
    max: z.int().min(0).optional(),
    unit: z.enum(['chars', 'graphemes']),
  })
  .refine((check) => check.min !== undefined || check.max !== undefined, {
    message: 'needs min or max',
  })
  .meta(needsOneOf('min', 'max'));

const jsonCheck = z.strictObject({
  type: z.literal('json'),
  schema: z.union([z.boolean(), jsonObjectSchema]).optional(),
});

const allCheck = z.strictObject({
  type: z.literal('all'),
  get checks(): z.ZodArray<typeof gradingCheckSchema> {
    return z.array(gradingCheckSchema).min(1);
  },
});

const anyCheck = z.strictObject({
  type: z.literal('any'),
  get checks(): z.ZodArray<typeof gradingCheckSchema> {
    return z.array(gradingCheckSchema).min(1);
  },
});

const notCheck = z.strictObject({
  type: z.literal('not'),
  get check(): typeof gradingCheckSchema {
    return gradingCheckSchema;
  },
});

/** Checks that grade a text surface; the only ones `all`, `any` and `not` may contain. */
export const gradingCheckSchema = z
  .discriminatedUnion('type', [
    scriptCheck,
    emojiCheck,
    patternCheck,
    phrasesCheck,
    overlapCheck,
    lengthCheck,
    jsonCheck,
    allCheck,
    anyCheck,
    notCheck,
  ])
  .meta({ id: 'GradingCheck' });

const completedCheck = z.strictObject({ type: z.literal('completed') });

const reviewCheck = z.strictObject({
  type: z.literal('review'),
  samples: z.int().min(1).default(3),
});

export const checkSchema = z.discriminatedUnion('type', [
  gradingCheckSchema,
  completedCheck,
  reviewCheck,
]);

// Rules

export const anchorSchema = z.strictObject({
  lang: z.string().min(1),
  quote: z.string().min(1),
  target: z.string().min(1).optional(),
  cases: z.array(idSchema).optional(),
});

export const originSchema = z.strictObject({
  commit: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  layer: z.enum(['prompt', 'code', 'pipeline']).optional(),
});

const examplesSchema = z.strictObject({
  pass: z.array(z.string()),
  fail: z.array(z.string()),
  input: jsonObjectSchema.optional(),
  params: jsonObjectSchema.optional(),
});

export const ruleSchema = z
  .strictObject({
    id: idSchema,
    title: z.string().min(1),
    severity: severitySchema,
    status: z.enum(['active', 'retired']).default('active'),
    scope: z.enum(['global', 'listed']).default('listed'),
    targets: z.array(z.string().min(1)).default([]),
    languages: z.array(z.string().min(1)).default([]),
    anchors: z.array(anchorSchema).default([]),
    check: checkSchema,
    gateOn: z.enum(['raw', 'final', 'both']).default('raw'),
    margin: unitInterval.optional(),
    examples: examplesSchema.optional(),
    origin: z.array(originSchema).default([]),
  })
  .refine(
    (rule) =>
      rule.examples === undefined ||
      (rule.check.type !== 'review' && rule.check.type !== 'completed'),
    { message: 'examples are not allowed on review or completed checks', path: ['examples'] },
  );

export const rulesFileSchema = z.strictObject({ rules: z.array(ruleSchema) });

// Cases

const caseRuleSchema = z.union([
  idSchema,
  z.strictObject({ id: idSchema, params: jsonObjectSchema.optional() }),
]);

export const caseSchema = z.strictObject({
  id: idSchema,
  target: z.string().min(1),
  lang: z.string().min(1).optional(),
  provenance: z.enum(['synthetic', 'derived']),
  input: jsonObjectSchema,
  rules: z.array(caseRuleSchema).default([]),
  note: z.string().optional(),
});

export const casesFileSchema = z.strictObject({ cases: z.array(caseSchema) });

// Config

export const variantSchema = z.strictObject({
  id: idSchema,
  model: z.string().min(1),
  params: jsonObjectSchema.optional(),
});

export const priceSchema = z.strictObject({
  input: usd,
  cachedInput: usd.optional(),
  cacheWrite: usd.optional(),
  output: usd,
});

export const gateConfigSchema = z.strictObject({
  severities: z.array(severitySchema).default([]),
  margin: unitInterval.default(0.1),
});

export const statsConfigSchema = z.strictObject({
  confidence: unitInterval.default(0.95),
  minCases: z.int().min(3).default(3),
});

export const reportConfigSchema = z.strictObject({
  lowBaseline: share.default(0.9),
  samples: z.int().min(0).default(3),
  warn: z
    .strictObject({
      transientRate: share.default(0.05),
      discardRateIncrease: share.default(0.01),
      regenerationRateIncrease: share.default(0.03),
      latencyP95Ratio: z.number().gt(0).default(1.5),
      costRatio: z.number().gt(0).default(2),
    })
    .prefault({}),
});

export const redactRuleSchema = z
  .strictObject({ pattern: z.string().min(1), replace: z.string().min(1) })
  .refine((rule) => isValidRegex(rule.pattern, 'gu'), {
    message: 'is not a valid regular expression with the u flag',
    path: ['pattern'],
  })
  .refine((rule) => !isValidRegex(rule.pattern, 'gu') || !new RegExp(rule.pattern, 'u').test(''), {
    message: 'matches the empty string, so it would insert the replacement everywhere',
    path: ['pattern'],
  });

export const configSchema = z.strictObject({
  version: z.literal(1),
  lang: langSchema.default('en'),
  adapter: z.strictObject({
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).default('.'),
    env: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.int().min(1).default(120_000),
  }),
  files: z
    .strictObject({
      rules: z.string().min(1).default('rules/**/*.yaml'),
      cases: z.string().min(1).default('cases/**/*.yaml'),
    })
    .prefault({}),
  variants: z.array(variantSchema).min(1),
  pricing: z.record(z.string().min(1), priceSchema),
  sampling: z
    .strictObject({
      repeats: z.int().min(1).default(5),
      seed: z.int().min(0).max(Number.MAX_SAFE_INTEGER).default(1729),
    })
    .prefault({}),
  stats: statsConfigSchema.prefault({}),
  gate: gateConfigSchema.prefault({}),
  run: z
    .strictObject({
      concurrency: z.int().min(1).default(4),
      retries: z.int().min(0).default(2),
      maxAdapterErrorRate: share.default(0.05),
      maxTransientRate: share.default(0.5),
    })
    .prefault({}),
  budget: z.strictObject({ maxCostUsd: usd.nullable().default(1) }).prefault({}),
  estimate: z
    .strictObject({
      outputTokens: z.int().min(1).default(600),
      inputTokens: z.int().min(1).optional(),
    })
    .prefault({}),
  report: reportConfigSchema.prefault({}),
  output: z.strictObject({ dir: z.string().min(1).default('.model-eval') }).prefault({}),
  redact: z.array(redactRuleSchema).default([]),
});

export type Severity = z.infer<typeof severitySchema>;
export type Surface = z.infer<typeof surfaceSchema>;
export type Lang = z.infer<typeof langSchema>;
export type GradingCheck = z.infer<typeof gradingCheckSchema>;
export type Check = z.infer<typeof checkSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Origin = z.infer<typeof originSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type RulesFile = z.infer<typeof rulesFileSchema>;
export type Case = z.infer<typeof caseSchema>;
export type CasesFile = z.infer<typeof casesFileSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Price = z.infer<typeof priceSchema>;
export type GateConfig = z.infer<typeof gateConfigSchema>;
export type StatsConfig = z.infer<typeof statsConfigSchema>;
export type ReportConfig = z.infer<typeof reportConfigSchema>;
export type RedactRule = z.infer<typeof redactRuleSchema>;
export type Config = z.infer<typeof configSchema>;
