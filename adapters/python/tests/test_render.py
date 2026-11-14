"""Render mode (helper-api §Render Mode; User Story 2): the target function runs with
`case.rendering`, every captured request is answered with a non-retried HTTP 400 `render_only`
so none reaches the mock server, and the render result is built from the render target request,
or from an adapter-supplied render function normalised the same way. A case that never reaches
the render target is adapter error A11, which lint reports as `render-failed`."""

from __future__ import annotations

import json
import re

import pytest
from protocol_client import (
    JsonObject,
    MockApi,
    ScenarioCase,
    assert_expect,
    fill_message,
    load_messages,
    run_case,
    status_of,
)
from service_runs import any_api, case_of, initialize, installed_apis, ok_result, started

SCENARIOS = "render.json"
FINGERPRINT = re.compile(r"sha256:[0-9a-f]{64}")


def test_003_FR_021_render_mode(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    outcome = run_case(scenario_case, mock_api)
    assert_expect(scenario_case.expect, outcome)
    if scenario_case.data.get("request") == "render" and status_of(outcome.response) == "ok":
        fingerprint = outcome.response["result"].get("fingerprint")
        assert isinstance(fingerprint, str), "a render result carries its fingerprint"
        assert FINGERPRINT.fullmatch(fingerprint), fingerprint


def test_003_FR_021_render_function_gets_case_and_variant_and_returns_tools(
    mock_api: MockApi,
) -> None:
    """services/render_function.py echoes its arguments into the render result; its target
    function calls no model, so the result can only come from the render function."""
    variant = {"id": "next", "model": "model-b", "params": {"tone": "warm"}}
    case = case_of({"service": {"behaviour": "steps"}, "initialize": {"variant": variant}})
    params = {
        "target": "chat",
        "lang": "en",
        "input": {"user": "Hi."},
        "caseId": "greet-1",
        "repeat": 0,
        "seed": 7,
    }
    with started(case, mock_api, service="render_function") as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.request("render", params))
    echoed = {
        "case": {"id": "greet-1", "input": {"user": "Hi."}, "lang": "en", "repeat": 0, "seed": 7},
        "variant": variant,
    }
    assert result["messages"] == [
        {"role": "system", "content": "Answer the user."},
        {"role": "user", "content": json.dumps(echoed, sort_keys=True, separators=(",", ":"))},
    ]
    assert result["tools"] == [
        {
            "type": "function",
            "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}},
        }
    ]
    assert result["maxOutputTokens"] == 32
    assert FINGERPRINT.fullmatch(str(result.get("fingerprint")))
    assert mock_api.log() == []


def test_003_FR_021_S_RESP_15_the_target_with_render_renders_and_the_other_is_a15(
    mock_api: MockApi,
) -> None:
    """S-RESP-15, render part: in an adapter with a rendering target and one without render mode,
    both capabilities are declared, the first target renders and the second is A15."""
    case = case_of({"service": {"behaviour": "steps"}})
    params = {"lang": "en", "input": {}, "caseId": "greet-1", "repeat": 0, "seed": 7}
    with started(case, mock_api, service="render_function") as adapter:
        capabilities = initialize(adapter, case)["capabilities"]
        rendered = ok_result(adapter.request("render", {**params, "target": "chat"}))
        refused = adapter.request("render", {**params, "target": "plain"})
    assert capabilities["render"] is True
    assert capabilities["postprocess"] is True
    assert FINGERPRINT.fullmatch(str(rendered.get("fingerprint")))
    assert refused.get("error", {}).get("message") == load_messages()["A15"]["text"]
    assert mock_api.log() == []


ADAPTER_ERROR = -32000
RENDER_ERROR = "RenderError: no template for this case"


def render_failures(mock: MockApi, target: str) -> JsonObject:
    """The response to a `render` of one target of tests/services/render_failures.py."""
    case = case_of({"service": {"behaviour": "steps"}})
    params = {"lang": "en", "input": {}, "caseId": "greet-1", "repeat": 0, "seed": 7}
    with started(case, mock, service="render_failures") as adapter:
        initialize(adapter, case)
        return adapter.request("render", {**params, "target": target})


def adapter_error(response: JsonObject) -> tuple[object, object]:
    error = response.get("error", {})
    return error.get("code"), error.get("message")


@pytest.mark.parametrize(
    ("target", "exception"),
    [
        ("raises-sync", RENDER_ERROR),
        ("raises-async", RENDER_ERROR),
        ("cancels-async", "CancelledError"),
    ],
)
def test_003_FR_021_S_RV_22_a_render_function_that_raises_is_a17(
    target: str, exception: str, mock_api: MockApi
) -> None:
    response = render_failures(mock_api, target)
    text = fill_message(load_messages()["A17"]["text"], {"exception": exception})
    assert adapter_error(response) == (ADAPTER_ERROR, text)
    assert mock_api.log() == []


@pytest.mark.parametrize(
    "target",
    [
        "returns-none",
        "returns-string",
        "returns-list",
        "no-messages",
        "messages-string",
        "messages-string-element",
        "empty-messages",
        "message-without-role",
        "tools-dict",
        "max-output-tokens-0",
        "max-output-tokens-string",
        "tools-object",
        "tools-nan",
        "part-object",
        "max-output-tokens-huge",
    ],
)
def test_003_FR_021_S_RV_23_a_render_function_that_returns_no_render_result_is_a18(
    target: str, mock_api: MockApi
) -> None:
    response = render_failures(mock_api, target)
    assert adapter_error(response) == (ADAPTER_ERROR, load_messages()["A18"]["text"])
    assert mock_api.log() == []


def test_003_FR_021_S_RV_23_the_smallest_render_result_renders(mock_api: MockApi) -> None:
    """The boundary of S-RV-23: one message, an empty `tools` list and `maxOutputTokens` 1."""
    result = ok_result(render_failures(mock_api, "smallest"))
    assert result["messages"] == [{"role": "user", "content": "Hello."}]
    assert result.get("maxOutputTokens") == 1
    assert FINGERPRINT.fullmatch(str(result.get("fingerprint")))


def test_003_FR_021_S_RV_23_tools_and_max_output_tokens_none_count_as_not_given(
    mock_api: MockApi,
) -> None:
    result = ok_result(render_failures(mock_api, "none-as-absent"))
    assert result["messages"] == [{"role": "user", "content": "Hello."}]
    assert "tools" not in result
    assert "maxOutputTokens" not in result
    assert FINGERPRINT.fullmatch(str(result.get("fingerprint")))


RENDER_PARAMS = {"lang": "en", "input": {}, "caseId": "greet-1", "repeat": 0, "seed": 7}
BLOCKED = {"shouldRetry": None, "status": 400, "type": "render_only"}


@pytest.mark.parametrize("target", ["sends-sync", "sends-async"])
@pytest.mark.parametrize("api", installed_apis())
def test_003_FR_021_S_RV_24_requests_a_render_function_sends_get_the_render_400(
    api: str, target: str, mock_api: MockApi
) -> None:
    """tests/services/render_requests.py: the render function's requests to the variant model and
    to another model each get the render-mode 400, and the render result is the function's."""
    case = case_of({"service": {"behaviour": "steps"}}, api)
    env = {"MODEL_EVAL_API": api}
    with started(case, mock_api, service="render_requests", extra_env=env) as adapter:
        initialize(adapter, case)
        result = ok_result(adapter.request("render", {**RENDER_PARAMS, "target": target}))
    notes = [{"model": "model-b", **BLOCKED}, {"model": "model-a", **BLOCKED}]
    assert result["messages"] == [
        {"role": "system", "content": "Report."},
        {"role": "user", "content": json.dumps(notes, sort_keys=True, separators=(",", ":"))},
    ]
    assert mock_api.log() == []


def test_003_FR_021_S_RV_24_a_sync_render_function_that_sleeps_does_not_hold_up_a_generate(
    mock_api: MockApi,
) -> None:
    """The render function sleeps 2 s; a `generate` sent right after the render answers while the
    render still runs, so the sleep does not block the helper's loop."""
    api = any_api()
    case = case_of({"service": {"behaviour": "steps"}, "script": [{"reply": {"text": "Hi."}}]}, api)
    params = {**RENDER_PARAMS, "target": "sleeps"}
    env = {"MODEL_EVAL_API": api}
    with started(case, mock_api, service="render_requests", extra_env=env) as adapter:
        initialize(adapter, case)
        render_id = adapter.send("render", params)
        generated = ok_result(adapter.wait(adapter.send("generate", params)))
        with pytest.raises(AssertionError, match="no response to request"):
            adapter.wait(render_id, timeout=0.3)
        rendered = ok_result(adapter.wait(render_id))
    assert generated["raw"] == "Hi."
    assert rendered["messages"] == [{"role": "user", "content": "Hello."}]
