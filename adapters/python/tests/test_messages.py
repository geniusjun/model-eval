"""Messages (helper-api §Messages): every adapter error, trial warning and log warning the helper
emits equals its sentence in test/fixtures/helper/messages.json with the placeholders filled as
§Messages fixes, in English whatever the trial's `lang`; a warning never changes the outcome
(spec FR-020). Fixture rows: test/fixtures/helper/scenarios/messages.json."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest
from conftest import scenario_cases
from protocol_client import (
    MockApi,
    ScenarioCase,
    assert_expect,
    fill_message,
    load_messages,
    run_case,
)
from service_runs import case_of, generate, initialize, started

SCENARIOS = "messages.json"
OUTCOME_FIELDS = ("finalKind", "raw", "answers", "finishReason", "discardReason")


def test_003_FR_020_messages(scenario_case: ScenarioCase, mock_api: MockApi) -> None:
    assert_expect(scenario_case.expect, run_case(scenario_case, mock_api))


def warning_pairs() -> list[tuple[ScenarioCase, ScenarioCase]]:
    """Each fixture case with a warning "attached", and the case of the same row, API and
    backend whose name says the warning's condition is absent."""
    cases = scenario_cases(SCENARIOS)
    pairs = []
    for with_warning in cases:
        if " attached" not in with_warning.name:
            continue
        message = with_warning.name.split(" attached")[0]
        for without in cases:
            if (
                without.scenario == with_warning.scenario
                and without.name.startswith(f"{message} condition absent")
                and (without.api, without.backend) == (with_warning.api, with_warning.backend)
            ):
                pairs.append((with_warning, without))
    return pairs


PAIRS = warning_pairs()


@pytest.mark.parametrize("pair", PAIRS, ids=[f"{a.name} [{a.api} {a.backend}]" for a, _ in PAIRS])
def test_003_FR_020_a_warning_does_not_change_the_outcome(
    pair: tuple[ScenarioCase, ScenarioCase], mock_api: MockApi
) -> None:
    with_warning, without = (run_case(case, mock_api).response for case in pair)
    assert with_warning["result"]["warnings"], with_warning
    assert "warnings" not in without["result"] or without["result"]["warnings"] == []
    assert outcome(with_warning) == outcome(without)


def outcome(response: dict[str, Any]) -> dict[str, Any]:
    result = response.get("result", {})
    return {
        "status": "adapter-error" if "error" in response else result.get("error", {}).get("kind"),
        **{name: result.get(name) for name in OUTCOME_FIELDS},
    }


def test_003_FR_020_a10_when_two_trials_are_in_progress(mock_api: MockApi) -> None:
    steps = [{"sleep": 300}, {"thread": {}}, {"sleep": 300}]
    case = case_of(
        {
            "service": {"behaviour": "steps", "params": {"steps": steps}},
            "script": [{"times": 2, "reply": {"text": "Hello."}}],
        }
    )
    expected = load_messages()["A10"]["text"]
    with started(case, mock_api) as adapter:
        initialize(adapter, case)
        ids = [generate(adapter, case, caseId=name, lang="ko") for name in ("one", "two")]
        responses = [adapter.wait(request_id) for request_id in ids]
    assert [response.get("error", {}).get("message") for response in responses] == [
        expected,
        expected,
    ]


def test_003_FR_020_l1_equals_its_sentence(mock_api: MockApi, tmp_path: Path) -> None:
    service = tmp_path / "service"
    service.mkdir()
    (service / "secret.txt").write_text("secret\n")
    git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid"]
    subprocess.run([*git, "init", "-q"], cwd=service, check=True)
    subprocess.run([*git, "add", "-A"], cwd=service, check=True)
    subprocess.run([*git, "commit", "-q", "-m", "service"], cwd=service, check=True)
    (service / "secret.txt").chmod(0)
    case = case_of({"service": {"behaviour": "reply"}})
    try:
        env = {"MODEL_EVAL_SERVICE_DIR": str(service)}
        with started(case, mock_api, service="version_service", extra_env=env) as adapter:
            initialize(adapter, case)
    finally:
        (service / "secret.txt").chmod(0o644)
    warnings = [log["message"] for log in adapter.exchange.logs if log.get("level") == "warn"]
    sentence = fill_message(load_messages()["L1"]["text"], {"reason": "read secret.txt: EACCES"})
    assert warnings == [sentence]
