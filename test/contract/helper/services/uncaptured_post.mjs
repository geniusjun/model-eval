// A model request sent with `node:http`, outside the global `fetch` the helper captures: in the
// adapter process (the `flow` step `uncaptured`) or from a child process, like an SDK that calls
// the model from a process of its own (`child`):
//
//     node uncaptured_post.mjs <api> <request body as JSON>
//
// prints the answer text. The module imports neither the helper nor an SDK.

import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PATHS = { 'chat-completions': '/chat/completions', responses: '/responses' };
const TIMEOUT_MS = 30_000;

/** Sends the request to the base URL of the API's SDK and gives the answer text. */
export async function post(api, body, signal) {
  let url;
  let headers;
  if (api === 'messages') {
    url = `${trimmed(process.env.ANTHROPIC_BASE_URL)}/v1/messages`;
    headers = {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    };
  } else {
    url = `${trimmed(process.env.OPENAI_BASE_URL)}${PATHS[api]}`;
    headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` };
  }
  const text = await request(
    url,
    JSON.stringify(body),
    {
      ...headers,
      'content-type': 'application/json',
    },
    signal,
  );
  return answerText(api, JSON.parse(text));
}

function trimmed(value) {
  return (value ?? '').replace(/\/+$/, '');
}

function request(url, body, headers, signal) {
  const transport = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const outgoing = transport.request(
      url,
      { method: 'POST', headers, timeout: TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error(`HTTP Error ${String(status)}: ${text}`));
          } else {
            resolve(text);
          }
        });
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error('timed out')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

export function answerText(api, body) {
  if (api === 'chat-completions') {
    return String(body.choices[0].message.content ?? '');
  }
  if (api === 'responses') {
    return (body.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? '')
      .join('');
  }
  return body.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [api, body] = process.argv.slice(2);
  process.stdout.write(`${await post(api, JSON.parse(body))}\n`);
}
