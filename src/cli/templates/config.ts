// The config file `init` writes (contracts/config.md §Config File). Keys it leaves out take
// their defaults; the comments say what to change first.

/** `output.dir` of the template, which `init` also adds to `.gitignore`. */
export const OUTPUT_DIR = '.model-eval';

export const CONFIG_TEMPLATE = `version: 1
lang: en                                   # Human output and result page language: en or ko.

adapter:
  command: [node, adapter.mjs]             # The command that starts your adapter, as an array; no shell is involved.
  timeoutMs: 120000                        # Longer than one service call can take, SDK retry waits included.

files:
  rules: rules/**/*.yaml
  cases: cases/**/*.yaml

variants:                                  # params are stored in the run as is; never put secrets here.
  - id: current
    model: current-model                   # The model the service uses today.
  - id: next
    model: next-model                      # The model to move to.

pricing:                                   # USD per 1M tokens of every model the service calls. Copy them from
                                           # your provider's price list; the tool ships none.
  current-model: { input: 1.00, cachedInput: 0.10, output: 4.00 }
  next-model: { input: 1.00, cachedInput: 0.10, output: 4.00 }

sampling:
  repeats: 5

gate:
  severities: [blocking]                   # Rules of these severities can block the swap.

budget:
  maxCostUsd: 1                            # Cap on the spend the tool counts. null: no cap.

estimate:
  outputTokens: 600                        # Your service's usual answer length in tokens, reasoning included.

output:
  dir: ${OUTPUT_DIR}                       # Runs, comparisons and result pages; init adds it to .gitignore.
`;
