// The render behaviours of the scenario service (scenario.mjs), for the render-mode tests
// (helper-api §Render Mode), named and parameterised as in the Python scenario services
// (behaviours_render.py).
//
// - `bodies`: sends each request of `service.params.requests` in order through the case API's
//   SDK. A request is the JSON body of the create method, with `model` set to the variant model
//   when absent. The function returns the last response's text, or `service.params.result` when
//   given. With `onError` `swallow` a request that throws is passed over; otherwise its exception
//   ends the function.
// - `render-probe`: sends each probe of `service.params.probes`, `{"model": m, "context": "trial"
//   | "none"}`, as a one-line request to model m (`none`: outside the trial context), with the
//   SDK's `maxRetries` set to `service.params.maxRetries`. It notes how each ended: `{"model",
//   "status", "type", "shouldRetry"}` from an error response (the error object's type and the
//   `x-should-retry` header, null when absent), or `{"model", "status": 200}`. Then it sends the
//   variant model a request with the system `Report.`, `maxTokens` 64 and, as the user message,
//   the JSON of `{"calls": the models of the calls the target function's third argument holds at
//   that point, "case": the case's fields, "probes": the notes}` with keys sorted and no spaces,
//   and returns its text. Every value of that JSON is ASCII, so the text is the same in both
//   languages.
// - `rendering-fake`: the `flow` behaviour (behaviours_flow.mjs), except that a call with
//   `fakeInRender` is not sent when `case.rendering` is true: the service takes that text as the
//   call's answer instead, as a service that replaces a call before the answer with a fake in
//   render mode does.

import { Flow, receivedOf, responseText } from './behaviours_flow.mjs';
import { makeStepsClient, requestArguments } from './behaviours_steps.mjs';
import { isObject, outsideTrial, resource, sortedJson } from './support.mjs';

const PROBE_USER = 'Probe.';
const PROBE_MAX_TOKENS = 16;
const REPORT_SYSTEM = 'Report.';
const REPORT_MAX_TOKENS = 64;

// bodies

async function bodies(run) {
  const client = await makeStepsClient(run.params);
  let text = '';
  for (const request of run.params.requests) {
    const body = { model: run.variant.model, ...request };
    try {
      text = responseText(run.api, await resource(client, run.api).create(body));
    } catch (error) {
      if (run.params.onError !== 'swallow') {
        throw error;
      }
    }
  }
  return run.params.result ?? text;
}

// render-probe

function header(headers, name) {
  if (headers === undefined || headers === null) {
    return null;
  }
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return value ?? null;
}

/** What the service sees of a failed request: status, error type and retry header. */
export function errorNote(model, error) {
  const body = error?.error;
  const inner = isObject(body) ? body.error : undefined;
  const source = isObject(inner) ? inner : body;
  return {
    model,
    status: typeof error?.status === 'number' ? error.status : null,
    type: isObject(source) && source.type !== undefined ? source.type : null,
    shouldRetry: header(error?.headers, 'x-should-retry'),
  };
}

function probeArguments(run, model) {
  return requestArguments(run.api, { model, maxTokens: PROBE_MAX_TOKENS }, model, PROBE_USER);
}

async function probe(run, client, model) {
  try {
    await resource(client, run.api).create(probeArguments(run, model));
  } catch (error) {
    return errorNote(model, error);
  }
  return { model, status: 200 };
}

/** One probe outside the trial context, from a client of its own. */
async function probeWithoutContext(run, model) {
  const client = await makeStepsClient(run.params);
  return outsideTrial(() => probe(run, client, model));
}

async function renderProbe(run) {
  const client = await makeStepsClient(run.params);
  const notes = [];
  for (const each of run.params.probes ?? []) {
    const model = String(each.model);
    notes.push(
      each.context === 'none'
        ? await probeWithoutContext(run, model)
        : await probe(run, client, model),
    );
  }
  const c = run.case;
  const report = {
    calls: [...run.calls].map((call) => call.model),
    case: {
      id: c.id,
      lang: c.lang,
      input: c.input,
      repeat: c.repeat,
      seed: c.seed,
      rendering: c.rendering,
    },
    probes: notes,
  };
  const request = { system: REPORT_SYSTEM, maxTokens: REPORT_MAX_TOKENS };
  const body = requestArguments(run.api, request, run.variant.model, sortedJson(report));
  return responseText(run.api, await resource(client, run.api).create(body));
}

// rendering-fake

/** A flow whose calls with `fakeInRender` are replaced by that text in render mode. */
class RenderingFakeFlow extends Flow {
  async call(spec) {
    const fake = spec.fakeInRender;
    if (fake === undefined || !this.run.case.rendering) {
      return super.call(spec);
    }
    const { body, options, conversation } = this.prepare(spec);
    const received = receivedOf(body, options, conversation);
    received.text = String(fake);
    return this.finish(spec, received);
  }
}

async function renderingFake(run) {
  const runner = new RenderingFakeFlow(run);
  for (const step of run.params.steps ?? []) {
    await runner.step(step);
  }
  return runner.result(run.params.result);
}

export const BEHAVIOURS = {
  bodies,
  'render-probe': renderProbe,
  'rendering-fake': renderingFake,
};
