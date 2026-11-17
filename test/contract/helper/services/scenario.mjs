// Scenario service: the adapter that runs a case of test/fixtures/helper/scenarios/.
//
// `MODEL_EVAL_SCENARIO` holds the case's `service`, `target` and `adapter` as data, with the API
// (support/scenarios.ts `scenarioEnv`). Behaviours, named the same as in the Python scenario
// services, come from the `BEHAVIOURS` object of every `behaviours_*.mjs` module here; each takes
// a `Run`. The SDK of `MODEL_EVAL_SDK` is imported by the behaviours, after the helper.

import { helperExport, setupError } from './support.mjs';

import { readdirSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const { structuredClone } = globalThis;
const SPEC = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}');
const SERVICES_DIR = new URL('./', import.meta.url);

// Exceptions named by the fixtures

/** The builtin classes `builtins.<Name>` stands for. */
const BUILTINS = {
  Exception: Error,
  ValueError: TypeError,
  TypeError,
  RuntimeError: Error,
  LookupError: RangeError,
};
const EXCEPTIONS = new Map();

/**
 * The service exception class of that name, the same class each time it is asked for.
 *
 * Two forms name classes that are not new service classes, so `discardOn` holds them as a real
 * service's would and the helper's matching is checked with `instanceof`:
 *
 * - `builtins.Name` and `model_eval_adapter.Name`: an existing class (`builtins.Exception` is
 *   `Error`, `model_eval_adapter.ModelCallError` the helper's `ModelCallError`);
 * - `Name(Base)`: a new class `Name` that extends the builtin `Base`, known by `Name` alone too.
 */
function exceptionClass(name) {
  if (!EXCEPTIONS.has(name)) {
    const dot = name.indexOf('.');
    const [module, existing] = dot < 0 ? ['', ''] : [name.slice(0, dot), name.slice(dot + 1)];
    let found;
    if (module === 'builtins') {
      found = BUILTINS[existing];
    } else if (module === 'model_eval_adapter') {
      found = helperExport(existing);
    } else {
      const match = /^([^(]+)(?:\((.+)\))?$/.exec(name);
      const own = match?.[1] ?? name;
      const base = match?.[2] === undefined ? Error : BUILTINS[match[2]];
      if (base === undefined) {
        setupError(`${name} names no builtin base class`);
      }
      if (!EXCEPTIONS.has(own)) {
        EXCEPTIONS.set(own, { [own]: class extends base {} }[own]);
      }
      found = EXCEPTIONS.get(own);
    }
    if (typeof found !== 'function') {
      setupError(`${name} is not an exception class`);
    }
    EXCEPTIONS.set(name, found);
  }
  return EXCEPTIONS.get(name);
}

// One trial

/**
 * What a behaviour sees of one trial: the target function's arguments, the API, the backend and
 * `service.params`.
 */
class Run {
  constructor(c, variant, calls) {
    this.case = c;
    this.variant = variant;
    this.calls = calls;
    this.api = SPEC.api;
    this.backend = 'async';
    this.params = SPEC.service?.params ?? {};
  }

  exception(name, message) {
    const Class = exceptionClass(name);
    return new Class(message);
  }
}

async function loadBehaviours() {
  const behaviours = {};
  const modules = readdirSync(SERVICES_DIR)
    .filter((file) => /^behaviours_.*\.mjs$/.test(file))
    .sort();
  for (const file of modules) {
    const module = await import(new URL(file, SERVICES_DIR).href);
    Object.assign(behaviours, module.BEHAVIOURS);
  }
  return behaviours;
}

const BEHAVIOUR = (await loadBehaviours())[SPEC.service?.behaviour];
if (BEHAVIOUR === undefined) {
  setupError(`no behaviour ${String(SPEC.service?.behaviour)}`);
}

// Target options as the language's values

function callCondition(condition) {
  return (call) => {
    if ('model' in condition) {
      const models = typeof condition.model === 'string' ? [condition.model] : condition.model;
      if (!models.includes(call.model)) {
        return false;
      }
    }
    if ('systemIncludes' in condition) {
      const systems = (call.messages ?? [])
        .filter((message) => message.role === 'system')
        .map((message) => (typeof message.content === 'string' ? message.content : ''));
      if (!systems.some((text) => text.includes(condition.systemIncludes))) {
        return false;
      }
    }
    if ('toolName' in condition && !(call.toolNames ?? []).includes(condition.toolName)) {
      return false;
    }
    return !('not' in condition && callCondition(condition.not)(call));
  };
}

function exceptionCondition(condition) {
  return (error) => {
    if ('class' in condition && error?.constructor?.name !== condition.class) {
      return false;
    }
    const text = error instanceof Error ? error.message : String(error);
    return text.includes(condition.messageIncludes ?? '');
  };
}

/** The options of `targets.chat` for the fixture's `target`, without `generate`. */
function targetOptions(options) {
  const target = {};
  for (const key of ['languages', 'inputSchema', 'postprocess']) {
    if (key in options) {
      target[key] = options[key];
    }
  }
  const render = options.render;
  if (typeof render === 'boolean') {
    target.render = render;
  } else if (render !== undefined) {
    // TypeScript has no decorator form: both forms are the `render` option.
    target.render = () => structuredClone(render.result);
  }
  if ('discardOn' in options) {
    const discard = options.discardOn;
    target.discardOn = Array.isArray(discard)
      ? discard.map(exceptionClass)
      : exceptionCondition(discard.when);
  }
  if ('replyCall' in options) {
    const replyCall = options.replyCall;
    target.replyCall = typeof replyCall === 'boolean' ? () => replyCall : callCondition(replyCall);
  }
  if ('answerTool' in options) {
    target.answerTool = [...options.answerTool];
  }
  return target;
}

function adapterOptions(options) {
  const adapter = { name: 'scenario-service', version: '0.0.1' };
  if ('maxConcurrency' in options) {
    adapter.maxConcurrency = options.maxConcurrency;
  }
  if ('serviceDir' in options) {
    adapter.serviceDir = options.serviceDir;
  }
  return adapter;
}

const defineAdapter = helperExport('defineAdapter');
defineAdapter({
  ...adapterOptions(SPEC.adapter ?? {}),
  targets: {
    chat: {
      ...targetOptions(SPEC.target ?? {}),
      async generate(c, variant, calls) {
        return BEHAVIOUR(new Run(c, variant, calls));
      },
    },
  },
}).listen();
