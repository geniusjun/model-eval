// The `returns` behaviour of the scenario service (scenario.mjs): the steps of the `flow`
// behaviour, then a return value that is not text (helper-api §Return Values), named as in the
// Python scenario services (behaviours_returns.py).
//
//     {"steps": [step, ...], "value": "none" | "fallback-number" | "coroutine" | "plain-object"}
//
// - `none`: the function returns `undefined`, as one with a missing `return` does.
// - `fallback-number`: it returns `fallback(123)`, a fallback of a value that is not text.
// - `coroutine`: it returns the promise of a service function that makes one model request and
//   returns its text, so the helper awaits it.
// - `plain-object`: it returns `{final, raw}` as a plain object, not built with `result()`; the
//   TypeScript part of S-RESP-13.

import { conversationOf, Flow, requestBody, sendAsync } from './behaviours_flow.mjs';
import { helperExport, makeClient } from './support.mjs';

/** A service function: one request through a client of its own. */
async function answer(run) {
  const conversation = conversationOf('You are a helpful assistant.');
  conversation.items.push({ role: 'user', content: 'Say hello.' });
  const { body, options } = requestBody(run.api, conversation, {}, run.variant.model);
  const client = await makeClient({ maxRetries: 0 });
  const [, text] = await sendAsync(run.api, {}, body, options, client);
  return text;
}

async function returns(run) {
  const runner = new Flow(run);
  for (const step of run.params.steps ?? []) {
    await runner.step(step);
  }
  if (run.params.value === 'coroutine') {
    return answer(run);
  }
  if (run.params.value === 'fallback-number') {
    return helperExport('fallback')(123);
  }
  if (run.params.value === 'plain-object') {
    return { final: 'Hello.', raw: 'Hello.' };
  }
  return undefined;
}

export const BEHAVIOURS = { returns };
