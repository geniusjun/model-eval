"""Render mode (helper-api §Render Mode; User Story 2): the target function runs with
`case.rendering`, every captured request is answered with a non-retried HTTP 400 `render_only`
so none reaches the mock server, and the render result is built from the render target request,
or from an adapter-supplied render function normalised the same way. A case that never reaches
the render target is adapter error A11, which lint reports as `render-failed`."""

from __future__ import annotations

import json
import re

from protocol_client import (
    MockApi,
    ScenarioCase,
    assert_expect,
    load_messages,
    run_case,
    status_of,
)
from service_runs import case_of, initialize, ok_result, started

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
