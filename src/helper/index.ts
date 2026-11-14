// `model-eval/adapter`: the TypeScript adapter helper (helper-api §TypeScript). Import it before
// the service: stdout protection and the `fetch` wrapper are installed when it is evaluated, in
// this order, before any service module and SDK client.

import './stdout.js';
import './capture.js';

export {
  type Adapter,
  type AdapterOptions,
  defineAdapter,
  type TargetOptions,
} from './protocol.js';
export {
  type Call,
  type CallError,
  type Case,
  fallback,
  ModelCallError,
  type ModelCallErrorFields,
  result,
  type ResultFields,
  type Variant,
} from './outcome.js';
