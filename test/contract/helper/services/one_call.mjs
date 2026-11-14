// One model request through the SDK alias of `MODEL_EVAL_SDK`, for the services of the capture,
// stdout, version and parity tests. Import it after the helper, so the client is created after the
// helper wrapped the global `fetch`.

import process from 'node:process';

/** The SDK module of `MODEL_EVAL_SDK`, or of the alias given. */
export async function sdkModule(alias = process.env.MODEL_EVAL_SDK) {
  if (alias === undefined) {
    throw new Error('MODEL_EVAL_SDK is not set');
  }
  return import(alias);
}

/** A client of the SDK, without retries, so each scripted response is one call. */
export async function makeClient(alias = process.env.MODEL_EVAL_SDK, options = {}) {
  const sdk = await sdkModule(alias);
  return new sdk.default({ maxRetries: 0, ...options });
}

/** The request body of one call: `user` as the only message, `system` when given. */
export function requestBody(api, { model, user = 'Say hello.', system, maxTokens = 256 }) {
  if (api === 'responses') {
    return {
      model,
      input: user,
      max_output_tokens: maxTokens,
      ...(system === undefined ? {} : { instructions: system }),
    };
  }
  if (api === 'messages') {
    return {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: user }],
      ...(system === undefined ? {} : { system }),
    };
  }
  const messages = [{ role: 'user', content: user }];
  return {
    model,
    max_tokens: maxTokens,
    messages: system === undefined ? messages : [{ role: 'system', content: system }, ...messages],
  };
}

/** The create method of the API on a client. */
export function create(client, api, body, options) {
  if (api === 'responses') {
    return client.responses.create(body, options);
  }
  if (api === 'messages') {
    return client.messages.create(body, options);
  }
  return client.chat.completions.create(body, options);
}

/** The answer text of a non-stream response. */
export function responseText(api, response) {
  if (api === 'responses') {
    return response.output_text;
  }
  if (api === 'messages') {
    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  return response.choices[0]?.message?.content ?? '';
}

/** The text one stream event carries. */
export function eventText(api, event) {
  if (api === 'responses') {
    return event.type === 'response.output_text.delta' ? event.delta : '';
  }
  if (api === 'messages') {
    return event.type === 'content_block_delta' && event.delta.type === 'text_delta'
      ? event.delta.text
      : '';
  }
  return event.choices?.[0]?.delta?.content ?? '';
}

/** Sends one request and returns the answer text; with `stream`, reads the whole stream. */
export async function ask(client, api, request) {
  const body = requestBody(api, request);
  if (request.stream !== true) {
    return responseText(api, await create(client, api, body));
  }
  let text = '';
  for await (const event of await create(client, api, { ...body, stream: true })) {
    text += eventText(api, event);
  }
  return text;
}
