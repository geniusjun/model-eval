"""`cancel` (helper-api §Cancel; data-model §Call Outcome): an asynchronous target is cancelled
and its calls in flight are cut as `unanswered` and unclassified; a synchronous target runs to
its end, its calls recorded as they ended, and the response and `shutdown` wait for it. Later
captured requests of the trial fail before they are sent and are reported nowhere, and
background work that hit a blocked request is logged as L3. Fixture rows: S-RESP-11, S-COST-09."""

from __future__ import annotations

import importlib
import inspect
import time
from collections.abc import Callable

from protocol_client import (
    AdapterProcess,
    MockApi,
    ScenarioCase,
    assert_expect,
    fill_message,
    load_messages,
    run_case,
    wait_to_cancel,
)
from service_runs import SDK_OF_API, case_of, generate, initialize, started

SCENARIOS = "cancel.json"


def test_003_FR_023_cancel(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def cancel_after_first_request(adapter: AdapterProcess, mock: MockApi, request_id: int) -> None:
    wait_to_cancel({"afterRequests": 1}, mock)
    adapter.notify("cancel", {"id": request_id})


def wait_until(condition: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.05)


def test_003_FR_023_an_asynchronous_target_is_cancelled(mock_api: MockApi) -> None:
    steps = [{"call": {}}, {"print": "the asynchronous target went on after the cut"}]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [{"delayMs": 5000, "reply": {"text": "Too late."}}],
        },
        backend="async",
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        cancel_after_first_request(adapter, mock_api, request_id)
        cancelled = time.monotonic()
        response = adapter.wait(request_id)
        answered_after = time.monotonic() - cancelled
        time.sleep(0.5)
        stderr = "".join(adapter.exchange.stderr)
    assert response["id"] == request_id
    assert answered_after < 2.0
    assert "went on after the cut" not in stderr


SYNC_STEPS = [
    {"call": {}},
    {"call": {"user": "A request after the cancel."}, "swallow": True},
    {"sleep": 500},
    {"print": "the synchronous target reached its end"},
]


def sync_case() -> ScenarioCase:
    return case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": SYNC_STEPS}},
            "script": [
                {
                    "delayMs": 1000,
                    "reply": {"text": "In flight.", "usage": {"input": 12, "output": 6}},
                },
                {"reply": {"text": "Never sent."}},
            ],
        },
        backend="sync",
    )


def test_003_FR_023_a_synchronous_target_runs_to_its_end_before_the_response(
    mock_api: MockApi,
) -> None:
    case = sync_case()
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        cancel_after_first_request(adapter, mock_api, request_id)
        cancelled = time.monotonic()
        response = adapter.wait(request_id)
        answered_after = time.monotonic() - cancelled
        wait_until(lambda: "reached its end" in "".join(adapter.exchange.stderr))
        stderr = "".join(adapter.exchange.stderr)
        requests = mock_api.log()
    # The response waits for the request in flight (about 1 s) and the 0.5 s sleep after it.
    assert answered_after >= 1.2
    assert "the synchronous target reached its end" in stderr
    # The request in flight completed and is recorded as it ended; the later one was never sent.
    calls = response["result"]["calls"]
    assert [(call["outcome"], call.get("usage")) for call in calls] == [
        ("ok", {"input": 12, "output": 6})
    ]
    assert "errorKind" not in calls[0]
    assert len(requests) == 1


def test_003_FR_023_shutdown_waits_for_a_cancelled_synchronous_target(mock_api: MockApi) -> None:
    case = sync_case()
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        cancel_after_first_request(adapter, mock_api, request_id)
        assert adapter.request("shutdown")["result"] is None
        # stdout is read in order, so the generate response was written before shutdown's.
        response = adapter.wait(request_id, timeout=0)
        stderr = "".join(adapter.exchange.stderr)
    assert response["result"]["calls"][0]["outcome"] == "ok"
    assert "the synchronous target reached its end" in stderr


def blocked_request_error(api: str) -> str:
    """The `<exception>` of the SDK's error for a request that never arrived: its class name and
    the SDK's own default message."""
    error_class = importlib.import_module(SDK_OF_API[api]).APIConnectionError
    message = inspect.signature(error_class.__init__).parameters["message"].default
    return f"{error_class.__name__}: {message}".strip()


def test_003_FR_023_background_work_hitting_a_blocked_request_logs_l3(mock_api: MockApi) -> None:
    steps = [{"background": {"user": "Remember this."}, "delay": 300}, {"call": {}}]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [{"delayMs": 5000, "reply": {"text": "Too late."}}],
        },
        backend="async",
    )
    sentence = fill_message(
        load_messages()["L3"]["text"], {"exception": blocked_request_error(case.api)}
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        cancel_after_first_request(adapter, mock_api, request_id)
        adapter.wait(request_id)
        wait_until(lambda: any(log["message"] == sentence for log in adapter.exchange.logs))
        adapter.request("shutdown")
    warnings = [log["message"] for log in adapter.exchange.logs if log.get("level") == "warn"]
    assert warnings == [sentence]
    assert len(mock_api.log()) == 1
    assert adapter.exchange.calls == []


def test_003_FR_023_cancel_while_waiting_for_unfinished_calls_blocks_later_requests(
    mock_api: MockApi,
) -> None:
    # The function has returned and the helper waits for a slow background call when the tool
    # cancels. The cancel cuts that call, so its background work gets an exception instead of the
    # mock server's answer (6 s), and a request the context makes afterwards is not sent and not
    # reported. Both are logged as L3 (helper-api §Cancel: a request cut on `cancel` or blocked
    # after it), none as L2.
    steps = [
        {"call": {}},
        {"background": {"user": "Slow note."}},
        {"background": {"user": "Late note."}, "delay": 4500},
        {"sleep": 200},
    ]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [
                {"match": {"bodyIncludes": "Slow note"}, "delayMs": 6000, "reply": {"text": "Ok."}},
                {"match": {"bodyIncludes": "Late note"}, "reply": {"text": "Never sent."}},
                {"reply": {"text": "Hello."}},
            ],
        },
        backend="async",
    )
    sentence = fill_message(
        load_messages()["L3"]["text"], {"exception": blocked_request_error(case.api)}
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        wait_to_cancel({"afterRequests": 2}, mock_api)
        # The function returns 0.2 s after starting, so 2 s later the trial is waiting for the
        # slow call (6 s), and the late request (4.5 s) has not started yet.
        time.sleep(2.2)
        adapter.notify("cancel", {"id": request_id})
        response = adapter.wait(request_id)
        # Two L3 lines: the cut slow call and the blocked late request. A slow call left running
        # would end with the mock server's answer and log nothing.
        wait_until(lambda: len(l3_lines(adapter)) >= 2, 10)
        adapter.request("shutdown")
    # helper-api §Cancel: an asynchronous trial's response goes out right away as a failure
    # result with its calls, the slow call cut as `unanswered`.
    assert response["result"]["error"] == {
        "kind": "timeout",
        "message": "The tool cancelled the trial.",
    }
    outcomes = [call["outcome"] for call in response["result"]["calls"]]
    assert outcomes == ["ok", "unanswered"]
    assert "errorKind" not in response["result"]["calls"][1]
    assert len(mock_api.log()) == 2
    assert adapter.exchange.calls == []
    warnings = [log["message"] for log in adapter.exchange.logs if log.get("level") == "warn"]
    assert len(l3_lines(adapter)) == 2
    assert sentence in warnings
    l2 = load_messages()["L2"]["text"].split("<exception>")[0]
    assert [warning for warning in warnings if warning.startswith(l2)] == []


def l3_lines(adapter: AdapterProcess) -> list[str]:
    """The adapter's L3 log warnings, whatever their exception."""
    l3 = load_messages()["L3"]["text"].split("<exception>")[0]
    return [log["message"] for log in adapter.exchange.logs if log["message"].startswith(l3)]


def test_003_FR_023_a_sync_target_awaiting_its_returned_coroutine_is_cancelled_as_async(
    mock_api: MockApi,
) -> None:
    # helper-api §Cancel: a synchronous function that returned an awaitable counts as
    # asynchronous from then on, so the call its coroutine has in flight is cut at once.
    case = case_of(
        {
            "service": {"behaviour": "returns", "params": {"steps": [], "value": "coroutine"}},
            "script": [{"delayMs": 5000, "reply": {"text": "Too late."}}],
        },
        backend="sync",
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case)
        cancel_after_first_request(adapter, mock_api, request_id)
        cancelled = time.monotonic()
        response = adapter.wait(request_id)
        answered_after = time.monotonic() - cancelled
    assert answered_after < 2.0
    assert response["result"]["error"]["kind"] == "timeout"
    calls = response["result"]["calls"]
    assert [(call["outcome"], call.get("errorKind")) for call in calls] == [("unanswered", None)]


def test_003_FR_023_a_cancelled_trial_with_a_raising_reply_call_still_reports_config(
    mock_api: MockApi,
) -> None:
    # Outcome row 1 is decided from the calls without reply_call, so a captured 401 makes the
    # cancel result `config` even though reply_call raises.
    case = case_of(
        {
            "service": {"behaviour": "reply"},
            "script": [
                {"status": 401, "error": {"message": "invalid key"}},
                {"delayMs": 5000, "reply": {"text": "Too late."}},
            ],
        },
        backend="async",
    )
    with started(case, mock_api, service="raising_targets") as adapter:
        initialize(adapter, case)
        request_id = generate(adapter, case, target="reply-call-cancelled")
        wait_to_cancel({"afterRequests": 2}, mock_api)
        adapter.notify("cancel", {"id": request_id})
        result = adapter.wait(request_id)["result"]
    assert result["error"]["kind"] == "config"
    calls = [(call["outcome"], call.get("errorKind")) for call in result["calls"]]
    assert calls == [("failed", "config"), ("unanswered", None)]


def test_003_FR_023_only_an_integer_id_names_the_trial_to_cancel(mock_api: MockApi) -> None:
    """`true` and `"1"` cancel nothing, and 1.0 names the trial 1 (helper-api §Shared
    Conventions). No `initialize`, so the first trial has the request id 1, which `true`
    equals in Python."""
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": [{"call": {}}]}},
            "script": [
                {"delayMs": 1000, "reply": {"text": "Kept."}},
                {"delayMs": 1000, "reply": {"text": "Kept."}},
            ],
        },
        backend="async",
    )
    cancelled_error = {"kind": "timeout", "message": load_messages()["F2"]["text"]}
    with started(case, mock_api) as adapter:
        first = generate(adapter, case)
        assert first == 1
        wait_to_cancel({"afterRequests": 1}, mock_api)
        adapter.notify("cancel", {"id": True})
        adapter.notify("cancel", {"id": "1"})
        kept = adapter.wait(first)
        second = generate(adapter, case)
        wait_to_cancel({"afterRequests": 2}, mock_api)
        adapter.notify("cancel", {"id": float(second)})
        cancelled = adapter.wait(second)
    assert kept.get("result", {}).get("error") != cancelled_error
    assert cancelled["result"]["error"] == cancelled_error
