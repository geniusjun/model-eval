"""The `fingerprint` of `generate` results (data-model §Derived Result Fields; FR-022): the first
request of the branch that produced the first answer, or the first answer candidate request when
there is no answer, in the render shape and hashed as the render fingerprint, so it compares
directly with the render fingerprint and differs from it when render-mismatch cause 1 of
helper-api §When the Render Target Differs From the Answer Request applies."""

from __future__ import annotations

import pytest
from protocol_client import JsonObject, MockApi, ScenarioCase, assert_expect, run_case
from service_runs import case_of, installed_apis, ok_result

SCENARIOS = "fingerprint.json"
RESENT = {"name": "again", "user": "Say hello, briefly."}


def test_003_FR_022_fingerprint(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def flow_case(steps: list[JsonObject], api: str, **data: object) -> ScenarioCase:
    service = {"behaviour": "flow", "params": {"steps": steps, "result": {"callText": "again"}}}
    return case_of({"service": service, **data}, api)


# The first request of render-mismatch cause 1, and what the mock server answers it with.
FIRST_REQUESTS = {
    "failed": ({"name": "first", "onError": "swallow"}, {"error": {"status": 500}}),
    "tool call only": (
        {"name": "first", "tools": ["lookup"]},
        {"reply": {"toolCalls": [{"name": "lookup", "arguments": '{"text":"weather"}'}]}},
    ),
}


@pytest.mark.parametrize("first", sorted(FIRST_REQUESTS))
@pytest.mark.parametrize("api", installed_apis())
def test_003_FR_022_fingerprint_of_a_modified_resend_is_its_own_render_fingerprint(
    api: str, first: str, mock_api: MockApi
) -> None:
    """The fingerprint after a first request that failed or ended only in a tool call is the
    render fingerprint of a service whose only request is the modified one, so the rule picks
    that request, not just any other."""
    first_call, first_answer = FIRST_REQUESTS[first]
    trial = flow_case(
        [{"call": first_call}, {"call": RESENT}],
        api,
        target={"render": True, "replyCall": True},
        script=[first_answer, {"reply": {"text": "Hello."}}],
    )
    alone = flow_case([{"call": RESENT}], api, target={"render": True}, request="render")
    generated = ok_result(run_case(trial, mock_api).response)
    rendered = ok_result(run_case(alone, mock_api).response)
    assert isinstance(rendered.get("fingerprint"), str)
    assert generated.get("fingerprint") == rendered["fingerprint"]
