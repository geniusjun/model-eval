// The `reply` and `steps` behaviours of the scenario service (scenario.mjs), named and
// parameterised as in the Python scenario services (behaviours_steps.py).
//
// - `reply`: one model request with `service.params` as a `call` step, then returns its text.
// - `steps`: runs `service.params.steps` in order and returns the last call's text unless a step
//   ends the function first. Steps:
//   - `{"call": request, "swallow": bool}`: one model request (`model`, `user`, `system`,
//     `stream`, `maxTokens`, `tools`); `swallow` goes on after the SDK's exception.
//   - `{"print": text}` (`console.log`), `{"write-fd": text}` (`fs.writeSync` on descriptor 1),
//     `{"child": text}` (a child process that shares descriptor 1 prints it): output the service
//     writes.
//   - `{"sleep": ms}`; `{"raise": {"class": name, "message": text}}`; `{"raise": {"value": v}}`
//     throws the JSON value itself, a thrown value that is not an `Error`.
//   - `{"background": request, "delay": ms}`: work not awaited that sends the request after the
//     delay, or rejects when the request is `{"raise": ...}`; its rejection is never handled.
//   - `{"thread": request}`: the request sent outside the trial context; the step waits for it.
//   - `{"child-request": request}`: a child process sends the request with `node:http`, outside
//     every captured transport.
//   - `{"return": text}`, `{"fallback": text | true}` (true: the last call's text).
//   - `{"report": "case" | "variant" | "calls" | "thread", "toolArgs": [name, ...]}`: returns, as
//     JSON text, the case's fields, the variant's, the call fields of the target function's third
//     argument under their TypeScript names (with `toolArgs(name)` for each name of `toolArgs`),
//     or whether the function runs on the main thread.
//
// The SDK client is created per trial with `maxRetries` from `service.params.maxRetries` (0 by
// default, so each scripted response is one call) and `timeout` from `timeoutS`.

import { eventText, responseText } from './behaviours_flow.mjs';
import { helperExport, makeClient, outsideTrial, resource, sleep } from './support.mjs';

import { execFile, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { isMainThread } from 'node:worker_threads';

const DEFAULT_USER = 'Say hello.';
const DEFAULT_MAX_TOKENS = 256;
const CALL_FIELDS = [
  'model',
  'messages',
  'toolNames',
  'text',
  'toolCalls',
  'finishReason',
  'usage',
  'outcome',
  'error',
  'retried',
];
const UNCAPTURED_POST = fileURLToPath(new URL('./uncaptured_post.mjs', import.meta.url));
const runFile = promisify(execFile);

// Requests

/** A new SDK client of the process's SDK, imported after the helper. */
export function makeStepsClient(params) {
  const options = { maxRetries: Number(params.maxRetries ?? 0) };
  if ('timeoutS' in params) {
    options.timeout = Number(params.timeoutS) * 1000;
  }
  return makeClient(options);
}

function toolDefinitions(api, names) {
  const schema = { type: 'object', properties: { text: { type: 'string' } } };
  if (api === 'chat-completions') {
    return names.map((name) => ({ type: 'function', function: { name, parameters: schema } }));
  }
  if (api === 'responses') {
    return names.map((name) => ({ type: 'function', name, parameters: schema }));
  }
  return names.map((name) => ({ name, input_schema: schema }));
}

/** The body of the SDK's create method. */
export function requestArguments(api, request, model, user) {
  const body = { model: String(request.model ?? model) };
  const text = String(request.user ?? user);
  const system = request.system;
  const maxTokens = request.maxTokens;
  if (request.tools?.length) {
    body.tools = toolDefinitions(api, [...request.tools]);
  }
  if (api === 'chat-completions') {
    const leading = system ? [{ role: 'system', content: system }] : [];
    body.messages = [...leading, { role: 'user', content: text }];
    if (maxTokens !== undefined && maxTokens !== null) {
      body.max_completion_tokens = maxTokens;
    }
  } else if (api === 'responses') {
    body.input = [{ role: 'user', content: text }];
    if (system) {
      body.instructions = system;
    }
    if (maxTokens !== undefined && maxTokens !== null) {
      body.max_output_tokens = maxTokens;
    }
  } else {
    body.messages = [{ role: 'user', content: text }];
    body.max_tokens = maxTokens || DEFAULT_MAX_TOKENS;
    if (system) {
      body.system = system;
    }
  }
  if (request.stream) {
    body.stream = true;
  }
  return body;
}

// Steps

/** One trial of the `steps` behaviour. */
class Steps {
  constructor(run) {
    this.run = run;
    this.api = run.api;
    this.lastText = '';
    this.client = undefined;
  }

  user() {
    return String((this.run.case.input ?? {}).user ?? DEFAULT_USER);
  }

  async call(request) {
    this.client ??= await makeStepsClient(this.run.params);
    const body = requestArguments(this.api, request, this.run.variant.model, this.user());
    const response = await resource(this.client, this.api).create(body);
    if (!body.stream) {
      this.lastText = responseText(this.api, response);
    } else {
      let text = '';
      for await (const event of response) {
        text += eventText(this.api, event);
      }
      this.lastText = text;
    }
    return this.lastText;
  }

  /** Runs one step; gives `{done: true, value}` when the step ends the function with that value. */
  async step(step) {
    if ('call' in step) {
      try {
        await this.call(step.call);
      } catch (error) {
        if (!step.swallow) {
          throw error;
        }
      }
    } else if ('print' in step) {
      globalThis.console.log(step.print);
    } else if ('write-fd' in step) {
      writeSync(1, String(step['write-fd']));
    } else if ('child' in step) {
      // The child shares descriptor 1, which the helper cannot redirect (helper-api §stdout
      // Protection).
      const code = `console.log(${JSON.stringify(String(step.child))})`;
      spawnSync(process.execPath, ['-e', code], { stdio: 'inherit' });
    } else if ('thread' in step) {
      await this.withoutContext(step.thread);
    } else if ('child-request' in step) {
      await this.childRequest(step['child-request']);
    } else if ('background' in step) {
      this.background(step.background, Number(step.delay ?? 0));
    } else if ('sleep' in step) {
      await sleep(Number(step.sleep));
    } else if ('raise' in step) {
      if ('value' in step.raise) {
        throw step.raise.value;
      }
      throw this.run.exception(step.raise.class, step.raise.message ?? '');
    } else if ('return' in step) {
      return { done: true, value: step.return };
    } else if ('fallback' in step) {
      const text = step.fallback === true ? this.lastText : step.fallback;
      return { done: true, value: helperExport('fallback')(text) };
    } else if ('report' in step) {
      const report = this.report(step.report, [...(step.toolArgs ?? [])]);
      return { done: true, value: JSON.stringify(report) };
    } else {
      throw new Error(`unknown step ${JSON.stringify(step)}`);
    }
    return { done: false };
  }

  background(request, delayMs) {
    const model = this.run.variant.model;
    const user = this.user();
    const clientMade = makeStepsClient(this.run.params);
    // Never awaited: a rejection is unhandled, as an exception of an `asyncio` task nobody awaits.
    void (async () => {
      const client = await clientMade;
      await sleep(delayMs);
      if ('raise' in request) {
        throw this.run.exception(request.raise.class, request.raise.message ?? '');
      }
      await resource(client, this.api).create(requestArguments(this.api, request, model, user));
    })();
  }

  async withoutContext(request) {
    const client = await makeStepsClient(this.run.params);
    const body = requestArguments(this.api, request, this.run.variant.model, this.user());
    await outsideTrial(() => resource(client, this.api).create(body));
  }

  async childRequest(request) {
    const { stream: _stream, ...body } = requestArguments(
      this.api,
      request,
      this.run.variant.model,
      this.user(),
    );
    await runFile(process.execPath, [UNCAPTURED_POST, this.api, JSON.stringify(body)]);
  }

  report(what, toolArgs) {
    if (what === 'case') {
      const c = this.run.case;
      return {
        id: c.id,
        lang: c.lang,
        input: c.input,
        repeat: c.repeat,
        seed: c.seed,
        rendering: c.rendering,
      };
    }
    if (what === 'variant') {
      const { id, model, params } = this.run.variant;
      return { id, model, params };
    }
    if (what === 'thread') {
      return { mainThread: isMainThread };
    }
    if (what === 'calls') {
      return [...this.run.calls].map((call) => callFields(call, toolArgs));
    }
    throw new Error(`unknown report ${what}`);
  }
}

/** A call's fields; a field the call does not have is null. */
function callFields(call, toolArgs) {
  const fields = Object.fromEntries(CALL_FIELDS.map((name) => [name, call[name] ?? null]));
  fields.toolArgs = Object.fromEntries(toolArgs.map((name) => [name, call.toolArgs(name) ?? null]));
  return fields;
}

async function runSteps(run, steps) {
  const trial = new Steps(run);
  for (const step of steps) {
    const { done, value } = await trial.step(step);
    if (done) {
      return value;
    }
  }
  return trial.lastText;
}

async function reply(run) {
  return runSteps(run, [{ call: run.params }]);
}

async function steps(run) {
  return runSteps(run, run.params.steps);
}

export const BEHAVIOURS = { reply, steps };
