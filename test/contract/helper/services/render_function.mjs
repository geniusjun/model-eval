// An adapter whose target `chat` has a render function that builds the render result from its
// `(case, variant)` arguments and returns tool definitions, and no post-processing; its target
// function calls no model, so a render result can come only from the render function. The user
// message is the JSON of the arguments' fields, keys sorted and no spaces. The target `plain` has
// neither render mode nor `postprocess: false` (S-RESP-15).

import { helperExport, sortedJson } from './support.mjs';

const TOOLS = [
  {
    type: 'function',
    function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
  },
];

function argumentsText(c, variant) {
  return sortedJson({
    case: { id: c.id, lang: c.lang, input: c.input, repeat: c.repeat, seed: c.seed },
    variant: { id: variant.id, model: variant.model, params: variant.params },
  });
}

function renderChat(c, variant) {
  return {
    messages: [
      { role: 'system', content: 'Answer the user.' },
      { role: 'user', content: argumentsText(c, variant) },
    ],
    tools: TOOLS,
    maxOutputTokens: 32,
  };
}

helperExport('defineAdapter')({
  name: 'render-function',
  version: '0.0.1',
  targets: {
    chat: {
      languages: ['en'],
      render: renderChat,
      postprocess: false,
      generate() {
        return 'Hello.';
      },
    },
    plain: {
      languages: ['en'],
      generate() {
        return 'Hello.';
      },
    },
  },
}).listen();
