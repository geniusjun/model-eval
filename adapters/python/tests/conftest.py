"""pytest setup for the Python helper tests: the mock API server, and the scenario cases of
test/fixtures/helper/scenarios/ for the SDK environment the tests run in.

A test that takes the `scenario_case` argument runs once per case of the fixture file its module
names in `SCENARIOS`, for every API and backend the case applies to and the environment has.
`MODEL_EVAL_REQUIREMENTS` names the file of tests/requirements/ (without `.txt`) the environment
was built from; without it the file is inferred from the installed SDK versions.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
from collections.abc import Iterator

import pytest
from protocol_client import (
    HELPER_FIXTURES,
    MockApi,
    ScenarioCase,
    api_env,
    environment_requirements,
    select_cases,
)

from mock_api.server import MockServer

SCENARIOS_DIR = HELPER_FIXTURES / "scenarios"


def installed_sdks() -> dict[str, str]:
    """The SDKs of this environment and their versions."""
    versions = {}
    for name in ("openai", "anthropic"):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    return versions


def scenario_cases(file_name: str) -> list[ScenarioCase]:
    """The Python cases of one fixture file that this environment runs."""
    installed = installed_sdks()
    with open(SCENARIOS_DIR / file_name, encoding="utf-8") as file:
        fixture = json.load(file)
    return select_cases(fixture, installed, environment_requirements(installed, os.environ))


def case_id(case: ScenarioCase) -> str:
    return f"{case.scenario} {case.name} [{case.sdk} {case.api} {case.backend}]"


def pytest_generate_tests(metafunc: pytest.Metafunc) -> None:
    if "scenario_case" in metafunc.fixturenames:
        file_name = getattr(metafunc.module, "SCENARIOS", None)
        if not isinstance(file_name, str):
            module = metafunc.module.__name__
            raise pytest.UsageError(f"{module} takes scenario_case but names no SCENARIOS file")
        cases = scenario_cases(file_name)
        metafunc.parametrize("scenario_case", cases, ids=[case_id(case) for case in cases])


@pytest.fixture(scope="session", autouse=True)
def mock_server() -> Iterator[MockApi]:
    """One mock server for the session, with this process's environment set as an adapter's
    (`api_env`), so no adapter the tests start can reach a real model API."""
    server = MockServer().start()
    wanted = api_env(server.url)
    with pytest.MonkeyPatch.context() as patch:
        for name in set(os.environ) - set(wanted):
            patch.delenv(name)
        for name, value in wanted.items():
            patch.setenv(name, value)
        yield MockApi(server.url)
    server.stop()


@pytest.fixture
def mock_api(mock_server: MockApi) -> MockApi:
    """The mock server with no script and an empty request log."""
    mock_server.reset()
    return mock_server
