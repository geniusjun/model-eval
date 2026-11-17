import { describe } from 'vitest';

import { itRunsTheCases, useMockApi } from './support/service-runs.js';

// Transport failures and time limits on the TypeScript helper: helper-scenarios §Connections and
// Time, per helper-api §Reading Response Bodies, §End Events, §Error Classification and §Transport
// Exceptions (Node: the error's `cause` chain, its `code` and `syscall`), the Node parts of
// S-CONN-01 (every code of the X509 certificate error code table of the Node `tls` documentation,
// classified `config`), S-CONN-10, S-CONN-20, S-CONN-21 and S-CONN-23 to S-CONN-25 included.
//
// Failures a local server cannot produce on demand (undici's time-outs, each certificate code)
// come from the `fetch-failure` behaviour, run by services/fetch_failure_service.mjs: a global
// `fetch` that fails with that error, set up before the helper wraps it.

const server = useMockApi();

describe('003 transport failures on the TypeScript helper (helper-api §Transport Exceptions)', () => {
  itRunsTheCases('connections.json', '003 FR-007 FR-017', server, {
    serviceOf: { 'fetch-failure': 'fetch_failure_service' },
  });
});
