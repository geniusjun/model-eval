import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Reading bodies and numbers on the TypeScript helper: a response body that starts with U+FEFF,
// JSON and SSE alike, is read as the SDKs read it (helper-api §Reading Response Bodies, Both
// Languages), and the request's `n` sets how many choices end a stream. Fixture rows:
// test/fixtures/helper/scenarios/reading.json. The cases of numbers written with a zero fraction
// (`n` 2.0, a role 1.0, `max_tokens` 300.0) are Python's only, since a Node service sends the
// number the JavaScript value holds; the render cases of the same rules run in render.test.ts.

const server = useMockApi();

describe('003 reading bodies and numbers on the TypeScript helper (helper-api §Reading Response Bodies)', () => {
  itRunsTheCases('reading.json', '003 FR-024', server);
});
