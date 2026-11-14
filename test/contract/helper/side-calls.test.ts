import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Side calls reported by the target function, on the TypeScript helper: the rows of
// helper-scenarios §Side Calls the Python service reports through `Result` and `ModelCallError`,
// per helper-api §Trials Stopped by Another Call's Failure and §Trials Stopped by a Parallel
// Check's Refusal: the `answers: 0` check (A8), cut stream view 5 and matching thrown failures.
// The Node services stop waiting with `Promise.race` where the Python ones use `asyncio.wait`.

const server = useMockApi();

describe('003 side calls on the TypeScript helper (helper-scenarios §Side Calls)', () => {
  itRunsTheCases('side_calls.json', '003 FR-014 FR-015 FR-016 FR-018 FR-019', server);
});
