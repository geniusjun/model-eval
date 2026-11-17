"""Starting the scenario service outside a fixture case, for tests that drive the protocol
themselves (several requests, `cancel` at a chosen moment, a service folder built per test)."""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from protocol_client import (
    SERVICES_DIR,
    AdapterProcess,
    JsonObject,
    MockApi,
    ScenarioCase,
    api_env,
    initialize_params,
    scenario_env,
    trial_params,
)

APIS = ("chat-completions", "responses", "messages")
SDK_OF_API = {"chat-completions": "openai", "responses": "openai", "messages": "anthropic"}


def installed_apis() -> list[str]:
    return [api for api in APIS if importlib.util.find_spec(SDK_OF_API[api]) is not None]


def any_api() -> str:
    """The first API whose SDK this environment has."""
    apis = installed_apis()
    if not apis:
        raise AssertionError("neither openai nor anthropic is installed in this environment")
    return apis[0]


def case_of(data: JsonObject, api: str | None = None, backend: str = "async") -> ScenarioCase:
    """A case that no fixture file holds, for one API and backend."""
    full = {"name": "inline", "expect": {}, **data}
    return ScenarioCase("S-INLINE-00", "inline", full, api or any_api(), backend, "inline")


@contextmanager
def started(
    case: ScenarioCase,
    mock: MockApi,
    service: str | Path = "scenario",
    cwd: Path = SERVICES_DIR,
    extra_env: dict[str, str] | None = None,
) -> Iterator[AdapterProcess]:
    """An adapter process for the case, with the case's script loaded; closed on exit."""
    mock.load(case.data.get("script", []))
    env = {**api_env(mock.url), **scenario_env(case), **(extra_env or {})}
    adapter = AdapterProcess(service, env, cwd=cwd)
    try:
        yield adapter
    finally:
        if adapter.process.poll() is None:
            try:
                adapter.send("shutdown")
            except OSError:
                pass
        adapter.close()


def initialize(adapter: AdapterProcess, case: ScenarioCase) -> JsonObject:
    response = adapter.request("initialize", initialize_params(case))
    assert "result" in response, f"initialize failed: {response}"
    result: JsonObject = response["result"]
    return result


def generate(adapter: AdapterProcess, case: ScenarioCase, **params: Any) -> int:
    return adapter.send("generate", {**trial_params(case), **params})


def ok_result(response: JsonObject) -> JsonObject:
    assert "result" in response, f"expected a result, got {response}"
    result: JsonObject = response["result"]
    if "error" in result:
        pytest.fail(f"expected an answer result, got {result}")
    return result
