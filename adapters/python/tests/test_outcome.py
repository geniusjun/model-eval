"""The trial outcome: data-model §Outcome Decision rows 1 to 9 with the row 3 and row 5
exceptions, `discard_on` as classes and as a function, `discardReason`, `capturedRaw` and the
"The target function raised <exception>." forms of A1, A2, A3 and the Outcome row 9 message
(helper-api §Messages), on the rows S-RESP-07, S-RESP-08, S-EXC-01, S-EXC-02 and §Side Calls
of helper-scenarios, including User Story 1 acceptance scenarios 2, 3 and the run part of 8."""

from __future__ import annotations

import pytest
from protocol_client import (
    JsonObject,
    MockApi,
    ScenarioCase,
    assert_expect,
    fill_message,
    load_messages,
    run_case,
)
from service_runs import case_of, generate, initialize, started

SCENARIOS = "outcome.json"


def test_003_FR_011_FR_012_FR_013_FR_014_the_outcome_follows_the_decision_table(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def test_003_FR_011_a_non_text_return_value_is_a14(mock_api: MockApi) -> None:
    case = case_of(
        {
            "service": {"behaviour": "returns", "params": {"steps": [], "value": "none"}},
            "script": [],
        }
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        response = adapter.wait(generate(adapter, case))
    assert response["error"]["message"] == load_messages()["A14"]["text"]


def a16(option: str) -> str:
    """A16 for the raising option of tests/services/raising_targets.py."""
    exception = f"ValueError: {option} is broken"
    return fill_message(load_messages()["A16"]["text"], {"exception": exception})


def raising_target(mock: MockApi, target: str, reply: JsonObject) -> JsonObject:
    """The response of one trial of tests/services/raising_targets.py's `target`."""
    case = case_of({"service": {"behaviour": "reply"}, "script": [reply]})
    with started(case, mock, service="raising_targets") as adapter:
        initialize(adapter, case)
        return adapter.wait(generate(adapter, case, target=target))


@pytest.mark.parametrize("target", ["reply-call", "discard-on"])
def test_003_FR_011_S_RESP_17_an_option_that_raises_is_a16_with_the_calls(
    mock_api: MockApi, target: str
) -> None:
    response = raising_target(mock_api, target, {"reply": {"text": "Hi."}})
    assert response["error"]["message"] == a16(target.replace("-", "_"))
    calls = response["error"]["data"]["calls"]
    assert [(call["model"], call["outcome"]) for call in calls] == [("model-b", "ok")]


@pytest.mark.parametrize("target", ["reply-call", "discard-on"])
def test_003_FR_011_S_RESP_17_after_a_captured_401_outcome_row_1_decides(
    mock_api: MockApi, target: str
) -> None:
    response = raising_target(mock_api, target, {"error": {"status": 401}})
    result = response["result"]
    assert result["error"]["kind"] == "config"
    assert [(call["outcome"], call["errorKind"]) for call in result["calls"]] == [
        ("failed", "config")
    ]


def test_003_FR_011_S_RESP_17_a16_waits_for_an_unfinished_call(mock_api: MockApi) -> None:
    # reply_call raises; the call still running when the function returned is waited for and
    # recorded as it ended, without latencyMs (data-model §When a Call Ended).
    reply = {"delayMs": 1000, "reply": {"text": "Late."}}
    response = raising_target(mock_api, "reply-call-unfinished", reply)
    assert response["error"]["message"] == a16("reply_call")
    calls = response["error"]["data"]["calls"]
    assert [(call["outcome"], "latencyMs" in call) for call in calls] == [("ok", False)]
