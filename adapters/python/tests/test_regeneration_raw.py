"""Regeneration in streaming services that give raw: helper-scenarios §Regeneration in Streaming
Services That Give Raw rows S-REGEN-01, S-REGEN-02, S-REGEN-04 to S-REGEN-20 and the Python part
of S-REGEN-03, decided per data-model §Answer Candidate Calls When Raw Is Given and §Cut Last
Answer. The cases carry W5 and W6 with the regeneration sentence when §Cut Last Answer decides,
and the three A3 forms of a trial that gives raw."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "regeneration_raw.json"


def test_003_FR_018_FR_019_FR_020_regeneration_in_streaming_services_that_give_raw(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
