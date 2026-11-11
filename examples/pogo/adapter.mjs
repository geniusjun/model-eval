// The adapter of Pogo, a synthetic chat character. It speaks adapter protocol v1 over stdio
// (one JSON-RPC message per line) and needs only Node. It never calls a model: a stand-in
// model writes each answer from the case input and the trial seed, so every run gives the same
// result. The stand-in for model-b mixes a Korean word into some Japanese answers on purpose,
// so `swap --from current --to next` blocks on the Japanese script rule.

import { createHash } from 'node:crypto';
import process from 'node:process';
import { createInterface } from 'node:readline';

const LANGUAGES = ['ko', 'en', 'ja'];

/**
 * The system prompt per language, as the service assembles it. The English prompt says
 * "Do not use emoji" where the rule no-emoji quotes "Never use emoji", so `lint --render`
 * reports one anchor-missing warning.
 */
const PROMPTS = {
  ko: [
    '너는 포고야. 사용자의 오랜 친구처럼 반말로 짧게 답한다.',
    '이모지를 붙이지 않는다.',
    '묻기 전에는 네 옷이나 방, 하는 일을 말하지 않는다.',
    '말투 예시: 나라면 조용한 부분부터 다시 들을래',
  ],
  en: [
    'You are Pogo, a friendly chat companion. Answer in one or two short sentences.',
    'Do not use emoji.',
    'Do not describe your own clothes, room or activity unless the user asks.',
  ],
  ja: [
    'あなたはポゴ。ユーザーの友だちとして短く答える。',
    '日本語だけで話す。',
    '絵文字を使わない。',
    '聞かれるまで自分の服や部屋、していることを話さない。',
  ],
};

/** Context lines the service adds from the app state, per language. */
const CONTEXT = {
  ko: {
    wearing: (items) => `오늘 포고가 입은 것: ${items.join(', ')}`,
    mood: (label) => `사용자가 앱에서 고른 기분: ${label}. 기분 이름을 말하지 않는다.`,
  },
  en: {
    wearing: (items) => `What Pogo wears today: ${items.join(', ')}`,
    mood: (label) => `Mood the user picked in the app: ${label}. Do not name the mood.`,
  },
  ja: {
    wearing: (items) => `今日のポゴの服: ${items.join('、')}`,
    mood: (label) => `ユーザーがアプリで選んだ気分: ${label}。気分の名前は言わない。`,
  },
};

/** How the stand-in model addresses the user and the sentences it combines, per language. */
const ANSWERS = {
  ko: {
    nameSeparator: ', ',
    openings: ['응, 그랬구나.', '아, 그래?', '그랬어?'],
    followUps: ['무슨 일 있었어?', '더 얘기해 줘.', '지금은 좀 어때?'],
  },
  en: {
    nameSeparator: ', ',
    openings: ['Oh, I see.', 'Really?', 'Got it.'],
    followUps: ['What happened?', 'Tell me more.', 'How do you feel now?'],
  },
  ja: {
    nameSeparator: '、',
    openings: ['そうなんだ。', 'へえ、本当？', 'なるほど。'],
    followUps: ['何があったの？', 'もっと聞かせて。', '今はどんな気分？'],
  },
};

/** The Korean word model-b mixes into Japanese answers. */
const STRAY_KOREAN = ' 화이팅';
/** Share of Japanese answers model-b breaks, drawn from the trial seed. */
const STRAY_SHARE = 0.4;

const MAX_OUTPUT_TOKENS = 256;

/** A rough token count: Hangul, kana and Han count 1 each, every other character 0.3. */
function countTokens(text) {
  let tokens = 0;
  for (const char of text) {
    tokens += /[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(char)
      ? 1
      : 0.3;
  }
  return Math.ceil(tokens);
}

/** The messages the service sends to the model, system message first. */
function buildMessages(lang, input) {
  const context = CONTEXT[lang];
  const system = [
    ...PROMPTS[lang],
    ...(input.state?.wearing === undefined ? [] : [context.wearing(input.state.wearing)]),
    ...(input.mood === undefined ? [] : [context.mood(input.mood.label)]),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: input.user },
  ];
}

/** A number in [0, 1) from the trial seed and a key, so both variants draw the same values. */
function draw(seed, key) {
  return createHash('sha256').update(`${seed}:${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

function pick(items, seed, key) {
  return items[Math.floor(draw(seed, key) * items.length)];
}

/** The stand-in model: a short answer in the case language. */
function standInModel(model, lang, input, seed) {
  const { nameSeparator, openings, followUps } = ANSWERS[lang];
  const name = input.nickname === undefined ? '' : `${input.nickname}${nameSeparator}`;
  const answer = `${name}${pick(openings, seed, 'opening')} ${pick(followUps, seed, 'follow-up')}`;
  const breaks = model === 'model-b' && lang === 'ja' && draw(seed, 'stray') < STRAY_SHARE;
  return breaks ? `${answer}${STRAY_KOREAN}` : answer;
}

/** The service's post-processing: collapse runs of spaces. */
function postprocess(text) {
  return text.replace(/ {2,}/gu, ' ').trim();
}

let variant;

const handlers = {
  initialize(params) {
    variant = params.variant;
    return {
      protocolVersion: '1',
      adapter: { name: 'pogo-chat', version: '0.1.0' },
      targets: [
        {
          name: 'chat',
          languages: LANGUAGES,
          inputSchema: {
            type: 'object',
            required: ['user'],
            additionalProperties: false,
            properties: {
              user: { type: 'string', minLength: 1 },
              nickname: { type: 'string', minLength: 1 },
              state: {
                type: 'object',
                properties: { wearing: { type: 'array', items: { type: 'string' } } },
              },
              mood: {
                type: 'object',
                required: ['label'],
                properties: { label: { type: 'string' } },
              },
            },
          },
        },
      ],
      capabilities: { render: true, stages: true, postprocess: true, maxConcurrency: 4 },
    };
  },

  render({ lang, input }) {
    const messages = buildMessages(lang, input);
    return {
      messages,
      inputTokens: countTokens(messages.map((message) => message.content).join('\n')),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
  },

  generate({ lang, input, seed }) {
    if (variant === undefined) {
      throw new Error('generate before initialize');
    }
    const messages = buildMessages(lang, input);
    const raw = standInModel(variant.model, lang, input, seed);
    const final = postprocess(raw);
    const usage = {
      input: countTokens(messages.map((message) => message.content).join('\n')),
      output: countTokens(raw),
    };
    const latencyMs = 300 + Math.floor(draw(seed, 'latency') * 500);
    return {
      raw,
      finalKind: 'model',
      final,
      stages: [{ name: 'collapse-spaces', text: final }],
      usage,
      latencyMs,
      finishReason: 'stop',
      modelSnapshot: `${variant.model}-v1`,
      calls: [
        {
          model: variant.model,
          responseModel: `${variant.model}-v1`,
          outcome: 'ok',
          branch: 'answer',
          usage,
          finishReason: 'stop',
          latencyMs,
        },
      ],
    };
  },

  shutdown() {
    return null;
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** The request on one line, or the JSON-RPC error to answer when the line is not one. */
function readRequest(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return { error: { code: -32700, message: `parse error: ${String(error)}` } };
  }
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
    return {
      error: { code: -32600, message: 'invalid request: expected an object with a method' },
    };
  }
  return { request: message };
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const { request, error } = readRequest(line);
  if (request === undefined) {
    // The id of a line that cannot be read is unknown, so JSON-RPC answers with id null.
    send({ id: null, error });
    return;
  }
  if (request.id === undefined) {
    // Notifications such as cancel need no answer: this adapter answers every request at once.
    return;
  }
  if (!Object.hasOwn(handlers, request.method)) {
    send({ id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
    return;
  }
  try {
    send({ id: request.id, result: handlers[request.method](request.params ?? {}) });
  } catch (failure) {
    send({ id: request.id, error: { code: -32603, message: String(failure) } });
  }
  if (request.method === 'shutdown') {
    lines.close();
  }
});

process.stderr.write('pogo: ready\n');
