"""Error kinds from HTTP status codes and error objects: every row of helper-scenarios §Status
Codes, per helper-api §Error Classification and data-model §Call Outcome, including User Story 1
acceptance scenarios 6 (a rate limit left after the SDK's retries is `transient`) and 7 (an
authentication failure is `config`)."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "status_codes.json"


def test_003_FR_007_FR_017_status_codes_decide_the_error_kind(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
