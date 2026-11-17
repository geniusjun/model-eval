import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Regeneration in streaming services that give raw, on the TypeScript helper: the rows of
// helper-scenarios §Regeneration in Streaming Services That Give Raw, the Node part of S-REGEN-03
// included, decided per data-model §Answer Candidate Calls When Raw Is Given and §Cut Last Answer,
// with W5 and W6 and the raw-given A3 forms.

const server = useMockApi();

describe('003 regeneration in streaming services that give raw on the TypeScript helper (helper-scenarios §Regeneration)', () => {
  itRunsTheCases('regeneration_raw.json', '003 FR-018 FR-019 FR-020', server);
});
