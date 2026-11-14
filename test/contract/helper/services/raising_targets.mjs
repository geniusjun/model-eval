// Targets whose own code throws where the helper calls it: `replyCall`, a `discardOn` function,
// or the target function throwing an `AbortError` itself. Each target makes one model request, so
// the trial has a captured call; `reply-call-unfinished` leaves it running when it returns.
// `MODEL_EVAL_SCENARIO` gives the API as for the scenario service.

import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { defineAdapter } from 'model-eval/adapter';

import { create, makeClient, requestBody } from './one_call.mjs';

const API = JSON.parse(process.env.MODEL_EVAL_SCENARIO ?? '{}').api;

/** The service's own exception, which `discardOn` is asked about. */
class ServiceError extends Error {}

async function oneRequest(model) {
  const client = await makeClient();
  return create(client, API, requestBody(API, { model, maxTokens: 64 }));
}

function brokenReplyCall() {
  throw new Error('reply_call is broken');
}

function brokenDiscardOn() {
  throw new Error('discard_on is broken');
}

/** Requests left running when a target function returns. */
const background = new Set();

defineAdapter({
  name: 'raising-targets',
  version: '0.0.1',
  targets: {
    'reply-call': {
      replyCall: brokenReplyCall,
      async generate(c, variant) {
        await oneRequest(variant.model);
        return 'Hello.';
      },
    },
    'reply-call-unfinished': {
      replyCall: brokenReplyCall,
      async generate(c, variant) {
        // The request is still running when the function returns; it is not awaited here.
        const request = oneRequest(variant.model);
        background.add(request);
        request.catch(() => undefined);
        await sleep(200);
        return 'Hello.';
      },
    },
    'reply-call-cancelled': {
      replyCall: brokenReplyCall,
      async generate(c, variant) {
        // The first request's failure (a 401 in the test) is swallowed; the tool cancels the
        // trial while the second request waits.
        try {
          await oneRequest(variant.model);
        } catch {
          // Swallowed, as the service does.
        }
        await oneRequest(variant.model);
        return 'Hello.';
      },
    },
    'discard-on': {
      discardOn: brokenDiscardOn,
      async generate(c, variant) {
        await oneRequest(variant.model);
        throw new ServiceError('rejected');
      },
    },
    aborted: {
      async generate(c, variant) {
        await oneRequest(variant.model);
        throw new globalThis.DOMException('This operation was aborted', 'AbortError');
      },
    },
  },
}).listen();
