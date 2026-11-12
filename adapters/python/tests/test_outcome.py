"""The trial outcome: data-model §Outcome Decision rows 1 to 9 with the row 3 and row 5
exceptions, `discard_on` as classes and as a function, `discardReason`, `capturedRaw` and the
"The target function raised <exception>." forms of A1, A2, A3 and the Outcome row 9 message
(helper-api §Messages), on the rows S-RESP-07, S-RESP-08, S-EXC-01, S-EXC-02 and §Side Calls
of helper-scenarios, including User Story 1 acceptance scenarios 2, 3 and the run part of 8."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "outcome.json"


def test_003_FR_011_FR_012_FR_013_FR_014_the_outcome_follows_the_decision_table(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
