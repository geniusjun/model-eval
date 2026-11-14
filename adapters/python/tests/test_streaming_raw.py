"""Streaming services that give raw: helper-scenarios §Streaming Services That Give Raw rows
S-STR-01 to S-STR-16 (S-STR-09 with the Python service's logic) and S-STR-20 to S-STR-34, decided
per data-model §Cut Streams views 1, 2, 3 and 5, §Failure Check, §No Searched Calls and §Cut Last
Answer. The cases carry warnings W5, W6 (as the failure check and as §Cut Last Answer decide it,
with `stopped_early` ignored and honoured) and W7, and User Story 4 acceptance scenarios 1 to 5."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "streaming_raw.json"


def test_003_FR_018_FR_019_FR_020_streaming_services_that_give_raw(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
