"""Error kinds from HTTP status codes and error objects: every row of helper-scenarios §Status
Codes, per helper-api §Error Classification and data-model §Call Outcome, including User Story 1
acceptance scenarios 6 (a rate limit left after the SDK's retries is `transient`) and 7 (an
authentication failure is `config`)."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case
from service_runs import case_of, generate, initialize, started

SCENARIOS = "status_codes.json"


def test_003_FR_007_FR_017_status_codes_decide_the_error_kind(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def test_003_FR_017_S_STAT_15_a_body_that_is_not_a_json_object_names_itself(
    mock_api: MockApi,
) -> None:
    steps = [{"call": {"onError": "swallow"}}]
    case = case_of(
        {
            "service": {"behaviour": "flow", "params": {"steps": steps, "result": {"text": "x"}}},
            "script": [
                {
                    "sse": {"chunks": [{"text": "[]"}]},
                    "headers": {"content-type": "application/json"},
                }
            ],
        }
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        result = adapter.wait(generate(adapter, case))["result"]
    assert result["error"] == {
        "kind": "config",
        "message": "The response body is not a JSON object.",
    }
