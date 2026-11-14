"""Reading bodies and numbers the same way in both helpers: a response body that starts with
U+FEFF, JSON and SSE alike, is read as the SDKs read it (helper-api §Reading Response Bodies,
Both Languages), and a JSON number with no fractional part such as the request's `n` 2.0 is an
integer (helper-api §Shared Conventions), and a Responses tool-call item whose `call_id` is null
is paired with a result item through its `id` (data-model §Finish Reasons). Fixture rows:
test/fixtures/helper/scenarios/reading.json;
the render cases of the same rules (a role that is not a string, `max_tokens` 300.0) are in
render.json."""

from __future__ import annotations

from protocol_client import MockApi, ScenarioCase, assert_expect, run_case

SCENARIOS = "reading.json"


def test_003_FR_024_bodies_and_numbers_are_read_alike(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))
