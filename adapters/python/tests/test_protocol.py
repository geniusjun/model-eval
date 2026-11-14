"""Protocol v1 through the Python helper: `initialize`, concurrent `generate`, the target
function's arguments and `shutdown` (helper-api §Python, §Adapter Options, §Target Options,
§Target Function; 001 adapter-protocol §Transport, §`initialize`, §`shutdown`)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from protocol_client import (
    AdapterProcess,
    JsonObject,
    MockApi,
    ScenarioCase,
    initialize_params,
)
from service_runs import case_of, generate, initialize, ok_result, started

import model_eval_adapter as helper

INPUT_SCHEMA = {"type": "object", "required": ["user"], "properties": {"user": {"type": "string"}}}


def reply_case(backend: str = "async", **data: Any) -> ScenarioCase:
    return case_of({"service": {"behaviour": "reply"}, **data}, backend=backend)


def test_003_FR_001_FR_004_initialize_reports_adapter_helper_and_protocol(
    mock_api: MockApi,
) -> None:
    case = reply_case(
        adapter={"maxConcurrency": 3},
        target={"languages": ["ko", "en", "ja"], "inputSchema": INPUT_SCHEMA},
    )
    with started(case, mock_api) as adapter:
        result = initialize(adapter, case)
    assert result["protocolVersion"] == helper.PROTOCOL_VERSION
    assert result["adapter"] == {
        "name": "scenario-service",
        "version": "0.0.1",
        "helper": {"language": "python", "version": helper.HELPER_VERSION},
    }
    assert result["targets"] == [
        {"name": "chat", "languages": ["ko", "en", "ja"], "inputSchema": INPUT_SCHEMA}
    ]
    capabilities = result["capabilities"]
    assert capabilities["stages"] is True
    assert capabilities["cancel"] is True
    assert capabilities["maxConcurrency"] == 3
    # A capability left out is false, except postprocess, which is true (001 adapter-protocol).
    assert capabilities.get("render", False) is False
    assert capabilities.get("postprocess", True) is True


def test_003_FR_001_initialize_declares_render_and_postprocess_as_set(mock_api: MockApi) -> None:
    case = reply_case(target={"render": True, "postprocess": False})
    with started(case, mock_api) as adapter:
        capabilities = initialize(adapter, case)["capabilities"]
    assert capabilities["render"] is True
    assert capabilities["postprocess"] is False


def test_003_FR_001_initialize_without_max_concurrency_sets_no_limit(mock_api: MockApi) -> None:
    case = reply_case()
    with started(case, mock_api) as adapter:
        capabilities = initialize(adapter, case)["capabilities"]
    assert "maxConcurrency" not in capabilities


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_001_concurrent_generate_requests_are_matched_by_id(
    mock_api: MockApi, backend: str
) -> None:
    case = reply_case(
        backend,
        script=[
            {"match": {"bodyIncludes": "slow"}, "delayMs": 1500, "reply": {"text": "slow answer"}},
            {"match": {"bodyIncludes": "fast"}, "reply": {"text": "fast answer"}},
        ],
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        sent = time.monotonic()
        slow = generate(adapter, case, input={"user": "slow"}, caseId="slow")
        fast = generate(adapter, case, input={"user": "fast"}, caseId="fast")
        fast_result = ok_result(adapter.wait(fast))
        fast_after = time.monotonic() - sent
        slow_result = ok_result(adapter.wait(slow))
    assert fast_result["raw"] == "fast answer"
    assert slow_result["raw"] == "slow answer"
    # The fast trial is answered while the slow one still waits for its response headers.
    assert fast_after < 1.2


def test_003_FR_001_synchronous_targets_run_in_a_worker_thread(mock_api: MockApi) -> None:
    case = case_of(
        {
            "service": {
                "behaviour": "steps",
                "params": {"steps": [{"call": {}}, {"report": "thread"}]},
            },
            "script": [{"reply": {"text": "Hello."}}],
        },
        backend="sync",
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.wait(generate(adapter, case)))
    assert json.loads(result["final"]) == {"mainThread": False}
    assert result["raw"] == "Hello."
    assert [call["model"] for call in result["calls"]] == ["model-b"]


def test_003_FR_001_synchronous_targets_run_concurrently(mock_api: MockApi) -> None:
    case = reply_case(
        "sync", script=[{"times": 2, "delayMs": 1000, "reply": {"text": "late answer"}}]
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        sent = time.monotonic()
        first = generate(adapter, case, caseId="one")
        second = generate(adapter, case, caseId="two")
        results = [ok_result(adapter.wait(first)), ok_result(adapter.wait(second))]
        elapsed = time.monotonic() - sent
    assert [result["raw"] for result in results] == ["late answer", "late answer"]
    assert elapsed < 1.8


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_001_target_receives_case_and_variant_fields(
    mock_api: MockApi, backend: str
) -> None:
    params = {"lang": "ja", "input": {"user": "hi"}, "caseId": "greet-ja", "repeat": 2, "seed": 7}
    reports = {}
    for what in ("case", "variant"):
        case = case_of(
            {
                "service": {
                    "behaviour": "steps",
                    "params": {"steps": [{"call": {}}, {"report": what}]},
                },
                "initialize": {"variant": {"id": "next", "model": "model-b", "params": {"t": 1}}},
                "script": [{"reply": {"text": "Hello."}}],
            },
            backend=backend,
        )
        with started(case, mock_api) as adapter:
            initialize(adapter, case)
            result = ok_result(adapter.wait(generate(adapter, case, **params)))
        reports[what] = json.loads(result["final"])
    assert reports["case"] == {
        "id": "greet-ja",
        "lang": "ja",
        "input": {"user": "hi"},
        "repeat": 2,
        "seed": 7,
        "rendering": False,
    }
    assert reports["variant"] == {"id": "next", "model": "model-b", "params": {"t": 1}}


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_001_third_argument_holds_the_calls_captured_so_far(
    mock_api: MockApi, backend: str
) -> None:
    steps = [
        {"call": {"system": "Be brief.", "user": "first"}},
        {"call": {"user": "second"}},
        {"report": "calls"},
    ]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "target": {"replyCall": {"systemIncludes": "Be brief."}},
            "script": [
                {"reply": {"text": "One.", "finishReason": "stop"}},
                {"reply": {"text": "Two.", "finishReason": "stop"}},
            ],
        },
        backend=backend,
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.wait(generate(adapter, case)))
    calls = json.loads(result["final"])
    finish = {"chat-completions": "stop", "responses": "completed", "messages": "end_turn"}
    assert [call["model"] for call in calls] == ["model-b", "model-b"]
    assert calls[0]["messages"] == [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "first"},
    ]
    assert calls[1]["messages"] == [{"role": "user", "content": "second"}]
    assert [call["tool_names"] for call in calls] == [[], []]
    assert [call["text"] for call in calls] == ["One.", "Two."]
    assert [call["finish_reason"] for call in calls] == [finish[case.api]] * 2
    assert [call["outcome"] for call in calls] == ["ok", "ok"]


def test_003_FR_001_shutdown_answers_null_and_the_process_exits(mock_api: MockApi) -> None:
    case = reply_case()
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        response = adapter.request("shutdown")
        assert response == {"jsonrpc": "2.0", "id": response["id"], "result": None}
        assert_exits(adapter)


CLOSES_STDIN_WHILE_READING = """
import asyncio, sys, threading, time
import model_eval_adapter as helper
server = helper.Server(helper.Adapter("exit-check", "0.0.1"), asyncio.new_event_loop())
threading.Thread(target=server.read_stdin, daemon=True).start()
time.sleep(0.2)
sys.stdin.close()
"""


def test_003_FR_001_stdin_can_be_closed_while_the_stdin_reader_waits() -> None:
    # The interpreter closes sys.stdin at exit. A reader parked in the buffered sys.stdin holds
    # its lock, so that close waits for it and, at exit, ends in "Fatal Python error" and SIGABRT.
    process = subprocess.Popen(
        [sys.executable, "-c", CLOSES_STDIN_WHILE_READING],
        cwd=Path(helper.__file__).parent,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # stdin stays open: only the reader's own wait can hold the close up.
        returncode = process.wait(timeout=5)
        assert process.stderr is not None
        stderr = process.stderr.read().decode("utf-8", "replace")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        for stream in (process.stdin, process.stderr):
            if stream is not None:
                stream.close()
    assert returncode == 0, stderr
    assert "Fatal Python error" not in stderr


def test_003_FR_001_a_non_blocking_stdin_is_waited_on_not_taken_as_closed() -> None:
    # A parent may leave descriptor 0 non-blocking; a read with no data yet then fails with
    # EAGAIN, which is no end of input, so the request written later is still answered.
    read_end, write_end = os.pipe()
    os.set_blocking(read_end, False)
    bare = Path(helper.__file__).parent / "tests" / "services" / "bare_service.py"
    process = subprocess.Popen(
        [sys.executable, str(bare), str(Path(helper.__file__).parent)],
        stdin=read_end,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    os.close(read_end)
    try:
        time.sleep(0.5)
        request = {**initialize_params(case_of({})), "toolPaths": []}
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": request},
            {"jsonrpc": "2.0", "id": 2, "method": "shutdown"},
        ]
        os.write(write_end, "".join(json.dumps(line) + "\n" for line in lines).encode())
        os.close(write_end)
        stdout, stderr = process.communicate(timeout=10)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    responses = [json.loads(line) for line in stdout.decode().splitlines()]
    assert [response.get("id") for response in responses] == [1, 2], stderr.decode()


def assert_exits(adapter: AdapterProcess) -> None:
    if adapter.process.stdin is not None:
        adapter.process.stdin.close()
    # The tool waits 5 seconds after closing stdin (001 adapter-protocol §Transport).
    assert adapter.process.wait(timeout=5) == 0


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_001_the_process_exits_cleanly_after_shutdown_with_stdin_still_open(
    mock_api: MockApi, backend: str
) -> None:
    # The tool closes stdin only after the shutdown response, so the adapter may exit while its
    # stdin reader still waits; that must not abort the interpreter at shutdown.
    case = reply_case(backend, script=[{"reply": {"text": "Hello."}}])
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        ok_result(adapter.wait(generate(adapter, case)))
        assert adapter.request("shutdown")["result"] is None
        code = adapter.process.wait(timeout=5)
        adapter._stderr_reader.join(timeout=5)
        stderr = "".join(adapter.exchange.stderr)
    assert code == 0, stderr
    assert "Fatal Python error" not in stderr


def test_003_FR_001_the_process_exits_after_shutdown_while_a_sync_target_still_runs(
    mock_api: MockApi,
) -> None:
    # shutdown waits for the function up to timeoutMs minus 5 s; after its response the process
    # must exit within the 5 s the tool gives (001 adapter-protocol §Transport), even though the
    # synchronous function still sleeps in its thread.
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": [{"sleep": 20_000}]}},
            "initialize": {"timeoutMs": 6000},
            "script": [],
        },
        backend="sync",
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        generate(adapter, case)
        assert adapter.request("shutdown")["result"] is None
        assert_exits(adapter)


def raising_targets(mock: MockApi, target: str) -> JsonObject:
    """The response of one trial of tests/services/raising_targets.py's `target`."""
    case = case_of({"service": {"behaviour": "reply"}, "script": [{"reply": {"text": "Hi."}}]})
    with started(case, mock, service="raising_targets") as adapter:
        initialize(adapter, case)
        return adapter.wait(generate(adapter, case, target=target))


def test_003_FR_001_a_target_that_raises_cancelled_error_itself_gets_a_response(
    mock_api: MockApi,
) -> None:
    # No tool `cancel` was sent, so it is an undeclared exception (Outcome row 9).
    response = raising_targets(mock_api, "cancelled")
    assert "error" in response, response
    assert response["error"]["message"].startswith("The target function raised CancelledError.")
    assert response["error"]["data"]["capturedRaw"] == "Hi."


def test_003_FR_001_S_RESP_15_capabilities_hold_when_any_target_has_them(
    mock_api: MockApi,
) -> None:
    # One target renders and has no post-processing, the other has neither; the render part of
    # S-RESP-15 is in test_render.py.
    case = reply_case()
    with started(case, mock_api, service="two_targets") as adapter:
        capabilities = initialize(adapter, case)["capabilities"]
    assert capabilities["render"] is True
    assert capabilities["postprocess"] is True


def test_003_FR_001_initialize_answers_the_request_id(mock_api: MockApi) -> None:
    case = reply_case()
    with started(case, mock_api) as adapter:
        request_id = adapter.send("initialize", initialize_params(case))
        response = adapter.wait(request_id)
    assert response["id"] == request_id
    assert response["jsonrpc"] == "2.0"


@pytest.mark.parametrize("backend", ["sync", "async"])
def test_003_FR_001_third_argument_failure_retry_usage_and_tool_fields(
    mock_api: MockApi, backend: str
) -> None:
    api = case_of({"service": {"behaviour": "reply"}}).api
    tool_calls = [{"name": "lookup", "arguments": '{"b": 1, "a": "x"}'}]
    if api != "messages":
        # Anthropic tool input is always a JSON object, so only OpenAI can send text that is not.
        tool_calls.append({"name": "broken", "arguments": "{not json"})
    lookup = {"model": "model-a", "user": "Look it up.", "tools": ["lookup", "broken"]}
    steps = [
        {"call": lookup, "swallow": True},
        {"call": lookup},
        {"call": {}},
        {"report": "calls", "toolArgs": ["lookup", "missing", "broken"]},
    ]
    rate_limit = {"type": "rate_limit_error", "code": "slow_down", "message": "slow down"}
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [
                {"status": 429, "headers": {"retry-after-ms": "1500"}, "error": rate_limit},
                {
                    "reply": {
                        "toolCalls": tool_calls,
                        "usage": {"input": 12, "cachedInput": 3, "output": 6},
                    }
                },
                {"reply": {"text": "Answer."}},
            ],
        },
        api=api,
        backend=backend,
    )
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.wait(generate(adapter, case)))
    failed, with_tools, answer = json.loads(result["final"])

    assert failed["outcome"] == "failed"
    assert failed["error"] == {
        "status": 429,
        "type": "rate_limit_error",
        "code": "slow_down",
        "retry_after_ms": 1500,
    }
    # The same request was sent again in its branch after the failure ended.
    assert failed["retried"] is True
    assert failed["usage"] is None

    assert with_tools["error"] is None
    assert with_tools["retried"] is None
    assert with_tools["usage"] == {"input": 12, "cachedInput": 3, "output": 6}
    ids = [call.pop("id") for call in with_tools["tool_calls"]]
    assert all(isinstance(value, str) and value for value in ids), ids
    if api == "responses":
        # A Responses tool call's ID is its `call_id`, not the output item's `id`.
        assert all(value.startswith("call_") for value in ids), ids
    if api == "messages":
        # Anthropic `input` becomes canonical JSON text.
        assert with_tools["tool_calls"] == [{"name": "lookup", "arguments": '{"a":"x","b":1}'}]
    else:
        assert with_tools["tool_calls"] == tool_calls
    assert with_tools["tool_args"] == {
        "lookup": {"b": 1, "a": "x"},
        "missing": None,
        "broken": None,
    }

    assert answer["outcome"] == "ok"
    assert answer["error"] is None
