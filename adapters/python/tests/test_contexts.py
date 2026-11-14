"""Trial contexts: helper-scenarios §Contexts rows S-CTX-01 to S-CTX-24 and S-RESP-10, per
data-model §Outside the Trial Context and §After the Function Returned: requests without a
context, unfinished calls waited for until `timeoutMs` minus the time spent minus 5 s, requests
after the result as `calls` notifications, and log warning L2. Rows S-CTX-12 to S-CTX-17 and the
throwing parts of S-CTX-19 and S-CTX-20 report through `Result` and `ModelCallError` per
helper-api §Services That Stopped Waiting."""

from __future__ import annotations

import time

import pytest
from conftest import scenario_cases
from protocol_client import (
    AdapterProcess,
    MockApi,
    Outcome,
    ScenarioCase,
    api_env,
    assert_expect,
    initialize_params,
    run_case,
    scenario_env,
    trial_params,
    wait_for_requests,
)

SCENARIOS = "contexts.json"

# data-model §Unfinished Calls: the wait keeps 5 s of the tool's time limit.
WAIT_KEPT_S = 5.0


def test_003_FR_006_FR_008_FR_015_trial_contexts_keep_calls_apart(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def first_case(scenario: str) -> ScenarioCase:
    cases = [case for case in scenario_cases(SCENARIOS) if case.scenario == scenario]
    if not cases:
        pytest.fail(f"{scenario} has no case for this environment")
    return cases[0]


def started(case: ScenarioCase, mock: MockApi) -> AdapterProcess:
    mock.load(case.data.get("script", []))
    adapter = AdapterProcess("scenario", {**api_env(mock.url), **scenario_env(case)})
    initialized = adapter.request("initialize", initialize_params(case))
    assert "result" in initialized, f"initialize failed: {initialized}"
    return adapter


def test_003_FR_008_the_wait_for_unfinished_calls_ends_5_s_before_the_tool_time_limit(
    mock_api: MockApi,
) -> None:
    case = first_case("S-CTX-07")
    adapter = started(case, mock_api)
    try:
        sent = time.monotonic()
        response = adapter.wait(adapter.send("generate", trial_params(case)))
        elapsed = time.monotonic() - sent
        adapter.request("shutdown")
    finally:
        adapter.close()
    assert_expect(case.expect, Outcome(response, adapter.exchange, mock_api.log()))
    limit_s = initialize_params(case)["timeoutMs"] / 1000
    assert limit_s - WAIT_KEPT_S - 0.3 <= elapsed <= limit_s - WAIT_KEPT_S + 1.0, elapsed


def test_003_FR_008_background_requests_are_reported_before_the_shutdown_response(
    mock_api: MockApi,
) -> None:
    case = first_case("S-CTX-23")
    adapter = started(case, mock_api)
    try:
        response = adapter.request("generate", trial_params(case))
        assert adapter.exchange.calls == [], "a call was reported before it ended"
        wait_for_requests(int(case.data["shutdownAfterRequests"]), mock_api)
        adapter.request("shutdown")
        reported = len(adapter.exchange.calls)
    finally:
        adapter.close()
    assert_expect(case.expect, Outcome(response, adapter.exchange, mock_api.log()))
    assert reported == 1, "the background call was not reported before the shutdown response"
