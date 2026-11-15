// The adapter skeletons `init --adapter` writes (FR-033): a target `chat` that matches the
// example cases, written with the helper of feature 003 for that language. The target function
// is left for the user to connect to the service.

/** The languages `init --adapter` accepts. */
export const ADAPTER_LANGUAGES = ['python', 'node'] as const;
export type AdapterLanguage = (typeof ADAPTER_LANGUAGES)[number];

/** The Python helper file, copied next to the Python skeleton. */
export const PYTHON_HELPER_FILE = 'model_eval_adapter.py';

export interface AdapterSkeleton {
  /** The skeleton's file name, next to the config file. */
  readonly file: string;
  /** `adapter.command` of the config `init` writes with this skeleton. */
  readonly command: string;
  readonly content: string;
}

const PYTHON_SKELETON = `"""The model-eval adapter: runs your service's turn function for one case and one model.

Guide: docs/guide/adapter.md of model-eval. The helper next to this file speaks the adapter
protocol and captures the model requests your service sends through the OpenAI and Anthropic
SDKs.
"""

# The helper comes first, before the service and its SDK clients, so their requests are captured.
from model_eval_adapter import Adapter

# from my_service import reply

adapter = Adapter(name="my-service", version="0.1.0")  # service_dir="path/to/the/service"


@adapter.target(
    "chat",
    languages=["en", "ko"],
    input_schema={
        "type": "object",
        "required": ["user"],
        "properties": {"user": {"type": "string", "minLength": 1}},
    },
    render=True,
)
async def chat(case, variant):
    # Call the service's turn function with case.input and variant.model, and return the text it
    # ships. Wrap a fixed message or another model's answer with fallback(text).
    raise NotImplementedError("Call your service here.")


if __name__ == "__main__":
    adapter.run()
`;

const NODE_SKELETON = `// The model-eval adapter: runs your service's turn function for one case and one model.
// Guide: docs/guide/adapter.md of model-eval. Install model-eval as a development dependency,
// which brings the helper that speaks the adapter protocol and captures the model requests your
// service sends through the OpenAI and Anthropic SDKs.

// The helper comes first, before the service and its SDK clients, so their requests are captured.
import { defineAdapter } from 'model-eval/adapter';
// import { reply } from './service.js';

defineAdapter({
  name: 'my-service',
  version: '0.1.0',
  // serviceDir: 'path/to/the/service',
  targets: {
    chat: {
      languages: ['en', 'ko'],
      inputSchema: {
        type: 'object',
        required: ['user'],
        properties: { user: { type: 'string', minLength: 1 } },
      },
      render: true,
      async generate(c, variant) {
        // Call the service's turn function with c.input and variant.model, and return the text it
        // ships. Wrap a fixed message or another model's answer with fallback(text).
        throw new Error('Call your service here.');
      },
    },
  },
}).listen();
`;

export const ADAPTER_SKELETONS: Readonly<Record<AdapterLanguage, AdapterSkeleton>> = {
  python: { file: 'adapter.py', command: '[python3, adapter.py]', content: PYTHON_SKELETON },
  node: { file: 'adapter.mjs', command: '[node, adapter.mjs]', content: NODE_SKELETON },
};

export function isAdapterLanguage(value: string): value is AdapterLanguage {
  return ADAPTER_LANGUAGES.some((language) => language === value);
}
