"""Capture: helper-api §Captured Requests and §Reading Response Bodies on helper-scenarios
S-UNC-01, S-UNC-02, S-UNC-03, S-UNC-05, S-UNC-07, S-RESP-01, S-CONN-22 and the Python part of
S-PAR-07: which requests are captured (POST, path suffix, body `model`, behind a changed
`base_url`, every other request untouched), when (SDKs imported after the helper or inside the
service function, `httpx` and `httpx2` never imported by the helper), and how bodies are read
(compressed bodies decoded, a `stream=False` caller getting the whole body)."""

from __future__ import annotations

import json
import subprocess
import sys

from conftest import installed_sdks
from protocol_client import (
    PYTHON_DIR,
    SERVICES_DIR,
    AdapterProcess,
    JsonObject,
    MockApi,
    Outcome,
    ScenarioCase,
    api_env,
    assert_expect,
    environment_requirements,
    initialize_params,
    run_case,
    scenario_env,
    trial_params,
)

from mock_api.server import accepted_encodings

SCENARIOS = "capture.json"

# Behaviours whose process needs preparing before the scenario service starts.
SERVICE_OF_BEHAVIOUR = {
    "sdk-at-import": "capture_import_order",
    "alias-httpx": "capture_alias",
    "streaming-drop": "capture_streaming_drop",
}
# Environments of tests/requirements/ that install the br and zstd decoders of their transport,
# where the default transports advertise both.
WITH_DECODERS = ("openai-2", "anthropic-2")
DEFAULT_TRANSPORT_BACKENDS = ("sync", "async")


def behaviour(case: ScenarioCase) -> str:
    return str(case.data["service"]["behaviour"])


def case_encoding(case: ScenarioCase) -> str | None:
    return next((entry["encoding"] for entry in case.data["script"] if "encoding" in entry), None)


def wrongly_served(case: ScenarioCase, requests: list[JsonObject]) -> list[str]:
    """Requests not served in the case's encoding although their accept-encoding names it, or
    served compressed although it does not."""
    encoding = case_encoding(case)
    wrong = []
    for request in requests:
        accepted = accepted_encodings(request["headers"].get("accept-encoding"))
        wanted = encoding if encoding in accepted else "identity"
        if request["servedEncoding"] != wanted:
            wrong.append(f"{request['path']}: served {request['servedEncoding']}, not {wanted}")
    return wrong


def check_encodings(case: ScenarioCase, requests: list[JsonObject]) -> None:
    assert not wrongly_served(case, requests)
    decoders = environment_requirements(installed_sdks(), {}) in WITH_DECODERS
    if decoders and case.backend in DEFAULT_TRANSPORT_BACKENDS:
        served = {request["servedEncoding"] for request in requests}
        assert served == {case_encoding(case)}, f"the transport did not advertise it: {served}"


def drop_report(case: ScenarioCase, mock: MockApi, with_helper: bool) -> tuple[str, int]:
    """What the S-CONN-22 service received, and how many requests its SDK sent."""
    mock.load(case.data["script"])
    env = {**api_env(mock.url), **scenario_env(case)}
    if not with_helper:
        env.update(MODEL_EVAL_WITHOUT_HELPER="1", PYTHONPATH=str(SERVICES_DIR))
        script = SERVICES_DIR / "capture_streaming_drop.py"
        done = subprocess.run(
            [sys.executable, str(script)], env=env, capture_output=True, text=True
        )
        assert done.returncode == 0, done.stderr
        return str(json.loads(done.stdout)["report"]), len(mock.log())
    adapter = AdapterProcess("capture_streaming_drop", env)
    try:
        assert "result" in adapter.request("initialize", initialize_params(case))
        response = adapter.request("generate", trial_params(case))
        adapter.request("shutdown")
    finally:
        adapter.close()
    assert_expect(case.expect, Outcome(response, adapter.exchange, mock.log()))
    lines = "".join(adapter.exchange.stderr).splitlines()
    reports = [json.loads(line)["report"] for line in lines if line.startswith('{"report"')]
    assert len(reports) == 1, lines
    return str(reports[0]), len(mock.log())


def test_003_FR_005_FR_012_SC_005_requests_are_captured_and_their_bodies_read(
    scenario_case: ScenarioCase, mock_api: MockApi
) -> None:
    if behaviour(scenario_case) == "streaming-drop":
        with_helper = drop_report(scenario_case, mock_api, with_helper=True)
        assert with_helper == drop_report(scenario_case, mock_api, with_helper=False)
        return
    service = SERVICE_OF_BEHAVIOUR.get(behaviour(scenario_case), "scenario")
    outcome = run_case(scenario_case, mock_api, service)
    assert_expect(scenario_case.expect, outcome)
    if scenario_case.scenario == "S-PAR-07":
        check_encodings(scenario_case, outcome.requests)


def test_003_FR_005_the_helper_imports_neither_httpx_nor_httpx2() -> None:
    # The helper points descriptor 1 at stderr on import, so the list is written to stderr.
    code = (
        "import json, sys, model_eval_adapter\n"
        "names = sorted(m for m in sys.modules if m.split('.')[0] in ('httpx', 'httpx2'))\n"
        "sys.stderr.write(json.dumps(names) + '\\n')\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], cwd=PYTHON_DIR, capture_output=True, text=True, check=True
    )
    assert json.loads(done.stderr.strip().splitlines()[-1]) == []
