"""Transport failures and time limits: helper-scenarios §Connections and Time rows S-CONN-01 to
S-CONN-19, S-CONN-21 and S-CONN-23 (Python parts), per helper-api §Reading Response Bodies,
§End Events, §Error Classification and §Transport Exceptions, on the httpx and httpx2 default
transports and the aiohttp backend."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "connections.json"


def test_003_FR_007_FR_017_transport_failures_decide_the_error_kind_and_call_outcome(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
