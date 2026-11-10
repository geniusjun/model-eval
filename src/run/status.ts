import { z } from 'zod';

export const runStatusSchema = z.enum(['running', 'complete', 'partial']);

export const stopReasonSchema = z.enum([
  'interrupted',
  'budget',
  'budget-projected',
  'adapter-errors',
  'transient-errors',
  'config-error',
]);

export type RunStatus = z.infer<typeof runStatusSchema>;
export type StopReason = z.infer<typeof stopReasonSchema>;
