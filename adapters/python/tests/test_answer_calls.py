"""Answer calls: data-model §Call Branches, §Answers and §Raw Cannot Be Determined on the rows of
helper-scenarios §Answer Calls the US1 task lists and S-RESP-03, S-RESP-04, S-RESP-06 and
S-RESP-12; the four causes of adapter error A3; warnings W1 (variant and other-model forms), W2
and W3; User Story 1 acceptance scenarios 10 and 11 (S-ANS-01)."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "answer_calls.json"


def test_003_FR_009_FR_010_FR_012_FR_014_FR_015_FR_016_FR_020_answer_calls_decide_raw(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
