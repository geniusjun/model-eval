"""Raw-giving trials outside streams (helper-api §`Result`, §What the Target Function Reports):
every row of helper-scenarios §Other Raw-Giving Scenarios, S-UNC-06, and the `Result` parts of
S-ANS-17, S-ANS-18, S-ANS-19, S-ANS-20, S-ANS-26 and S-ANS-38 to S-ANS-41, per data-model §Raw
Call and §Answer Candidate Calls When Raw Is Given: the uncaptured call and the uncaptured-call
exception, the finish-reason check (A9), warnings W4 and W8, the A2 form for a `Result(model=)`
that names another model, A7, with `<models>` `none` when no call was captured, and the
`final` an omitted `Result(final=)` ships, A14 for `final=None` (S-RAW-13). Includes
User Story 4 acceptance scenarios 6 and 11 and User Story 1 acceptance scenario 9 (S-RAW-03)."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "other_raw.json"


def test_003_FR_018_FR_020_SC_005_the_raw_call_decides_raw_giving_trials(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
