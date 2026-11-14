// The stdout steps service: an adapter whose target function writes to standard output in the
// ways `service.params.steps` of `MODEL_EVAL_SCENARIO` lists, then answers with one model request.
//
// - `{"write": text}`: `process.stdout.write`.
// - `{"console": text}`: `console.log`, `console.info` and `console.debug`, each with its name.
// - `{"fd": text}`: `fs.writeSync(1, …)`, as a native module writing to descriptor 1 does.
// - `{"child": text}`: a child process that shares descriptor 1 writes the text and a newline.
// - `{"call": request}`: one model request; the function returns its text unless a later step
//   returns.
// - `{"return": text}`.
//
// The module of stdout_import_noise.mjs is imported after the helper, as a service module is.

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { writeSync } from 'node:fs';
import process from 'node:process';

import { defineAdapter } from 'model-eval/adapter';

import './stdout_import_noise.mjs';
import { ask, makeClient } from './one_call.mjs';

const spec = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}');
const steps = spec.service?.params?.steps ?? [];

async function generate(c, variant) {
  const client = await makeClient();
  let text;
  for (const step of steps) {
    if ('write' in step) {
      process.stdout.write(step.write);
    } else if ('console' in step) {
      console.log(`${step.console} (log)`);
      console.info(`${step.console} (info)`);
      console.debug(`${step.console} (debug)`);
    } else if ('fd' in step) {
      writeSync(1, step.fd);
    } else if ('child' in step) {
      const script = `process.stdout.write(${JSON.stringify(`${step.child}\n`)})`;
      spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'inherit'] });
    } else if ('call' in step) {
      text = await ask(client, spec.api, { model: variant.model, ...step.call });
    } else if ('return' in step) {
      return step.return;
    }
  }
  return text;
}

defineAdapter({
  name: 'stdout-steps',
  version: '0.0.1',
  targets: { chat: { languages: ['en'], generate } },
}).listen();
