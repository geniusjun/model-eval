import { z } from 'zod';

import { comparisonIdSchema, gradeSetIdSchema, idSchema } from '../config/identifiers.js';
import { lintFindingSchema } from '../config/diagnostics.js';
import { surfaceSchema } from '../config/schema.js';
import {
  basisSchema,
  runIdSchema,
  runStatusSchema,
  stopReasonSchema,
  swapIdSchema,
} from '../run/manifest.js';
import { warningSchema } from '../run/warning.js';
import { comparisonSchema, gateSchema, SCHEMA_VERSION } from '../report/schema.js';
import { EXIT_CODES, EXIT_NAMES, type ExitCode, type ExitName } from './exit-codes.js';

// The `--json` envelope and one `result` per command (contracts/cli.md §`--json` Output).

export const COMMANDS = ['init', 'lint', 'run', 'grade', 'compare', 'swap', 'report'] as const;
export type Command = (typeof COMMANDS)[number];

const exitSchema = z.union(
  EXIT_NAMES.map((name) => z.object({ code: z.literal(EXIT_CODES[name]), name: z.literal(name) })),
);

/** Lint codes and run or comparison warning codes, in the comparison's warning shape. */
/** Run, comparison and lint warnings share one shape; `excluded-from-gate` is in both sets. */
export const envelopeWarningSchema = z
  .union([warningSchema, lintFindingSchema])
  .meta({ id: 'EnvelopeWarning' });

const count = z.int().min(0);
const nullableUsd = z.number().min(0).nullable();

/** What `run --dry-run` and `swap --dry-run` report instead of starting (contracts/cli.md). */
export const dryRunPlanSchema = z
  .object({
    variants: z.array(
      z.object({
        variant: idSchema,
        trials: count,
        calls: count,
        inputTokens: count,
        outputTokens: count,
        basis: basisSchema,
        reservationUsd: nullableUsd,
      }),
    ),
    expectedUsd: nullableUsd,
    conservativeUsd: nullableUsd,
    maxCostUsd: nullableUsd,
    cells: z.array(
      z.object({
        ruleId: idSchema,
        lang: z.string().min(1),
        surface: surfaceSchema,
        plannedTrials: count,
        nMin: z.int().min(1),
      }),
    ),
  })
  .meta({ id: 'DryRunPlan' });

const dryRunResultSchema = z.object({ plan: dryRunPlanSchema });

export const resultSchemas = {
  init: z.object({
    created: z.array(z.string().min(1)),
    gitignoreUpdated: z.boolean(),
  }),
  lint: z.object({
    errors: z.array(lintFindingSchema),
    info: z.array(lintFindingSchema),
  }),
  run: z.union([
    z.object({
      runId: runIdSchema,
      status: runStatusSchema,
      stopReason: stopReasonSchema.optional(),
      gradeSetId: gradeSetIdSchema.optional(),
    }),
    dryRunResultSchema,
  ]),
  grade: z.object({
    runId: runIdSchema,
    gradeSetId: gradeSetIdSchema,
    reused: z.boolean(),
  }),
  compare: z.object({
    comparison: comparisonSchema,
    gate: gateSchema,
  }),
  swap: z.union([
    z.object({
      swapId: swapIdSchema,
      runs: z.tuple([runIdSchema, runIdSchema]),
      comparison: comparisonSchema.optional(),
      gate: gateSchema.optional(),
    }),
    dryRunResultSchema,
  ]),
  report: z.object({
    comparisonId: comparisonIdSchema,
  }),
} as const satisfies Record<Command, z.ZodType>;

export function envelopeSchema<C extends Command>(command: C) {
  return z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    command: z.literal(command),
    exit: exitSchema,
    result: resultSchemas[command].nullable(),
    warnings: z.array(envelopeWarningSchema),
  });
}

/** The envelope of any command, also of one whose command line names no known command. */
export const anyEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  command: z.enum(COMMANDS).nullable(),
  exit: exitSchema,
  result: z.union(Object.values(resultSchemas)).nullable(),
  warnings: z.array(envelopeWarningSchema),
});

export type EnvelopeWarning = z.infer<typeof envelopeWarningSchema>;
export type CommandResult<C extends Command> = z.infer<(typeof resultSchemas)[C]>;

/** `result` is `null` when the command ended before it had one; `command` is `null` when unknown. */
export interface Envelope<C extends Command | null> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly command: C;
  readonly exit: { readonly code: ExitCode; readonly name: ExitName };
  readonly result: C extends Command ? CommandResult<C> | null : null;
  readonly warnings: readonly EnvelopeWarning[];
}
