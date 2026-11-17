import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Raw-giving trials outside streams (helper-api §`Result`, §What the Target Function Reports):
// every row of helper-scenarios §Other Raw-Giving Scenarios on the TypeScript helper, S-UNC-06 and
// the `result()` parts of the §Answer Calls rows, per data-model §Raw Call and §Answer Candidate
// Calls When Raw Is Given: the uncaptured call, the finish-reason check (A9 of S-RAW-12), W4, W8,
// the A2 form for a `model` that names another model, A7, and the `final` of a `result()`
// without it, A14 for `final: null` (S-RAW-13).

const server = useMockApi();

describe('003 other raw-giving trials on the TypeScript helper (helper-scenarios §Other Raw-Giving Scenarios)', () => {
  itRunsTheCases('other_raw.json', '003 FR-018 FR-020 SC-005', server);
});
