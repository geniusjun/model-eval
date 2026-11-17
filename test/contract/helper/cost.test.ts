import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Cost of trials the target function reports: helper-scenarios §Cost rows S-COST-01 to S-COST-08,
// per data-model §Derived Result Fields `usage` and `calls` and §Raw Call: `result({ usage })` on
// the raw call or the uncaptured call, no `calls` without a captured call, stream calls at their
// reservation, and warning W4.

const server = useMockApi();

describe('003 cost of reported trials on the TypeScript helper (helper-scenarios §Cost)', () => {
  itRunsTheCases('cost.json', '003 FR-007 FR-015 FR-018', server);
});
