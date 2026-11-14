// The scenario service with the SDK imported at module level right after the helper, as most
// services do (S-UNC-01), instead of on first use. Import order is the point of this file.

import 'model-eval/adapter';

import process from 'node:process';

await import(process.env.MODEL_EVAL_SDK ?? '');
await import('./scenario.mjs');
