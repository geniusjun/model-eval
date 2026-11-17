import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Streaming services that give raw, on the TypeScript helper: the rows of helper-scenarios
// §Streaming Services That Give Raw, the Node-only rows S-STR-17 to S-STR-19 and the Node parts
// of S-STR-09 and S-STR-35 included, decided per data-model §Cut Streams views 1, 2, 3 and 5,
// §Failure Check and §Cut Last Answer. A Node stream helper (`client.chat.completions.stream()`,
// `client.messages.stream()`) cancels the read it is awaiting when the service leaves its
// `for await` or aborts after an `await`; an `abort()` in an event handler before any `await`
// cuts no awaited read (K8).

const server = useMockApi();

describe('003 streaming services that give raw on the TypeScript helper (helper-scenarios §Streaming Services That Give Raw)', () => {
  itRunsTheCases('streaming_raw.json', '003 FR-018 FR-019 FR-020', server);
});
