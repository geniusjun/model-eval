"""A thrown `ModelCallError` (helper-api §`ModelCallError`, §The `call` Check): every row of
helper-scenarios §`ModelCallError`, per data-model §Matching Reported Failures, with A12 also
when `ValueError` is in `discard_on` and after Outcome row 1, `discard_on` never consulted for a
`ModelCallError` (S-MCE-26), A13, W10, `retryAfterMs` from the matched call or the thrown
value (S-MCE-27), and a `retry_after_ms` of -1 or NaN that is not recorded (S-PAR-11). Includes
User Story 4 acceptance scenario 7: a failure of an uncaptured call counts by its kind."""

from __future__ import annotations

import sys

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

SCENARIOS = "model_call_error.json"


def test_003_FR_017_FR_018_FR_020_a_thrown_failure_counts_by_its_kind(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


GROUP_EXCEPTION = "ExceptionGroup: check failed (1 sub-exception)"


def grouped_failure(mock: MockApi, target: str) -> JsonObject:
    """The response of one trial of services/py311_grouped_failure.py's `target`."""
    case = case_of({"service": {"behaviour": "reply"}, "script": [{"reply": {"text": "Hello."}}]})
    with started(case, mock, service="py311_grouped_failure") as adapter:
        initialize(adapter, case)
        return adapter.wait(generate(adapter, case, target=target))


@pytest.mark.skipif(sys.version_info < (3, 11), reason="ExceptionGroup needs Python 3.11")
def test_003_FR_011_a_model_call_error_in_an_exception_group_is_a_service_exception(
    mock_api: MockApi,
) -> None:
    # helper-api §`ModelCallError`: only a ModelCallError the target function throws itself is a
    # reported failure; inside a group it is part of the service's own exception, so a
    # discard_on that matches the group discards the trial.
    result = grouped_failure(mock_api, "discarded")["result"]
    assert (result["finalKind"], result["raw"]) == ("discarded", "Hello.")
    assert result["discardReason"] == GROUP_EXCEPTION
    assert "error" not in result


@pytest.mark.skipif(sys.version_info < (3, 11), reason="ExceptionGroup needs Python 3.11")
def test_003_FR_011_an_exception_group_outside_discard_on_is_outcome_row_9(
    mock_api: MockApi,
) -> None:
    response = grouped_failure(mock_api, "raised")
    message = fill_message(load_messages()["row9"]["text"], {"exception": GROUP_EXCEPTION})
    assert response["error"]["message"] == message
    assert response["error"]["data"]["capturedRaw"] == "Hello."
