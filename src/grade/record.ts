import { z } from 'zod';

import { gradeSetIdSchema, idSchema, sha256Schema } from '../config/identifiers.js';
import { surfaceSchema } from '../config/schema.js';
import { runIdSchema } from '../run/manifest.js';

// Lines of grades/<gradeSetId>.jsonl (data-model §Grade and GradeSet): the grade set first,
// then one grade per line.

export const gradeOutcomeSchema = z.enum(['pass', 'fail', 'skip', 'error']);

export const gradeSchema = z
  .object({
    caseId: idSchema,
    repeat: z.int().min(0),
    ruleId: idSchema,
    surface: surfaceSchema,
    outcome: gradeOutcomeSchema,
    evidence: z.array(z.string()).min(1).optional(),
  })
  .meta({ id: 'Grade' });

export const gradeSetHeaderSchema = z
  .object({
    gradeSetId: gradeSetIdSchema,
    runId: runIdSchema,
    rulesHash: sha256Schema,
    checkerVersion: z.string().min(1),
    trialsFingerprint: sha256Schema,
    casesHash: sha256Schema,
  })
  .meta({ id: 'GradeSet' });

export type GradeOutcome = z.infer<typeof gradeOutcomeSchema>;
export type Grade = z.infer<typeof gradeSchema>;
export type GradeSetHeader = z.infer<typeof gradeSetHeaderSchema>;
