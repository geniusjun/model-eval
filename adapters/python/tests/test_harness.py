"""The harness itself: which scenario cases an SDK environment runs, and the environment an
adapter process gets."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import pytest
from protocol_client import (
    AdapterProcess,
    Exchange,
    MockApi,
    Outcome,
    ProtocolViolation,
    ScenarioCase,
    api_env,
    assert_expect,
    check_expect,
    environment_requirements,
    require_loopback,
    run_case,
    same,
    select_cases,
)

BOTH_TRANSPORTS = {"openai": "2.54.0", "anthropic": "1.17.0"}
ANTHROPIC_1 = {"anthropic": "1.17.0"}
OPENAI_2 = {"openai": "2.54.0"}


def case(**fields: Any) -> dict[str, Any]:
    return {"name": "a case", "service": {"behaviour": "reply"}, "expect": {}, **fields}


def apis_run(data: dict[str, Any], installed: dict[str, str], requirements: str) -> list[str]:
    cases = select_cases({"S-RESP-01": [data]}, installed, requirements)
    return sorted({scenario_case.api for scenario_case in cases})


def test_003_SC_002_a_case_without_sdks_runs_every_installed_api_and_backend() -> None:
    cases = select_cases({"S-RESP-01": [case()]}, BOTH_TRANSPORTS, None)
    assert len(cases) == 9
    assert {(c.api, c.backend) for c in cases} == {
        (api, backend)
        for api in ("chat-completions", "responses", "messages")
        for backend in ("sync", "async", "aiohttp")
    }


def test_003_SC_002_an_sdks_entry_counts_only_for_the_apis_its_sdk_serves() -> None:
    both = case(sdks=["anthropic-1", "openai-2"])
    assert apis_run(both, OPENAI_2, "openai-2") == ["chat-completions", "responses"]
    assert apis_run(both, ANTHROPIC_1, "anthropic-1") == ["messages"]
    # Both SDKs installed, but the environment is named as openai-2: openai-2 serves no Messages.
    only_openai = case(sdks=["openai-2"])
    assert apis_run(only_openai, BOTH_TRANSPORTS, "openai-2") == ["chat-completions", "responses"]


def test_003_SC_002_the_both_transports_environment_runs_only_cases_naming_it() -> None:
    assert apis_run(case(), BOTH_TRANSPORTS, "both-transports") == []
    assert apis_run(case(sdks=["anthropic-1"]), BOTH_TRANSPORTS, "both-transports") == []
    assert apis_run(case(sdks=["openai-2"]), BOTH_TRANSPORTS, "both-transports") == []
    assert apis_run(case(sdks=["both-transports"]), BOTH_TRANSPORTS, "both-transports") == [
        "chat-completions",
        "messages",
        "responses",
    ]


def test_003_SC_002_api_backend_and_language_filters_apply() -> None:
    data = case(apis=["responses"], backends=["aiohttp"])
    cases = select_cases({"S-RESP-01": [data]}, OPENAI_2, "openai-2")
    assert [(c.api, c.backend) for c in cases] == [("responses", "aiohttp")]
    assert select_cases({"S-RESP-01": [case(languages=["typescript"])]}, OPENAI_2, "openai-2") == []


def test_003_SC_002_an_unknown_requirements_file_is_an_error() -> None:
    with pytest.raises(ValueError):
        select_cases({"S-RESP-01": [case(sdks=["openai-9"])]}, OPENAI_2, "openai-2")
    with pytest.raises(ValueError):
        environment_requirements(OPENAI_2, {"MODEL_EVAL_REQUIREMENTS": "openai-9"})


def test_003_SC_002_the_environment_file_comes_from_its_variable_else_from_the_pins() -> None:
    named = {"MODEL_EVAL_REQUIREMENTS": "openai-2"}
    assert environment_requirements(BOTH_TRANSPORTS, named) == "openai-2"
    assert environment_requirements(BOTH_TRANSPORTS, {}) == "both-transports"
    assert environment_requirements({"openai": "3.0.0"}, {}) == "openai-3.0.0"
    assert environment_requirements({"openai": "0.1.0"}, {}) is None


def test_003_SC_002_an_adapter_gets_no_proxy_and_no_real_credentials() -> None:
    parent = {
        "PATH": "/usr/bin",
        "HTTP_PROXY": "http://proxy.invalid:3128",
        "https_proxy": "http://proxy.invalid:3128",
        "ALL_PROXY": "socks5://proxy.invalid:1080",
        "NO_PROXY": "internal.invalid",
        "ANTHROPIC_AUTH_TOKEN": "real-token",
        "OPENAI_ORG_ID": "org-real",
        "OPENAI_PROJECT_ID": "proj-real",
        "OPENAI_API_KEY": "real-key",
        "OPENAI_BASE_URL": "https://api.example.invalid/v1",
    }
    env = api_env("http://127.0.0.1:9", parent)
    assert env == {
        "PATH": "/usr/bin",
        "NO_PROXY": "*",
        "no_proxy": "*",
        "OPENAI_API_KEY": "test-openai-key",
        "ANTHROPIC_API_KEY": "test-anthropic-key",
        "OPENAI_BASE_URL": "http://127.0.0.1:9/v1",
        "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",
    }


def test_003_SC_002_expected_values_compare_as_canonical_json() -> None:
    assert same({"a": 1, "b": [1.0, -0.0]}, {"b": [1, 0], "a": 1.0})
    assert same(2**53 + 1, 9007199254740992.0)
    assert not same(2**53 + 2, 2**53)
    assert not same(True, 1)
    assert not same(None, 0)
    assert not same("1", 1)
    assert not same([1, 2], [2, 1])


@pytest.mark.parametrize(
    "url",
    [
        "http://0.0.0.0:9",
        "https://api.example.invalid",
        "http://127.0.0.1.example.invalid/v1",
        "http://10.0.0.1:9",
        "http://[::2]:9",
        "",
    ],
)
def test_003_SC_002_base_urls_that_leave_the_machine_are_refused(url: str) -> None:
    with pytest.raises(AssertionError, match="must be a loopback address"):
        require_loopback({**api_env("http://127.0.0.1:9", {}), "ANTHROPIC_BASE_URL": url})


@pytest.mark.parametrize(
    "url", ["http://127.0.0.1:9", "http://127.5.6.7:9", "http://[::1]:9", "http://localhost:9"]
)
def test_003_SC_002_loopback_base_urls_are_accepted(url: str) -> None:
    require_loopback(api_env(url, {}))


SERVICE = """
import json, sys
import time
from pathlib import Path
Path(sys.argv[0]).with_suffix(".started").touch()
request = json.loads(sys.stdin.readline())
print("not a protocol message", flush=True)
result = {"jsonrpc": "2.0", "id": request["id"], "result": None}
sys.stdout.write(json.dumps(result) + "\\n")
sys.stdout.flush()
sys.stdin.read()
"""


def temp_service(tmp_path: Path) -> Path:
    service = tmp_path / "noisy_service.py"
    service.write_text(SERVICE, encoding="utf-8")
    return service


def test_003_SC_002_a_non_json_stdout_line_raises_a_protocol_violation(
    tmp_path: Path, mock_server: MockApi
) -> None:
    adapter = AdapterProcess(temp_service(tmp_path), api_env(mock_server.url))
    with pytest.raises(ProtocolViolation, match="not a protocol message"):
        adapter.request("initialize", {}, timeout=10)
    with pytest.raises(ProtocolViolation):
        adapter.close()


def test_003_SC_002_no_adapter_starts_with_a_remote_base_url(tmp_path: Path) -> None:
    service = temp_service(tmp_path)
    env = {**api_env("http://127.0.0.1:9", {}), "OPENAI_BASE_URL": "https://api.example.invalid"}
    with pytest.raises(AssertionError, match="OPENAI_BASE_URL must be a loopback address"):
        AdapterProcess(service, env)
    assert not service.with_suffix(".started").exists()


def test_003_SC_002_an_adapter_that_exits_at_import_fails_fast_with_its_stderr(
    tmp_path: Path, mock_server: MockApi
) -> None:
    service = tmp_path / "crashing_service.py"
    service.write_text("raise ImportError('the helper API is missing')\n", encoding="utf-8")
    adapter = AdapterProcess(service, api_env(mock_server.url))
    started = time.monotonic()
    with pytest.raises(AssertionError, match="the adapter exited with 1") as failure:
        adapter.request("initialize", {}, timeout=30)
    assert time.monotonic() - started < 5
    assert "ImportError: the helper API is missing" in str(failure.value)
    adapter.close()


def test_003_SC_002_a_response_written_just_before_exit_is_still_delivered(
    tmp_path: Path, mock_server: MockApi
) -> None:
    service = tmp_path / "answer_then_exit.py"
    service.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': None}))\n"
        "sys.stdout.write('\\n')\n",
        encoding="utf-8",
    )
    adapter = AdapterProcess(service, api_env(mock_server.url))
    request_id = adapter.send("initialize", {})
    adapter.process.wait(timeout=10)
    assert adapter.wait(request_id, timeout=10)["result"] is None
    adapter.close()


def trials_case(**params: Any) -> ScenarioCase:
    data: dict[str, Any] = {
        "name": "three trials at once",
        "service": {"behaviour": "harness-trials", "params": {"trials": 3, **params}},
        "trials": 3,
        "expect": {"status": "ok", "raw": "together"},
    }
    return ScenarioCase("S-RESP-10", data["name"], data, "chat-completions", "async", "inline")


def test_003_SC_002_trials_are_all_sent_before_any_response_is_awaited(mock_api: MockApi) -> None:
    case = trials_case()
    outcome = run_case(case, mock_api, "harness_trials")
    assert [response["result"]["final"] for response in outcome.trial_responses()] == [
        "case-1",
        "case-2",
        "case-3",
    ]
    assert_expect(case.expect, outcome)


def test_003_SC_002_every_trial_is_held_to_expect_and_one_mismatch_fails(mock_api: MockApi) -> None:
    case = trials_case(raw={"case-2": "different"})
    outcome = run_case(case, mock_api, "harness_trials")
    with pytest.raises(AssertionError) as failure:
        assert_expect(case.expect, outcome)
    assert str(failure.value) == 'trial 2: raw: expected "together", got "different"'


def in_a_row_case(*raws: str) -> ScenarioCase:
    data: dict[str, Any] = {
        "name": "three trials in a row",
        "service": {"behaviour": "harness-trials", "params": {"delayMs": 200}},
        "trialsInARow": 3,
        "expectPerTrial": [{"status": "ok", "raw": raw} for raw in raws],
    }
    return ScenarioCase("S-CTX-02", data["name"], data, "chat-completions", "async", "inline")


def test_003_SC_002_trials_in_a_row_are_sent_one_after_another(mock_api: MockApi) -> None:
    case = in_a_row_case("answered-before-0", "answered-before-1", "answered-before-2")
    outcome = run_case(case, mock_api, "harness_trials")
    assert [response["result"]["final"] for response in outcome.trial_responses()] == [
        "case-1",
        "case-2",
        "case-3",
    ]
    assert_expect(case.expect, outcome)


def test_003_SC_002_a_wrong_first_trial_fails_a_case_with_one_expect_per_trial(
    mock_api: MockApi,
) -> None:
    case = in_a_row_case("answered-before-5", "answered-before-1", "answered-before-2")
    outcome = run_case(case, mock_api, "harness_trials")
    with pytest.raises(AssertionError) as failure:
        assert_expect(case.expect, outcome)
    assert str(failure.value) == (
        'trial 1: raw: expected "answered-before-5", got "answered-before-0"'
    )


def background_case(**data: Any) -> ScenarioCase:
    full = {
        "name": "a request 300 ms after the result",
        "service": {"behaviour": "harness-trials", "params": {"requestAfterMs": 300}},
        "script": [{"match": {"path": "/background"}, "body": {}}],
        "expect": {"status": "ok"},
        **data,
    }
    return ScenarioCase("S-CTX-22", full["name"], full, "chat-completions", "async", "inline")


def test_003_SC_002_shutdown_waits_for_the_requests_the_case_names(mock_api: MockApi) -> None:
    outcome = run_case(background_case(shutdownAfterRequests=1), mock_api, "harness_trials")
    assert [request["path"] for request in outcome.requests] == ["/v1/background"]


def test_003_SC_002_without_the_wait_shutdown_comes_before_late_background_requests(
    mock_api: MockApi,
) -> None:
    outcome = run_case(background_case(), mock_api, "harness_trials")
    assert outcome.requests == []


def test_003_SC_002_a_null_in_expected_requests_is_the_json_null() -> None:
    received = Outcome({"result": {}}, Exchange(), [{"method": "POST", "model": None}])
    assert check_expect({"requests": [{"model": None}]}, received) == []
    sent_model = Outcome({"result": {}}, Exchange(), [{"method": "POST", "model": "model-b"}])
    assert check_expect({"requests": [{"model": None}]}, sent_model) == [
        'requests[0].model: expected null, got "model-b"'
    ]
