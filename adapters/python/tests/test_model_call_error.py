"""A thrown `ModelCallError` (helper-api §`ModelCallError`, §The `call` Check): every row of
helper-scenarios §`ModelCallError`, per data-model §Matching Reported Failures, with A12 also
when `ValueError` is in `discard_on` and after Outcome row 1, `discard_on` never consulted for a
`ModelCallError` (S-MCE-26), A13, W10, `retryAfterMs` from the matched call or the thrown
value (S-MCE-27), and a `retry_after_ms` of -1 or NaN that is not recorded (S-PAR-11). Includes
User Story 4 acceptance scenario 7: a failure of an uncaptured call counts by its kind."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "model_call_error.json"


def test_003_FR_017_FR_018_FR_020_a_thrown_failure_counts_by_its_kind(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
